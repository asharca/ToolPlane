import "server-only";
import { StreamRuleTriggerSchema } from "../stream-rules";
import { serializeSandboxStep } from "../sandbox-execution-gate";
import { hasNativeConversationHistory } from "../conversation-context";
import { parseRuntimeFailure, runtimeFailureText } from "../runtime-failure";
import { ContextMaintenanceSchema } from "../context-maintenance";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { modelReasoningSupported } from "../model";
import { AgentRevisionConfigSchema } from "../revision-types";
import { runtimeModelProxyBase } from "../runtime-access";
import { parseContextBreakdown } from "@/lib/context-usage";
import {
  agentRuntimeBuiltinTools,
  normalizeDisabledBuiltinTools,
  agentOptionalBuiltinTool,
  normalizeOptionalBuiltinTools,
} from "../runtime-kind";
import { RuntimeCommandsSchema, parseRuntimeUsage } from "../runtime-commands";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { HOST_ONLY_COMMAND_NAMES } from "../runtime-commands";
import { z } from "zod";
import { prepareLspRuntime } from "../lsp-runtime";
import { observeAgentExecutionStage } from "../execution-stages";
import { PI_SDK_VERSION, PI_SDK_VERSIONS } from "../pi-version";
import type {
  AgentMessageQueue,
  QueuedAgentMessage,
} from "../execution/message-queue";
import { AdvisorSuggestionsSchema, ADVISOR_SUGGESTIONS_PART } from "../advisor";
import { recordEvent } from "@/lib/observability/events";
import {
  type RunSandboxAgentTurnOptions,
  type SandboxRuntimeMcpServer,
  sandboxRuntimeStateRoot,
  waitForSandboxRuntimeInstall,
  httpUrl,
  buildPiModelsConfig,
  PI_SDK_RUNTIME,
  type AgentPromptInvocation,
  TURN_TIMEOUT_MS,
  sandboxAgentHomeEnvironment,
  buildPiMcpConfig,
} from "../sandbox-runtime";
import {
  runTrackedDockerExec,
  PACKAGE_INSTALL_TIMEOUT_MS,
  redact,
  SANDBOX_NODE_FLAG,
} from "./docker-exec";
import {
  piOptionalBuiltinExtensionSources,
  prepareDebugpyArtifact,
} from "./preflight";
import { piMcpExtensionSource } from "./mcp-extension";
import {
  reportContextUsage,
  reportActivities,
  runNativeSessionExec,
} from "./pi-exec";
import { parsePiStreamLine } from "./pi-stream";

import {
  PI_HOST_ENTRY,
  PI_HOST_FILES,
  PI_HOST_PACKAGE_VERIFIER,
} from "./pi-host-files";

