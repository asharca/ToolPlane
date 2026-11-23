import "server-only";
import { serializeSandboxStep } from "../sandbox-execution-gate";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "../revision-types";
import { resolveAgentModelOverride } from "../turn-model";
import { runtimeModelProxyBase } from "../runtime-access";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { preparePiRuntime } from "../pi-runtime";
import { PI_SDK_VERSION } from "../pi-version";
import {
  AgentMessageQueueError,
  registerAgentMessageQueue,
  type QueueResult,
} from "../execution/message-queue";
import {
  type RunSandboxAgentTurnOptions,
  type SandboxRuntimeActivity,
  type SandboxRuntimeMcpServer,
  resolveSandboxMcpToolOrigin,
  displayValue,
  buildPiModelsConfig,
  sandboxRuntimeStateRoot,
  buildSandboxTranscript,
  waitForSandboxRuntimeInstall,
  PI_SDK_RUNTIME,
} from "../sandbox-runtime";
import {
  redact,
  type DockerExecOptions,
  runTrackedDockerExec,
  PACKAGE_INSTALL_TIMEOUT_MS,
  SANDBOX_NODE_FLAG,
} from "./docker-exec";
import {
  type SandboxTurnPreparation,
  prepareSandboxTurn,
  removeSandboxFiles,
} from "./materialization";

export async function reportContextUsage(
  options: RunSandboxAgentTurnOptions,
  usedTokens: number,
  estimated: boolean,
  breakdown?: ContextUsageSnapshot["breakdown"],
) {
  if (
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0 ||
    !options.onContextUsage
  )
    return;
  await options.onContextUsage({
    usedTokens: Math.round(usedTokens),
    maxTokens: options.contextWindow,
    modelName: options.modelId,
    estimated: estimated || options.contextWindowEstimated === true,
    ...(breakdown ? { breakdown } : {}),
  });
}

export async function reportActivities(
  options: RunSandboxAgentTurnOptions,
  activities: readonly SandboxRuntimeActivity[],
  mcpServers: readonly SandboxRuntimeMcpServer[] = [],
  secrets: readonly string[] = [options.runtimeAccessToken],
) {
  if (!options.onActivity) return;
  for (const activity of activities) {
    const origin =
      activity.type === "tool"
        ? resolveSandboxMcpToolOrigin(activity.toolName, mcpServers)
        : null;
    const enriched = {
      ...activity,
      ...(activity.deploymentId || !origin?.deploymentId
        ? {}
        : { deploymentId: origin.deploymentId }),
      ...(activity.originalToolName || !origin?.originalToolName
        ? {}
        : { originalToolName: origin.originalToolName }),
    };
    await options.onActivity({
      ...enriched,
      ...(enriched.delta ? { delta: redact(enriched.delta, secrets) } : {}),
      ...(enriched.toolName
        ? { toolName: redact(enriched.toolName, secrets) }
        : {}),
      ...(enriched.deploymentId
        ? {
            deploymentId: redact(enriched.deploymentId, secrets),
          }
        : {}),
      ...(enriched.originalToolName
        ? {
            originalToolName: redact(enriched.originalToolName, secrets),
          }
        : {}),
      ...(enriched.patch === undefined
        ? {}
        : (() => {
            const patch = redact(enriched.patch, secrets);
            const bytes = Buffer.from(patch);
            return {
              patch:
                bytes.length > 65_536
                  ? new TextDecoder().decode(bytes.subarray(0, 65_536), {
                      stream: true,
                    })
                  : patch,
              truncated: enriched.truncated === true || bytes.length > 65_536,
            };
          })()),
      ...(enriched.input === undefined
        ? {}
        : {
            input: redact(displayValue(enriched.input), secrets),
          }),
      ...(enriched.output === undefined
        ? {}
        : {
            output: redact(displayValue(enriched.output), secrets),
          }),
    });
  }
}

