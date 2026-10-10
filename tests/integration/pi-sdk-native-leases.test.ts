// @vitest-environment node
import { assertDefined } from "../assert-defined";
import type { ChildProcess } from "node:child_process";
import type { A2ATask } from "@prisma/client";
import type * as Worker from "@/lib/a2a/worker";
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
import { submitNativeEntry } from "@/lib/a2a/ingress";
import { claimTask, finishTask } from "@/lib/a2a/store";
import { handleRuntimeApprovals } from "@/lib/a2a/approval-http";
import { createAgentRuntimeToken } from "@/lib/agents/runtime-access";
import { nativeApprovalAdapter } from "@/lib/agents/native-tool-approval";
import { httpFixture } from "../fixtures/pi-agent-communication";
import { executeRuntimeCommand } from "@/lib/agents/runtime-command-service";
import { RUNTIME_COMMANDS_PART } from "@/lib/agents/runtime-commands";
import { textArtifact } from "@/lib/a2a/model";

const scheduler = vi.hoisted(() => ({ wake: () => {} }));
vi.mock("@/lib/a2a/worker", async (original) => ({
  ...(await original<typeof Worker>()),
  wakeA2AWorker: () => scheduler.wake(),
}));
type HostResponse = {
  success: boolean;
  result?: {
    text: string;
    commands: RuntimeCommand[];
    commandResult?: RuntimeCommandResult;
  };
};

it("refreshes real native task readiness on the same SDK host and rejects the previous lease", async () => {
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
  const readyTasks: string[] = [];
  const platform = await httpFixture(async (request) => {
    const taskId = assertDefined(
      new URL(request.url).pathname.split("/").at(-2),
    );
    const body = await request.clone().json();
    const response = await handleRuntimeApprovals(request, taskId);
    if (
      body.action === "ready" &&
      response.ok &&
      (await response.clone().json()).status === "ready"
    )
      readyTasks.push(taskId);
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
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    const conversation = await db.conversation.create({
      data: { agentId: agent.id },
    });
    const cwd = join(root, "workspace"),
      privateDir = join(root, "private"),
      sessionsDir = join(root, "sessions");
    for (const path of [cwd, privateDir, sessionsDir]) await mkdir(path);
    const extension = join(cwd, "fixture.mjs"),
      approvalExtensionPath = join(privateDir, "approval.mjs");
    const approvalHelperPath = resolve("scripts/a2a-native-approval.mjs");
    await writeFile(
      extension,
      `import {writeFileSync,existsSync,readFileSync} from 'node:fs'; export default pi=>pi.registerCommand('Count',{handler:async(_,ctx)=>{const p=ctx.cwd+'/count';const n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(n));pi.sendMessage({customType:'fixture',content:'count='+n,display:true})}});`,
    );
    await writeFile(
      approvalExtensionPath,
      nativeApprovalAdapter("pi", approvalHelperPath),
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
        approvalExtensionPath,
        approvalHelperPath,
        hostOnlyCommands: [],
      }),
    );
    child = spawn(
      process.execPath,
      [resolve("scripts/pi-sdk-session.mjs"), configPath],
      {
        stdio: ["pipe", "ignore", "pipe", "pipe"],
        env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
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
    async function task() {
      const accepted = await submitNativeEntry(
        {
          kind: "chat",
          sourceId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          actorId: user.id,
          messageId: randomUUID(),
          text: "/Count",
        },
        () => {},
      );
      const row = await claimTask(accepted.row.id);
      if (!row) throw new Error("Claim failed");
      expect(row.executionBackend).toBe("legacy");
      return row;
    }
    async function request(row: A2ATask) {
      const runtimeToken = await createAgentRuntimeToken({
        workspaceId: workspace.id,
        agentId: agent.id,
        sandboxId: sandbox.id,
        providerId: provider.id,
        deploymentIds: [],
        a2aTaskId: row.id,
        a2aLeaseToken: assertDefined(row.leaseToken),
        a2aApprovalRequired: true,
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
            approvalUrl: `${platform.base}/api/v1/agent-runtime/a2a/${row.id}/approvals`,
            mcpConfig: { servers: [] },
          },
        })}\n`,
      );
      return result;
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
    const awakened = new Promise<void>((done) => {
      scheduler.wake = done;
    });
    const command = executeRuntimeCommand({
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      actorId: user.id,
      line: "/Count",
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
    expect(second.contextId).toBe(first.contextId);
    const output = await request(second);
    expect(output).toMatchObject({
      success: true,
      result: { text: "Pi 扩展 · fixture\ncount=2" },
    });
    expect(new Set(readyTasks)).toEqual(new Set([first.id, second.id]));
    expect(await request(first)).toMatchObject({ success: false });
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("2");
    const artifact = textArtifact(assertDefined(output.result).text);
    artifact.metadata = {
      toolplanePiSdk: {
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
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGKILL");
      await stopped;
    }
    await platform.close();
    await db.a2AContext.deleteMany({ where: { workspaceId: workspace.id } });
    await db.logEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await db.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