export async function runPiSdk(
  options: RunSandboxAgentTurnOptions,
  container: string,
  workdir: string,
  skillRoot: string,
  workspaceRoot: string,
  mcpServers: readonly SandboxRuntimeMcpServer[],
): Promise<string> {
  const runtimeSessionId = options.runtimeSessionId ?? randomUUID();
  options = { ...options, runtimeSessionId };
  const stateRoot = sandboxRuntimeStateRoot(
    "pi-sdk",
    options.agentId,
    workspaceRoot,
  );
  const privateRoot = `${stateRoot}/host`;
  const hostPath = `${privateRoot}/${PI_HOST_ENTRY}`;
  const verifierPath = `${privateRoot}/${PI_HOST_PACKAGE_VERIFIER}`;
  const factoryPath = `${privateRoot}/pi-mcp.mjs`;
  const configPath = `${privateRoot}/${runtimeSessionId}.json`;
  const packages = [...(options.piPackages ?? [])]
    .sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId))
    .map((item) => {
      const manifest = parsePiPackageReleaseManifest(
        item.manifest,
        item.checksum,
      );
      return {
        marketInstallId: item.marketInstallId,
        releaseId: item.releaseId,
        checksum: item.checksum,
        manifest,
        ...(item.mcpBindingsChecksum
          ? { mcpBindingsChecksum: item.mcpBindingsChecksum }
          : {}),
        root: `${stateRoot}/packages/${item.checksum}/snapshot`,
        manifestPath: `${stateRoot}/packages/${item.checksum}/manifest.json`,
      };
    });
  if (
    packages.length > 16 ||
    new Set(packages.map((item) => item.marketInstallId)).size !==
      packages.length
  )
    throw new Error("PI_PACKAGE_UNAVAILABLE");
  const packageSetChecksum = createHash("sha256")
    .update(
      JSON.stringify(
        packages.map(
          ({ marketInstallId, releaseId, checksum, mcpBindingsChecksum }) => ({
            marketInstallId,
            releaseId,
            checksum,
            ...(mcpBindingsChecksum ? { mcpBindingsChecksum } : {}),
          }),
        ),
      ),
    )
    .digest("hex");
  const hostSources = createHash("sha256");
  const hostFiles: { path: string; content: string }[] = [];
  const lspRuntime = options.optionalBuiltinTools?.includes("lsp")
    ? await waitForSandboxRuntimeInstall(prepareLspRuntime(), options.signal)
    : undefined;
  if (lspRuntime) {
    hostSources.update(lspRuntime.sha256).update(lspRuntime.installer);
    await waitForSandboxRuntimeInstall(
      serializeSandboxStep(`lsp:${container}`, async () => {
        const ready = await runTrackedDockerExec({
          container,
          workdir: "/workspace",
          executable: "node",
          args: [
            "--input-type=module",
            "-e",
            `${lspRuntime.installer}\nprocess.stdout.write(await verifyLspArtifact(process.argv[1]) ? 'ready' : 'missing');`,
            lspRuntime.sha256,
          ],
          signal: options.signal,
          timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
        });
        if (ready === "ready") return;
        await runTrackedDockerExec({
          container,
          workdir: "/workspace",
          executable: "node",
          args: [
            "--input-type=module",
            "-e",
            `${lspRuntime.installer}\nawait installLspArtifact(process.argv[1]);`,
            lspRuntime.sha256,
          ],
          stdinFile: lspRuntime.path,
          signal: options.signal,
          timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
        });
      }),
      options.signal,
    ).catch(() => {
      throw new Error("PI_LSP_ARTIFACT_INVALID");
    });
  }
  for (const source of PI_HOST_FILES) {
    const content = await readFile(
      `${process.cwd()}/scripts/${source}`,
      "utf8",
    );
    hostSources.update(source).update(content);
    hostFiles.push({ path: `${privateRoot}/${source}`, content });
  }
  const browserNetwork = options.optionalBuiltinTools?.includes("browser")
    ? ((
        await db.sandbox.findFirst({
          where: { id: options.sandboxId, workspaceId: options.workspaceId },
          select: { network: true },
        })
      )?.network ?? "none")
    : "none";
  hostSources.update(`browser-network:${browserNetwork}`);
  const optionalBuiltinExtensions: string[] = [];
  for (const { name, content } of await piOptionalBuiltinExtensionSources(
    options.optionalBuiltinTools,
  )) {
    // The existing materializer accepts trusted files under stateRoot/host;
    // keep modules there rather than adding arbitrary revision-selected roots.
    const path = `${privateRoot}/optional-${name}.mjs`;
    hostSources.update(name).update(content);
    hostFiles.push({ path, content });
    optionalBuiltinExtensions.push(path);
    if (name === "debug") {
      const artifact = await waitForSandboxRuntimeInstall(
        prepareDebugpyArtifact(),
        options.signal,
      );
      hostSources.update("debugpy-artifact").update(artifact);
      hostFiles.push({
        path: `${privateRoot}/debugpy.artifact.json`,
        content: artifact,
      });
    }
  }
  const factorySource = piMcpExtensionSource({ eventFd: 3, workspaceRoot });
  hostSources.update(factorySource);
  hostFiles.push({ path: factoryPath, content: factorySource });
  if (options.nativeUiUrl) httpUrl(options.nativeUiUrl, "native UI URL");
  const resources = {
    extensions: [] as string[],
    skills: [skillRoot],
    prompts: [] as string[],
    themes: [] as string[],
  };
  for (const item of packages)
    for (const kind of ["extensions", "skills", "prompts", "themes"] as const)
      resources[kind].push(
        ...item.manifest.package.resources[kind].map(
          (path) => `${item.root}/${path}`,
        ),
      );
  const models = JSON.parse(buildPiModelsConfig(options)).providers.toolplane;
  const sessionModel = {
    ...models.models[0],
    ...(options.reasoningEffort && options.reasoningEffort !== "default"
      ? { reasoning: true }
      : {}),
    provider: "toolplane",
    toolplaneProviderId: options.provider.id,
    api: models.api,
    baseUrl: models.baseUrl,
    contextWindow: options.contextWindow,
  };
  let advisor:
    | {
        providerId: string;
        cadence: "each_tool_batch" | "final";
        minSeverity: "info" | "warning" | "critical";
        model: Record<string, unknown>;
      }
    | undefined;
  if (options.agentRevisionId) {
    try {
      const revision = await db.agentRevision.findFirst({
        where: {
          id: options.agentRevisionId,
          agentId: options.agentId,
          agent: { workspaceId: options.workspaceId },
        },
        select: { config: true },
      });
      const selected =
        revision && AgentRevisionConfigSchema.parse(revision.config).advisor;
      if (selected) {
        const provider = await db.modelProvider.findFirst({
          where: {
            id: selected.providerId,
            workspaceId: options.workspaceId,
          },
          include: { modelRecords: { where: { modelId: selected.model } } },
        });
        if (
          !provider?.apiKey.trim() ||
          !provider.models.includes(selected.model)
        )
          throw new Error("ADVISOR_MODEL_UNAVAILABLE");
        const modelConfig = JSON.parse(
          buildPiModelsConfig({
            provider,
            modelId: selected.model,
            modelProxyBase: runtimeModelProxyBase(provider.id),
          }),
        ).providers.toolplane;
        advisor = {
          ...selected,
          model: {
            ...modelConfig.models[0],
            id: selected.model,
            toolplaneProviderId: selected.providerId,
            reasoning: modelReasoningSupported(
              provider,
              selected.model,
              provider.modelRecords[0],
            ),
            provider: "toolplane-advisor",
            api: modelConfig.api,
            baseUrl: modelConfig.baseUrl,
          },
        };
      }
    } catch {
      void recordEvent({
        domain: "agent",
        eventName: "agent.advisor.failed",
        outcome: "error",
        agentId: options.agentId,
        errorCode: "ADVISOR_MODEL_UNAVAILABLE",
      });
    }
  }
  const reportedAdvisories = new Set<string>();
  const reportAdvisor = async (value: unknown) => {
    const parsed = AdvisorSuggestionsSchema.safeParse(value);
    if (
      !advisor ||
      !parsed.success ||
      reportedAdvisories.has(parsed.data.id) ||
      parsed.data.providerId !== advisor.providerId ||
      parsed.data.model !== advisor.model.id ||
      parsed.data.cadence !== advisor.cadence
    )
      return;
    reportedAdvisories.add(parsed.data.id);
    const advisory = {
      ...parsed.data,
      suggestions: parsed.data.suggestions.map((note) => ({
        ...note,
        message: redact(note.message, [options.runtimeAccessToken]),
      })),
    };
    try {
      if (options.conversationId) {
        const conversation = await db.conversation.findFirst({
          where: {
            id: options.conversationId,
            agentId: options.agentId,
            agent: { workspaceId: options.workspaceId },
          },
          select: { id: true },
        });
        if (conversation)
          await db.message.create({
            data: {
              conversationId: conversation.id,
              role: "assistant",
              textCharacters: 0,
              parts: [{ type: ADVISOR_SUGGESTIONS_PART, data: advisory }],
            },
          });
      }
      await options.onAdvisorSuggestions?.(advisory);
    } catch {
      void recordEvent({
        domain: "agent",
        eventName: "agent.advisor.failed",
        outcome: "error",
        agentId: options.agentId,
        errorCode: "ADVISOR_PERSIST_FAILED",
      });
    }
  };
  const excludeTools = normalizeDisabledBuiltinTools(
    "pi-sdk",
    options.disabledBuiltinTools,
  );
  hostFiles.push({
    path: configPath,
    content: JSON.stringify({
      sdkVersion: PI_SDK_VERSION,
      // Sessions saved by these pins resume on sdkVersion and are rewritten as it.
      compatibleSdkVersions: PI_SDK_VERSIONS,
      packageRoot: PI_SDK_RUNTIME.directory,
      lspPackageRoot: lspRuntime?.directory,
      cwd: workdir,
      workspaceRoot,
      sharedDir: "/workspace/shared",
      agentDir: stateRoot,
      sessionsDir: `${stateRoot}/sessions/${runtimeSessionId}`,
      statePath: `${stateRoot}/sessions/${runtimeSessionId}.json`,
      packageSetChecksum,
      agentRevisionId: options.agentRevisionId,
      historyRequired: Boolean(
        options.historyRequired ||
          hasNativeConversationHistory(options.messages),
      ),
      reasoningEffort: options.reasoningEffort,
      streamRules: options.streamRules,
      model: sessionModel,
      systemPrompt: options.systemPrompt?.trim() ?? "",
      contextFiles: options.contextFiles === true,
      excludeTools,
      defaultTools: [
        ...agentRuntimeBuiltinTools("pi-sdk").filter(
          (name) => !excludeTools.includes(name),
        ),
        ...normalizeOptionalBuiltinTools(options.optionalBuiltinTools).filter(
          (name) =>
            agentOptionalBuiltinTool(name)?.implementation ===
            "sandbox-extension",
        ),
      ],
      optionalBuiltinExtensions,
      nativeSubagentPolicy: options.nativeSubagentPolicy,
      browserNetwork,
      resources,
      packages: packages.map(({ manifest: _manifest, ...item }) => item),
      packageVerifierPath: verifierPath,
      mcpFactoryPath: factoryPath,
      hostOnlyCommands: HOST_ONLY_COMMAND_NAMES,
    }),
  });
  let buffer = "",
    text = "",
    streamed = "",
    error = "",
    terminal = false,
    mcpUnavailable: { deploymentId: string; reason: string } | undefined;
  const observeStage = options.onExecutionStage
    ? observeAgentExecutionStage(options.onExecutionStage)
    : undefined;
  const consume = async (line: string) => {
    const event = JSON.parse(line);
    await observeStage?.(event);
    if (event.type === "message_queue") {
      await options.onMessageQueue?.(event.queue as AgentMessageQueue);
      return;
    }
    if (event.type === "queued_message_consumed") {
      await options.onQueuedMessage?.(
        event.message as QueuedAgentMessage,
        redact(String(event.assistantText ?? ""), [options.runtimeAccessToken]),
      );
      streamed = "";
      return;
    }
    if (event.type === "advisor_suggestions") {
      await reportAdvisor(event.advisory);
      return;
    }
    if (event.type === "advisor_error") {
      void recordEvent({
        domain: "agent",
        eventName: "agent.advisor.failed",
        outcome: "error",
        agentId: options.agentId,
        errorCode: `ADVISOR_${
          /^(TIMEOUT|OUTPUT_TRUNCATED|INVALID_OUTPUT|HTTP_[1-5]\d\d|UNREACHABLE|EMPTY_STREAM|STREAM_INCOMPLETE|CONTENT_FILTER|PROVIDER_ERROR)$/.test(
            String(event.reason),
          )
            ? event.reason
            : "PROVIDER_ERROR"
        }`,
        attributes: { durationMs: event.durationMs },
      });
      return;
    }
    if (event.type === "toolplane_mcp_unavailable") {
      const server = mcpServers.find(
        (item) => item.deploymentId === event.deploymentId,
      );
      if (server)
        mcpUnavailable = {
          deploymentId: server.deploymentId,
          reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(String(event.reason))
            ? String(event.reason)
            : "MCP_UNREACHABLE",
        };
      return;
    }
    if (event.type === "model_selected") {
      const selected = z
        .object({
          providerId: z.string().min(1).max(240),
          model: z.string().min(1).max(240),
        })
        .safeParse(event);
      if (selected.success)
        await options.onModelSelected?.({
          providerId: selected.data.providerId,
          model: selected.data.model,
        });
      return;
    }
    if (event.type === "stream_rule_triggered") {
      const trigger = StreamRuleTriggerSchema.safeParse(event.trigger);
      if (trigger.success) await options.onStreamRule?.(trigger.data);
      return;
    }
    if (event.type === "prompt_invocation") {
      await options.onPromptInvocation?.(
        event.invocation as AgentPromptInvocation,
      );
      return;
    }
    if (event.type === "context_maintenance") {
      const marker = ContextMaintenanceSchema.safeParse(event.marker);
      if (marker.success) {
        const safe =
          marker.data.kind === "rewind"
            ? {
                ...marker.data,
                report: redact(marker.data.report, [
                  options.runtimeAccessToken,
                ]),
              }
            : {
                ...marker.data,
                summary: redact(marker.data.summary, [
                  options.runtimeAccessToken,
                ]),
              };
        await options.onContextMaintenance?.(safe);
      }
      return;
    }
    if (event.type === "toolplane_sdk_response") {
      terminal = true;
      const usage = parseRuntimeUsage(event.result?.usage);
      if (usage) await options.onUsage?.(usage);
      const entries = event.result?.sessionEntries;
      if (
        entries &&
        typeof entries.userEntryId === "string" &&
        (entries.userParentEntryId === null ||
          typeof entries.userParentEntryId === "string") &&
        typeof entries.leafEntryId === "string"
      )
        await options.onSessionEntries?.(entries);
      for (const advisory of event.result?.advisories ?? [])
        await reportAdvisor(advisory);
      if (!event.success) {
        const failure = parseRuntimeFailure(
          `${String(event.error?.code ?? "")}: ${String(event.error?.reason ?? "")}`,
        );
        error = failure ? runtimeFailureText(failure) : "PI_SDK_FAILED";
        return;
      }
      text = redact(String(event.result?.text ?? ""), [
        options.runtimeAccessToken,
      ]);
      const context = event.result?.contextBreakdown;
      const breakdown = parseContextBreakdown(context?.categories);
      if (breakdown && typeof context.usedTokens === "number")
        await reportContextUsage(
          options,
          context.usedTokens,
          context.estimated === true,
          breakdown,
        );
      const commands = RuntimeCommandsSchema.safeParse(event.result?.commands);
      if (commands.success) await options.onCommands?.(commands.data);
      const result = event.result?.commandResult;
      if (
        result &&
        typeof result.command === "string" &&
        typeof result.text === "string" &&
        (result.status === "completed" || result.status === "failed")
      ) {
        await options.onCommandResult?.({
          command: result.command,
          text: redact(result.text, [options.runtimeAccessToken]),
          status: result.status,
        });
        if (result.status === "failed") error = "PI_SDK_COMMAND_FAILED";
      }
      return;
    }
    const parsed = parsePiStreamLine(line);
    if (parsed?.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed?.activities)
      await reportActivities(options, parsed.activities, mcpServers);
    if (parsed?.contextTokens !== undefined)
      await reportContextUsage(options, parsed.contextTokens, false);
    if (parsed?.isError) error = "PI_SDK_FAILED";
  };
  await runNativeSessionExec(
    options,
    {
      container,
      workdir,
      executable: "node",
      args: [SANDBOX_NODE_FLAG, hostPath, configPath],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
      secrets: [options.runtimeAccessToken],
      env: {
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
        ...sandboxAgentHomeEnvironment(),
        PI_CODING_AGENT_DIR: stateRoot,
      },
      onStdout: async (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) await consume(line);
        }
      },
    },
    workspaceRoot,
    {
      configPath,
      hostSourceChecksum: hostSources.digest("hex"),
      packageSetChecksum,
      mcpConfig: JSON.parse(buildPiMcpConfig(mcpServers)),
      model: sessionModel,
      advisor,
    },
    {
      files: hostFiles,
      skillRoot,
      skills: options.skills ?? [],
      packages,
      verifierPath,
      runtime: {
        kind: "pi-sdk",
        directory: PI_SDK_RUNTIME.directory,
        installerPath: `${privateRoot}/pi-sdk-install.mjs`,
      },
    },
  );
  if (buffer.trim()) await consume(buffer.trim());
  if (!terminal) throw new Error("PI_SDK_PROTOCOL_ERROR");
  if (error && mcpUnavailable) {
    const deployment = await db.deployment.findFirst({
      where: {
        id: mcpUnavailable.deploymentId,
        workspaceId: options.workspaceId,
      },
      select: { name: true },
    });
    // `CODE: REASON name` lets the console explain which server failed and why.
    throw new Error(
      `PI_MCP_TOOLS_UNAVAILABLE: ${mcpUnavailable.reason} ${deployment?.name || mcpUnavailable.deploymentId}`,
    );
  }
  if (error) throw new Error(error);
  if (text.startsWith(streamed) && text.length > streamed.length)
    await options.onTextDelta?.(text.slice(streamed.length));
  return text;
}