export async function runNativeSessionExec(
  options: RunSandboxAgentTurnOptions,
  exec: DockerExecOptions,
  workspaceRoot: string,
  sdk: {
    configPath: string;
    packageSetChecksum: string;
    mcpConfig: unknown;
    hostSourceChecksum: string;
    model: unknown;
    advisor?: unknown;
    pluginEnv?: {
      env: Record<string, string>;
      unsetKeys: string[];
      sandboxRedactTokens: string[];
      signature: string;
    };
  },
  preparation: SandboxTurnPreparation,
) {
  if (!options.runtimeSessionId) throw new Error("PI_SDK_SESSION_MISSING");
  const id = randomUUID();
  const temporaryRoot = `${workspaceRoot}/.toolplane/runtime-tmp`;
  const driverPath = `${temporaryRoot}/${id}-session.mjs`;
  const inputPath = `${temporaryRoot}/${id}-session.json`;
  let unregisterQueue: (() => void) | undefined;
  try {
    const brokerSource = await readFile(
      `${process.cwd()}/scripts/native-runtime-session.mjs`,
      "utf8",
    );
    // Live workspace setting, read for every turn; not part of the revision.
    const retrySetting = await db.workspace.findUnique({
      where: { id: options.workspaceId },
      select: { modelRetryAttempts: true },
    });
    const revision = options.agentRevisionId
      ? await db.agentRevision.findFirst({
          where: {
            id: options.agentRevisionId,
            agentId: options.agentId,
            agent: { workspaceId: options.workspaceId },
          },
          select: { config: true },
        })
      : null;
    const routing = revision
      ? AgentRevisionConfigSchema.parse(revision.config)
      : null;
    const descriptor = async (target: {
      providerId: string;
      model: string;
    }) => {
      const selected = await resolveAgentModelOverride(
        options.workspaceId,
        target,
        "pi-sdk",
      );
      const definition = JSON.parse(
        buildPiModelsConfig({
          provider: selected.provider,
          modelId: selected.model,
          modelProxyBase: runtimeModelProxyBase(selected.provider.id),
        }),
      ).providers.toolplane;
      return {
        ...definition.models[0],
        provider: `toolplane-${selected.provider.id}`,
        api: definition.api,
        baseUrl: definition.baseUrl,
        toolplaneProviderId: selected.provider.id,
      };
    };
    const fallbackModels = await Promise.all(
      (routing?.fallbackModels ?? []).map(descriptor),
    );
    const compactionModel = routing?.roleModels?.compaction
      ? await descriptor(routing.roleModels.compaction)
      : undefined;
    const job = {
      runId: id,
      kind: "pi-sdk",
      binary: exec.executable,
      args: exec.args,
      cwd: exec.workdir,
      statePath: `${sandboxRuntimeStateRoot("pi-sdk", options.agentId, workspaceRoot)}/sessions/${options.runtimeSessionId}.json`,
      signature: createHash("sha256")
        .update(
          JSON.stringify({
            binary: exec.executable,
            args: exec.args,
            sdkVersion: PI_SDK_VERSION,
            // Reload resident hosts when the trusted adapter or path contract changes.
            hostProtocol: "session-workspaces-v1",
            hostSourceChecksum: sdk.hostSourceChecksum,
            brokerSourceChecksum: createHash("sha256")
              .update(brokerSource)
              .digest("hex"),
            packageSetChecksum: sdk.packageSetChecksum,
            agentRevisionId: options.agentRevisionId,
            optionalBuiltinTools: options.optionalBuiltinTools ?? [],
            nativeSubagentPolicy: options.nativeSubagentPolicy,
            nativeUi: Boolean(options.nativeUiUrl),
            workdir: exec.workdir,
            system: options.systemPrompt,
            skills: options.skills,
            streamRules: options.streamRules,
            pluginEnvSignature: sdk.pluginEnv?.signature ?? "",
          }),
        )
        .digest("hex"),
      command: options.command,
      navigateBeforeEntryId: options.navigateBeforeEntryId,
      message: buildSandboxTranscript(
        options.messages.slice(-1),
        workspaceRoot !== "/workspace" &&
          (options.conversationId || options.a2aContextId)
          ? options
          : undefined,
      ),
      context: {
        runtimeToken: options.runtimeAccessToken,
        pluginEnv: sdk.pluginEnv?.env ?? {},
        unsetPluginEnvKeys: sdk.pluginEnv?.unsetKeys ?? [],
        redactTokens: sdk.pluginEnv?.sandboxRedactTokens ?? [],
        uiUrl: options.nativeUiUrl,
        toolApprovalBridge: Boolean(
          options.nativeUiUrl?.includes("/agent-runtime/tasks/"),
        ),
        mcpConfig: sdk.mcpConfig,
        model: sdk.model,
        advisor: sdk.advisor,
        fallbackModels,
        roleModels: compactionModel
          ? { compaction: compactionModel }
          : undefined,
        reasoningEffort: options.reasoningEffort,
        modelRetries: retrySetting?.modelRetryAttempts ?? 0,
      },
    };
    preparation.files.push(
      { path: driverPath, content: brokerSource },
      { path: inputPath, content: JSON.stringify(job) },
    );
    // Sessions of one sandbox share the runtime directory. Verify and install
    // one turn at a time: a second concurrent installer finds the runtime
    // complete and exits before reading its artifact (EPIPE).
    const prepared = serializeSandboxStep(
      `runtime:${exec.container}`,
      async () => {
        const ready = await prepareSandboxTurn(
          exec.container,
          workspaceRoot,
          exec.workdir,
          preparation,
          options.signal,
        );
        if (ready) return;
        const artifact = await waitForSandboxRuntimeInstall(
          preparePiRuntime(),
          options.signal,
        );
        if (preparation.runtime.kind !== "pi-sdk")
          throw new Error("PI_SDK_VERSION_MISMATCH");
        await runTrackedDockerExec({
          container: exec.container,
          workdir: "/workspace",
          executable: "node",
          args: [
            preparation.runtime.installerPath,
            JSON.stringify({
              directory: PI_SDK_RUNTIME.directory,
              sha256: artifact.sha256,
            }),
          ],
          stdinFile: artifact.path,
          signal: options.signal,
          timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
        });
      },
    );
    await waitForSandboxRuntimeInstall(prepared, options.signal);
    const queueControl = options.messageQueue;
    if (queueControl) {
      let pending = Promise.resolve();
      const accepted = new Map<string, QueueResult>();
      unregisterQueue = registerAgentMessageQueue({
        ...queueControl,
        send: (message) => {
          const operation = pending.then(async () => {
            await queueControl.authorize();
            const receipt = message ? accepted.get(message.id) : undefined;
            if (receipt) return receipt;
            const output = await runTrackedDockerExec({
              container: exec.container,
              workdir: exec.workdir,
              executable: "node",
              args: [
                SANDBOX_NODE_FLAG,
                "-e",
                `
                const {createConnection} = require('node:net');
                const {createHash} = require('node:crypto');
                const job = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
                const path = '/tmp/toolplane-runtime-' + createHash('sha256').update(job.statePath).digest('hex').slice(0,32) + '.sock';
                const socket = createConnection(path);
                let connected = false;
                socket.on('connect', () => { connected = true; socket.write(JSON.stringify(job) + '\\n'); });
                socket.on('data', chunk => process.stdout.write(chunk));
                socket.on('error', () => {
                  const code = connected ? 'PI_SDK_RUNTIME_FAILED' : 'PI_SDK_QUEUE_NOT_RUNNING';
                  process.stdout.write(JSON.stringify({success:false,error:{code}}) + '\\n');
                });
              `,
              ],
              stdin: JSON.stringify({
                kind: job.kind,
                signature: job.signature,
                statePath: job.statePath,
                cwd: job.cwd,
                runId: id,
                control: message
                  ? {
                      type: message.mode,
                      message: message.text,
                      messageId: message.id,
                      deduplicate: message.deduplicate,
                    }
                  : { type: "clear_queue" },
              }),
              timeoutMs: 15_000,
              maxStdoutBytes: 4 * 1024 * 1024,
              signal: options.signal,
            }).catch(() => {
              throw new AgentMessageQueueError("AGENT_QUEUE_FAILED", 502);
            });
            const response = JSON.parse(output.trim());
            if (!response.success)
              throw new AgentMessageQueueError(
                response.error?.code === "PI_SDK_QUEUE_INVALID"
                  ? "AGENT_QUEUE_INVALID"
                  : response.error?.code === "PI_SDK_QUEUE_FULL"
                    ? "AGENT_QUEUE_FULL"
                    : response.error?.code === "PI_SDK_QUEUE_NOT_RUNNING"
                      ? "AGENT_QUEUE_NOT_RUNNING"
                      : "AGENT_QUEUE_FAILED",
                response.error?.code === "PI_SDK_QUEUE_INVALID"
                  ? 400
                  : response.error?.code === "PI_SDK_QUEUE_FULL"
                    ? 429
                    : response.error?.code === "PI_SDK_QUEUE_NOT_RUNNING"
                      ? 409
                      : 502,
              );
            const result = response.result as QueueResult;
            if (message?.deduplicate) accepted.set(message.id, result);
            else if (!message) accepted.clear();
            return result;
          });
          pending = operation.then(
            () => {},
            () => {},
          );
          return operation;
        },
      });
    }
    return await runTrackedDockerExec({
      ...exec,
      executable: "node",
      args: [SANDBOX_NODE_FLAG, driverPath, inputPath],
      stdin: undefined,
    });
  } finally {
    unregisterQueue?.();
    await removeSandboxFiles(exec.container, [driverPath, inputPath]);
  }
}
