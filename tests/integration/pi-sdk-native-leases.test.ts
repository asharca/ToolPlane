// @vitest-environment node
import { assertDefined } from "../assert-defined";
import type { ChildProcess } from "node:child_process";
import type { A2ATask } from "@prisma/client";
import type * as Worker from "@/lib/agents/execution/worker";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
} from "@/lib/agents/runtime-commands";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { TaskState } from "@a2a-js/sdk";
import { expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { submitAgentEntry } from "@/lib/agents/execution/entries";
import { claimTask, finishTask } from "@/lib/a2a/store";
import { handleRuntimeUi } from "@/lib/agents/execution/ui-http";
import { createAgentRuntimeToken } from "@/lib/agents/runtime-access";
import { httpFixture } from "../fixtures/pi-agent-communication";
import { executeRuntimeCommand } from "@/lib/agents/runtime-command-service";
import { RUNTIME_COMMANDS_PART } from "@/lib/agents/runtime-commands";
import { textArtifact } from "@/lib/a2a/model";
import { mapTaskSandbox, taskSandbox } from "./task-sandbox-fixture";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import { AGENT_TURN_MODEL_PART } from "@/lib/agents/turn-model";
import type { AgentModelOverride } from "@/lib/agents/chat-body";

const scheduler = vi.hoisted(() => ({ wake: () => {} }));
vi.mock("@/lib/agents/execution/worker", async (original) => ({
  ...(await original<typeof Worker>()),
  wakeAgentWorker: () => scheduler.wake(),
}));
type HostResponse = {
  success: boolean;
  result?: {
    text: string;
    commands: RuntimeCommand[];
    commandResult?: RuntimeCommandResult;
  };
};

it("refreshes real native task UI projection on the same SDK host and rejects the previous lease", async () => {
  const database = new URL(assertDefined(process.env.DATABASE_URL));
  if (
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    !/test|acceptance|disposable/.test(database.pathname)
  )
    throw new Error("Disposable local database required");
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-leases-"));
  let child: ChildProcess | undefined;
  const stamp = randomUUID();
  const user = await db.user.create({
    data: { email: `sdk-lease-${stamp}@test.invalid`, passwordHash: "fixture" },
  });
  const workspace = await db.workspace.create({
    data: { name: "SDK lease test", slug: `sdk-${stamp}`, ownerId: user.id },
  });
  const projectedTasks: string[] = [];
  const platform = await httpFixture(async (request) => {
    const taskId = assertDefined(
      new URL(request.url).pathname.split("/").at(-2),
    );
    const response = await handleRuntimeUi(request, taskId);
    if (response.ok) projectedTasks.push(taskId);
    return response;
  });
  try {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: workspace.id,
        name: "Controlled",
        format: "openai",
        baseUrl: platform.base,
        apiKey: "fixture-only",
        models: ["controlled"],
      },
    });
    const deployment = await db.deployment.create({
      data: { workspaceId: workspace.id, name: "Fixture", source: "config" },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: workspace.id,
        deploymentId: deployment.id,
        name: "Fixture",
        slug: "fixture",
        kind: "docker",
        network: "isolated",
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: "SDK",
        slug: "sdk",
        runtimeKind: "pi-sdk",
        providerId: provider.id,
        model: "controlled",
        a2aInboundEnabled: true,
        a2aOutboundEnabled: true,
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    const revision = await db.agentRevision.create({
      data: {
        agentId: agent.id,
        version: 1,
        config: AgentRevisionConfigSchema.parse({
          schemaVersion: 1,
          runtimeKind: "pi-sdk",
          systemPrompt: null,
          providerId: provider.id,
          model: "controlled",
          modelProviderIds: [],
          maxSteps: agent.maxSteps,
          disabledBuiltinTools: [],
          sandboxTemplateId: sandbox.id,
          environment: {
            kind: "docker",
            image: `fixture@sha256:${"0".repeat(64)}`,
            network: "isolated",
            piVersion: "0.87.1",
            initialSnapshot: null,
            resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 64 },
            credentialReferences: [],
          },
          skills: [],
          knowledgeBaseIds: [],
          packages: [],
          mcpGrants: [],
          a2a: {
            inboundEnabled: true,
            outboundEnabled: true,
            policy: { schemaVersion: 1, targets: [] },
          },
        }),
      },
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { currentRevisionVersion: revision.version },
    });
    const conversation = await db.conversation.create({
      data: {
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const cwd = join(root, "workspace"),
      privateDir = join(root, "private"),
      sessionsDir = join(root, "sessions");
    const home = join(root, "home");
    for (const path of [cwd, privateDir, sessionsDir]) await mkdir(path);
    const extension = join(cwd, "fixture.mjs");
    await writeFile(
      extension,
      `import {writeFileSync,existsSync,readFileSync} from 'node:fs'; export default pi=>pi.registerCommand('Count',{handler:async(_,ctx)=>{const p=ctx.cwd+'/count';const n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(n));writeFileSync(ctx.cwd+'/model',ctx.model.id);pi.sendMessage({customType:'fixture',content:'count='+n,display:true})}});`,
    );
    const mcpFactoryPath = join(privateDir, "mcp.mjs");
    await writeFile(
      mcpFactoryPath,
      "export async function createPiMcpTools(){return []}",
    );
    const configPath = join(privateDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        sdkVersion: "0.87.1",
        packageRoot: resolve("."),
        cwd,
        workspaceRoot: root,
        sharedDir: join(root, "agent-shared"),
        agentDir: privateDir,
        sessionsDir,
        statePath: join(privateDir, "state.json"),
        packageSetChecksum: "empty",
        model: {
          id: "controlled",
          name: "Controlled",
          provider: "toolplane",
          api: "openai-completions",
          baseUrl: platform.base,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        systemPrompt: "Fixture",
        defaultTools: [],
        resources: {
          extensions: [extension],
          skills: [],
          prompts: [],
          themes: [],
        },
        packages: [],
        packageVerifierPath: resolve("scripts/pi-sdk-package-files.mjs"),
        mcpFactoryPath,
        hostOnlyCommands: [],
      }),
    );
    child = spawn(
      process.execPath,
      [resolve("scripts/pi-sdk-session.mjs"), configPath],
      {
        stdio: ["pipe", "ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          NODE_CHANNEL_FD: undefined,
          NODE_CHANNEL_SERIALIZATION_MODE: undefined,
        },
      },
    );
    const pending = new Map<string, (value: HostResponse) => void>();
    const stream = child.stdio[3];
    if (!(stream instanceof Readable)) throw new Error("Missing private fd");
    createInterface({ input: stream }).on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "toolplane_sdk_response")
        pending.get(event.id)?.(event);
    });
    async function task(modelOverride?: AgentModelOverride) {
      const accepted = await submitAgentEntry(
        {
          kind: "chat",
          sourceId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          actorId: user.id,
          messageId: randomUUID(),
          text: "/Count",
          modelOverride,
        },
        () => {},
      );
      const row = await claimTask(accepted.row.id);
      if (!row) throw new Error("Claim failed");
      expect(row.executionBackend).toBe("pi-sdk");
      await mapTaskSandbox(row);
      return row;
    }
    async function request(row: A2ATask) {
      const override = (row.grant as unknown as LocalA2AGrant).modelOverride;
      const runtimeToken = await createAgentRuntimeToken({
        workspaceId: workspace.id,
        agentId: agent.id,
        agentRevisionId: revision.id,
        ...taskSandbox(row),
        providerId: override?.providerId ?? provider.id,
        modelOverride: override,
        deploymentIds: [],
        a2aTaskId: row.id,
        a2aContextId: row.contextId,
        a2aLeaseToken: assertDefined(row.leaseToken),
        exp: Math.floor(Date.now() / 1000) + 300,
      });
      const id = randomUUID();
      const result = new Promise<HostResponse>((done) => pending.set(id, done));
      assertDefined(assertDefined(child).stdin).write(
        `${JSON.stringify({
          id,
          type: "prompt",
          message: "/Count",
          context: {
            runtimeToken,
            uiUrl: `${platform.base}/api/v1/agent-runtime/tasks/${row.id}/ui`,
            mcpConfig: { servers: [] },
            model: {
              ...JSON.parse(await readFile(configPath, "utf8")).model,
              id: override?.model ?? "controlled",
            },
          },
        })}\n`,
      );
      return result;
    }
    await expect(
      task({ providerId: provider.id, model: "not-configured" }),
    ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
    const foreignWorkspace = await db.workspace.create({
      data: { ownerId: user.id, name: "Foreign", slug: `sdk-foreign-${stamp}` },
    });
    try {
      const foreignProvider = await db.modelProvider.create({
        data: {
          workspaceId: foreignWorkspace.id,
          name: "Foreign",
          format: "openai",
          baseUrl: platform.base,
          apiKey: "foreign-private",
          models: ["controlled"],
        },
      });
      await expect(
        task({ providerId: foreignProvider.id, model: "controlled" }),
      ).rejects.toMatchObject({ code: "modelOverrideUnavailable" });
      expect(
        await db.a2ATask.count({
          where: { context: { workspaceId: workspace.id } },
        }),
      ).toBe(0);
    } finally {
      await db.workspace.delete({ where: { id: foreignWorkspace.id } });
    }
    const first = await task();
    expect(await request(first)).toMatchObject({
      success: true,
      result: { text: "Pi 扩展 · fixture\ncount=1" },
    });
    await finishTask(
      first.id,
      assertDefined(first.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      "Done",
    );
    expect(await readFile(join(cwd, "model"), "utf8")).toBe("controlled");
    const alternate = await db.modelProvider.create({
      data: {
        workspaceId: workspace.id,
        name: "Alternate",
        format: "openai",
        baseUrl: platform.base,
        apiKey: "alternate-private",
        models: ["alternate"],
      },
    });
    const awakened = new Promise<void>((done) => {
      scheduler.wake = done;
    });
    const command = executeRuntimeCommand({
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      actorId: user.id,
      line: "/Count",
      modelOverride: { providerId: alternate.id, model: "alternate" },
      signal: AbortSignal.timeout(15000),
    });
    await Promise.race([
      awakened,
      command.then(() => {
        throw new Error("Command completed without task admission");
      }),
    ]);
    const queued = await db.a2ATask.findFirstOrThrow({
      where: {
        contextId: first.contextId,
        state: TaskState.TASK_STATE_SUBMITTED,
      },
    });
    const second = await claimTask(queued.id);
    if (!second) throw new Error("Second claim failed");
    await mapTaskSandbox(second);
    expect(second.contextId).toBe(first.contextId);
    const output = await request(second);
    expect(output).toMatchObject({
      success: true,
      result: { text: "Pi 扩展 · fixture\ncount=2" },
    });
    expect(await readFile(join(cwd, "model"), "utf8")).toBe("alternate");
    expect(new Set(projectedTasks)).toEqual(new Set([first.id, second.id]));
    const staleToken = await createAgentRuntimeToken({
      workspaceId: workspace.id,
      agentId: agent.id,
      agentRevisionId: revision.id,
      ...taskSandbox(first),
      providerId: provider.id,
      deploymentIds: [],
      a2aTaskId: first.id,
      a2aContextId: first.contextId,
      a2aLeaseToken: assertDefined(first.leaseToken),
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(
      (
        await fetch(
          `${platform.base}/api/v1/agent-runtime/tasks/${first.id}/ui`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${staleToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ action: "todos", todos: [] }),
          },
        )
      ).status,
    ).toBe(404);
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("2");
    const artifact = textArtifact(assertDefined(output.result).text);
    artifact.metadata = {
      toolplanePiSdk: {
        model: { providerId: alternate.id, model: "alternate" },
        commands: assertDefined(output.result).commands,
        commandResult: assertDefined(output.result).commandResult,
      },
    };
    await finishTask(
      second.id,
      assertDefined(second.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      "Done",
      artifact,
    );
    expect(await command).toEqual({
      kind: "output",
      text: assertDefined(output.result).text,
    });
    const saved = await db.message.findFirstOrThrow({
      where: { conversationId: conversation.id, role: "assistant" },
    });
    expect(saved.parts).toEqual(
      expect.arrayContaining([
        {
          type: RUNTIME_COMMANDS_PART,
          data: {
            runtimeKind: "pi-sdk",
            commands: assertDefined(output.result).commands,
          },
        },
      ]),
    );
    expect(saved.parts).toEqual(
      expect.arrayContaining([
        {
          type: AGENT_TURN_MODEL_PART,
          data: { providerId: alternate.id, model: "alternate" },
        },
      ]),
    );
    const third = await task();
    expect(
      (third.grant as unknown as LocalA2AGrant).modelOverride,
    ).toBeUndefined();
    expect(await request(third)).toMatchObject({
      success: true,
      result: { text: "Pi 扩展 · fixture\ncount=3" },
    });
    expect(await readFile(join(cwd, "model"), "utf8")).toBe("controlled");
    await finishTask(
      third.id,
      assertDefined(third.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      "Done",
    );
    expect(await db.agentRevision.count({ where: { agentId: agent.id } })).toBe(
      1,
    );
    expect(
      await db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    ).toMatchObject({ config: revision.config });
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
    ).toMatchObject({ providerId: provider.id, model: "controlled" });
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGKILL");
      await stopped;
    }
    await platform.close();
    await db.a2AContext.deleteMany({ where: { workspaceId: workspace.id } });
    await db.conversation.deleteMany({
      where: { agent: { workspaceId: workspace.id } },
    });
    await db.logEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await db.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
