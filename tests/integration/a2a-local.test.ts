// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { createHash, randomUUID } from "node:crypto";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import {
  captureAgentRevisionConfig,
  requireAgentRevision,
  resolvePinnedAgent,
} from "@/lib/agents/revisions";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import {
  listPlatformSubagents,
  savePlatformSubagents,
  SubagentSettingsSchema,
} from "@/lib/agents/platform-subagents";
import { agentPermissionAdditions } from "@/lib/agents/permission-additions";
import {
  diffAgentRevisions,
  upgradeAgentConversationRevision,
} from "@/lib/agents/conversation-revisions";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AgentCard,
  Message,
  SendMessageRequest,
  Task,
  TaskState,
} from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "@/lib/db";
import {
  updateTaskUi,
  readTaskUi,
  respondTaskUi,
} from "@/lib/agents/execution/task-ui";
import { publishLocalArtifact } from "@/lib/a2a/local-artifacts";
import { openTaskFile, listTaskFiles, storeTaskFile } from "@/lib/a2a/files";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import {
  createLocalRootGrant,
  childGrant,
  assertLocalGrant,
  LOCAL_LIMITS,
  localOwnerKey,
  localTarget,
} from "@/lib/a2a/local-policy";
import { createEntryPolicy } from "@/lib/agents/execution/entry-policy";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import {
  submitTask,
  claimTask as claimStoredTask,
  projectPiHarnessProgress,
  finishTask,
  getTask,
  getTaskRow,
  requestCancellation,
  eventsAfter,
  requestWorkEntryCancellation,
} from "@/lib/a2a/store";
import type { A2ATask, Prisma } from "@prisma/client";
import {
  requestLocalWait,
  requestLocalInput,
  reconcileLocalWaits,
} from "@/lib/a2a/local-continuation";
import { refreshTaskStorage } from "@/lib/a2a/quotas";
import { textArtifact } from "@/lib/a2a/model";
import {
  executeAgentTask as executeStoredTask,
  startAgentWorker,
  stopAgentWorker,
} from "@/lib/agents/execution/worker";
import {
  createAgentRuntimeToken,
  verifyAgentRuntimeToken,
} from "@/lib/agents/runtime-access";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { handleRuntimeTools } from "@/lib/agents/execution/runtime-tools";
import { executeLocalMcpTool } from "@/lib/a2a/local-mcp-tools";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";
import { isAgentRuntimeGrantCurrent } from "@/lib/agents/runtime-grant";
import {
  latestEntryText,
  agentEntryResult,
  submitAgentEntry,
} from "@/lib/agents/execution/entries";
import { localAgentCard } from "@/lib/a2a/local-http";
import type { TaskExecutor } from "@/lib/agents/execution/executor";
import type * as Worker from "@/lib/agents/execution/worker";
import {
  assertMappedDeployment,
  assertMappedVolume,
  mapTaskSandbox,
  taskSandbox,
} from "./task-sandbox-fixture";
import type * as SandboxRuntime from "@/lib/sandboxes/runtime";
import type * as ProcessSupervisor from "@/lib/process/supervisor";
import type * as AttachmentStorage from "@/lib/attachments/storage";
import { localTaskOptions } from "@/lib/agents/execution/task-options";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { executePiCommunicationTool } from "@/lib/a2a/pi-tools";
import { observeWorkRuntime } from "@/lib/work/run-control";
import { executeLocalTask } from "@/lib/agents/execution/pi-executor";
import { runSandboxAgentTurn } from "@/lib/agents/sandbox-runtime";
import type * as AgentSandboxRuntime from "@/lib/agents/sandbox-runtime";

// Native process I/O is injected; Work admission, claims, tokens and child grants remain real.
vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof AgentSandboxRuntime>()),
  runSandboxAgentTurn: vi.fn(),
}));

// PostgreSQL grant, lease, file metadata and artifact publication stay real;
// only attachment bytes are in-memory, so this suite owns no Docker volumes.
const attachmentIO = vi.hoisted(() => ({
  blobs: new Map<string, Uint8Array>(),
}));
vi.mock("@/lib/attachments/storage", async (original) => ({
  ...(await original<typeof AttachmentStorage>()),
  writeWorkspaceAttachment: vi.fn(
    async (input: {
      workspaceId: string;
      objectId: string;
      filename: string;
      body: ReadableStream<Uint8Array>;
      maxBytes: number;
    }) => {
      const bytes = new Uint8Array(
        await new Response(input.body).arrayBuffer(),
      );
      if (bytes.length > input.maxBytes) throw new Error("File too large");
      const storagePath = `objects/${input.objectId}-${input.filename}`;
      attachmentIO.blobs.set(`${input.workspaceId}/${storagePath}`, bytes);
      return {
        storagePath,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  ),
  readWorkspaceAttachment: (workspace: string, path: string) => {
    const bytes = attachmentIO.blobs.get(`${workspace}/${path}`);
    if (!bytes) throw new Error("Stored attachment missing");
    return new Blob([Uint8Array.from(bytes)]).stream();
  },
  deleteWorkspaceAttachmentFile: async (workspace: string, path: string) => {
    attachmentIO.blobs.delete(`${workspace}/${path}`);
  },
}));

// Keep PostgreSQL mapping/authorization real; the executor never starts a runtime.
vi.mock("@/lib/sandboxes/runtime", async (original) => {
  const runtime = await original<typeof SandboxRuntime>();
  return {
    ...runtime,
    assertDockerVolumeExists: vi.fn(async (name: string) =>
      assertMappedVolume(name, runtime.sandboxVolumeName),
    ),
  };
});
vi.mock("@/lib/process/supervisor", async (original) => ({
  ...(await original<typeof ProcessSupervisor>()),
  startProcess: vi.fn((id: string) => assertMappedDeployment(id)),
}));

async function claimTask(id: string) {
  const row = await claimStoredTask(id);
  if (row) await mapTaskSandbox(row);
  return row;
}
async function executeAgentTask(id: string, executor: TaskExecutor) {
  await mapTaskSandbox(await db.a2ATask.findUniqueOrThrow({ where: { id } }));
  return executeStoredTask(id, executor);
}

vi.mock("@/lib/db", async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== "1") return original();
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    db: new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      }),
    }),
  };
});
vi.mock("@/lib/agents/execution/worker", async (original) => ({
  ...(await original<typeof Worker>()),
  wakeAgentWorker: vi.fn(),
}));

let ws: string, user: string, otherUser: string, provider: string;
const agents: string[] = [],
  sandboxes: string[] = [];
let grant: LocalA2AGrant;
const request = (text = "Do this task", extra: Record<string, unknown> = {}) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
      ...extra,
    },
    configuration: { returnImmediately: true },
  });
async function root() {
  return claimTask((await submitTask(grant, request())).id).then((r) =>
    assertDefined(r),
  );
}
async function child(parent: A2ATask, index = 1, input = request()) {
  const authority = await childGrant(
    parent.id,
    assertDefined(parent.leaseToken),
    agents[index],
  );
  return {
    grant: authority,
    row: await submitTask(authority, input, {
      parentLeaseToken: assertDefined(parent.leaseToken),
    }),
  };
}
async function runtimeToken(
  parent: A2ATask,
  index = 0,
): Promise<AgentRuntimeTokenPayload> {
  const authority = parent.grant as unknown as LocalA2AGrant;
  const revision = await requireAgentRevision(
    db,
    agents[index],
    authority.agentRevisionId,
  );
  return {
    workspaceId: ws,
    agentId: agents[index],
    agentRevisionId: revision.id,
    ...taskSandbox(parent),
    providerId: assertDefined(revision.config.providerId),
    deploymentIds: [],
    exp: Math.floor(Date.now() / 1000) + 300,
    a2aTaskId: parent.id,
    a2aContextId: parent.contextId,
    a2aLeaseToken: assertDefined(parent.leaseToken),
  };
}
beforeAll(async () => {
  process.env.AUTH_SECRET = "local-a2a-test-secret-not-production";
  const stamp = randomUUID();
  user = (
    await db.user.create({
      data: { email: `local-a2a-${stamp}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  otherUser = (
    await db.user.create({
      data: {
        email: `local-a2a-other-${stamp}@test.invalid`,
        passwordHash: "x",
      },
    })
  ).id;
  ws = (
    await db.workspace.create({
      data: {
        slug: `local-a2a-${stamp}`,
        name: "Local A2A test",
        ownerId: user,
        members: { create: { userId: otherUser, role: "member" } },
      },
    })
  ).id;
  provider = (
    await db.modelProvider.create({
      data: {
        workspaceId: ws,
        name: "Fixture",
        format: "openai",
        baseUrl: "https://model.test.invalid",
        apiKey: "fixture-secret-never-serialized",
      },
    })
  ).id;
  for (let i = 0; i < 5; i++) {
    const dep = await db.deployment.create({
      data: { workspaceId: ws, name: `Sandbox ${i}`, source: "config" },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: ws,
        deploymentId: dep.id,
        name: `Sandbox ${i}`,
        slug: `s-${i}`,
        kind: "docker",
        network: "isolated",
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: ws,
        name: `Agent ${i}`,
        slug: `a-${i}`,
        runtimeKind: "pi-sdk",
        providerId: provider,
        model: "fixture",
        a2aInternalEnabled: false,
        a2aInboundEnabled: true,
        a2aOutboundEnabled: true,
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    agents.push(agent.id);
    sandboxes.push(sandbox.id);
  }
});
beforeEach(async () => {
  attachmentIO.blobs.clear();
  await db.logEvent.deleteMany({ where: { workspaceId: ws } });
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
  await db.conversation.deleteMany({ where: { agent: { workspaceId: ws } } });
  const sharedDeployments = await db.sandbox.findMany({
    where: { workspaceId: ws, config: { path: ["scope"], equals: "agent" } },
    select: { deploymentId: true },
  });
  await db.deployment.deleteMany({
    where: {
      id: { in: sharedDeployments.map((sandbox) => sandbox.deploymentId) },
    },
  });
  await db.agentSubAgent.deleteMany({ where: { parentId: { in: agents } } });
  await db.agentSubAgent.createMany({
    data: [
      { parentId: agents[0], childId: agents[1] },
      { parentId: agents[0], childId: agents[2] },
      { parentId: agents[1], childId: agents[3] },
      { parentId: agents[3], childId: agents[4] },
    ],
  });
  await db.agent.updateMany({
    where: { workspaceId: ws },
    data: {
      a2aInternalEnabled: false,
      subagentMode: "platform",
      nativeSubagentMaxConcurrency: 4,
      nativeSubagentMaxDepth: 3,
      a2aInboundEnabled: true,
      a2aOutboundEnabled: true,
      a2aPolicy: {
        schemaVersion: 1,
        targets: agents.map((targetId) => ({
          kind: "local",
          targetId,
          capabilityIds: [],
          maxCalls: 128,
          maxDepth: 3,
          maxConcurrent: 16,
          timeoutSeconds: 840,
          maxInputBytes: 65_536,
          dataAllowance: "text_only",
        })),
      },
      systemPrompt: null,
    },
  });
  await db.agent.updateMany({
    where: { id: { in: agents } },
    data: { runtimeKind: "pi-sdk" },
  });
  await db.workspace.update({ where: { id: ws }, data: { status: "active" } });
  await db.user.update({ where: { id: user }, data: { status: "active" } });
  // These are database authorization fixtures, not native publication preflight cases.
  // Full publication starts/removes a Docker preflight container per Pi Agent;
  // doing it for all five Agents on every case needlessly repeats identical native work.
  // Capture real grants and append immutable revisions under the real database guards,
  // as in agents-mutations.test.ts. Explicit publication cases still use the full service.
  await db.$transaction(async (tx) => {
    for (const agentId of agents) {
      const owner = await tx.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { currentRevisionVersion: true },
      });
      const config = await captureAgentRevisionConfig(tx, agentId, {
        kind: "docker",
        image: `fixture@sha256:${"a".repeat(64)}`,
        network: "isolated",
        piVersion: "0.87.1",
        initialSnapshot: null,
        resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
        credentialReferences: [],
      });
      const revision = await tx.agentRevision.create({
        data: {
          agentId,
          version: owner.currentRevisionVersion + 1,
          config: config as Prisma.InputJsonValue,
        },
      });
      await tx.agent.update({
        where: { id: agentId },
        data: { currentRevisionVersion: revision.version },
      });
    }
  });
  grant = await createLocalRootGrant(ws, agents[0], user);
});
afterAll(async () => {
  stopAgentWorker();
  if (ws) {
    await db.logEvent.deleteMany({ where: { workspaceId: ws } });
    await db.auditEvent.deleteMany({ where: { workspaceId: ws } });
    await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
    await db.conversation.deleteMany({ where: { agent: { workspaceId: ws } } });
    await db.workspace.delete({ where: { id: ws } });
  }
  await db.user.deleteMany({
    where: { id: { in: [user, otherUser].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("local Agent authorization and native continuations", () => {
  it("keeps a pinned local grant after clearing only its unapplied draft provider", async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: { providerId: null },
    });
    try {
      await assertLocalGrant(grant);
      expect(await localTarget(db, ws, agents[0])).toMatchObject({
        agentRevisionId: grant.agentRevisionId,
        providerId: provider,
      });
      expect(await createLocalRootGrant(ws, agents[0], user)).toMatchObject({
        agentRevisionId: grant.agentRevisionId,
      });
    } finally {
      await db.agent.update({
        where: { id: agents[0] },
        data: { providerId: provider },
      });
    }
  });

  it("rejects a pinned local grant when its provider credentials are disabled", async () => {
    const pinnedProvider = await db.modelProvider.findUniqueOrThrow({
      where: { id: provider },
      select: { apiKey: true },
    });
    await db.modelProvider.update({
      where: { id: provider },
      data: { apiKey: " " },
    });
    try {
      await expect(assertLocalGrant(grant)).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
      await expect(
        createLocalRootGrant(ws, agents[0], user),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    } finally {
      await db.modelProvider.update({
        where: { id: provider },
        data: { apiKey: pinnedProvider.apiKey },
      });
    }
  });

  it("projects bound native progress without spending journal sequence or event storage", async () => {
    const running = await root();
    const operationId = randomUUID();
    const leaseToken = assertDefined(running.leaseToken);
    await db.a2ATask.update({
      where: { id: running.id },
      data: {
        executionBackend: "pi-harness",
        nativeOperationId: operationId,
        sequence: 129,
      },
    });
    const eventCount = await db.a2AEvent.count({
      where: { taskId: running.id },
    });
    await db.$transaction((tx) => refreshTaskStorage(tx, running.id));
    await projectPiHarnessProgress(
      running.id,
      leaseToken,
      operationId,
      "Still working",
    );
    const projected = await getTaskRow(grant, running.id);
    expect(projected.sequence).toBe(129);
    expect(projected.storageBytes).toBeGreaterThan(0);
    expect(
      Task.fromJSON(projected.snapshot).status?.message?.parts[0]?.content,
    ).toEqual({ $case: "text", value: "Still working" });
    expect(await db.a2AEvent.count({ where: { taskId: running.id } })).toBe(
      eventCount,
    );
    for (const [token, operation] of [
      ["stale-lease", operationId],
      [leaseToken, randomUUID()],
    ] as const) {
      await projectPiHarnessProgress(
        running.id,
        token,
        operation,
        "Stale update",
      );
      const unchanged = await getTaskRow(grant, running.id);
      expect(unchanged.snapshot).toEqual(projected.snapshot);
      expect(unchanged.sequence).toBe(129);
      expect(unchanged.storageBytes).toBe(projected.storageBytes);
    }
    expect(await db.a2AEvent.count({ where: { taskId: running.id } })).toBe(
      eventCount,
    );
  });

  it("admits configured execution capacity plus a bounded queue and frees canceled slots", async () => {
    const key = "agents.concurrency";
    const previous = await db.systemSetting.findUnique({ where: { key } });
    const maxTotal = 20;
    const value = JSON.stringify({ maxPerAgent: maxTotal, maxTotal });
    await db.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    try {
      const tasks: A2ATask[] = [];
      for (
        let index = 0;
        index < maxTotal + LOCAL_LIMITS.queuedPerWorkspace;
        index++
      )
        tasks.push(await submitTask(grant, request()));
      expect(tasks.at(-1)?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      await expect(submitTask(grant, request())).rejects.toThrow(
        "Local task capacity reached",
      );
      await requestCancellation(grant, tasks[0].id);
      const replacement = await submitTask(grant, request());
      expect(replacement.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      expect(replacement.id).not.toBe(tasks[0].id);
    } finally {
      if (previous)
        await db.systemSetting.update({
          where: { key },
          data: { value: previous.value },
        });
      else await db.systemSetting.deleteMany({ where: { key } });
    }
  });
  it("reflects persisted Agent descriptions and Agent-invocable Skills in the Card", async () => {
    const previousOrigin = process.env.NEXT_PUBLIC_APP_URL;
    const skillSlug = `a2a-card-${randomUUID()}`;
    let skillId: string | undefined, installedSkillId: string | undefined;
    process.env.NEXT_PUBLIC_APP_URL = "https://toolplane.test";
    try {
      const skill = await db.skill.create({
        data: {
          slug: skillSlug,
          name: "Card review",
          description: "Review code for security issues.",
        },
      });
      skillId = skill.id;
      const installedSkill = await db.installedSkill.create({
        data: { workspaceId: ws, skillId: skill.id, agentInvocable: true },
      });
      installedSkillId = installedSkill.id;
      await db.agentSkill.create({
        data: { agentId: agents[0], installedSkillId },
      });
      await db.agent.update({
        where: { id: agents[0] },
        data: { systemPrompt: "private-card-instructions" },
      });
      await publishFixtureAgentRevision(ws, agents[0]);
      const authority = await createLocalRootGrant(ws, agents[0], user);
      await db.agent.update({
        where: { id: agents[0] },
        data: { description: "  Review code and identify security risks.  " },
      });
      const card = AgentCard.fromJSON(
        AgentCard.toJSON(await localAgentCard(authority)),
      );
      expect(card.description).toBe("Review code and identify security risks.");
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0]).toMatchObject({
        id: installedSkill.id,
        name: skill.name,
        description: skill.description,
        tags: [skill.slug],
      });
      expect(card.version).toBe(authority.targetBinding);
      expect(JSON.stringify(card)).not.toContain("private-card-instructions");
      expect(JSON.stringify(card)).not.toContain(
        "fixture-secret-never-serialized",
      );
      await assertLocalGrant(authority);
      await expect(
        localAgentCard({ ...authority, workspaceId: randomUUID() }),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      await db.agent.update({
        where: { id: agents[0] },
        data: { description: " \t\n " },
      });
      expect((await localAgentCard(authority)).description.trim()).not.toBe("");
      await assertLocalGrant(authority);
    } finally {
      if (installedSkillId)
        await db.installedSkill.delete({ where: { id: installedSkillId } });
      if (skillId) await db.skill.delete({ where: { id: skillId } });
      await db.agent.update({
        where: { id: agents[0] },
        data: { description: null },
      });
      if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = previousOrigin;
    }
  });
  it("creates no public client, endpoint, AgentRun or private Conversation", async () => {
    const before = await db.agentRun.count();
    const parent = await root();
    await child(parent);
    expect(
      await db.agentApiClient.count({
        where: { endpoint: { workspaceId: ws } },
      }),
    ).toBe(0);
    expect(await db.agentEndpoint.count({ where: { workspaceId: ws } })).toBe(
      0,
    );
    expect(
      await db.conversation.count({ where: { agentId: { in: agents } } }),
    ).toBe(0);
    expect(await db.agentRun.count()).toBe(before);
    const ctx = await db.a2AContext.findUniqueOrThrow({
      where: { id: parent.contextId },
    });
    expect(ctx).toMatchObject({
      targetKind: "local",
      workspaceId: ws,
      agentId: agents[0],
      endpointId: null,
      clientId: null,
      revisionId: null,
    });
    expect(JSON.stringify(parent.grant)).not.toContain("fixture-secret");
  });
  it("isolates account roots and separate parent tasks", async () => {
    const parent = await root();
    const delegated = await child(parent);
    const other = await createLocalRootGrant(ws, agents[0], otherUser);
    await expect(getTask(other, parent.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(getTask(grant, delegated.row.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    const second = await root();
    const secondGrant = await childGrant(
      second.id,
      assertDefined(second.leaseToken),
      agents[1],
    );
    await expect(getTask(secondGrant, delegated.row.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
  it("authorizes delegation by the parent's edge, not the child's inbound switch", async () => {
    await db.agent.update({
      where: { id: agents[1] },
      data: { a2aInternalEnabled: false, a2aInboundEnabled: false },
    });
    const parent = await root();
    const delegated = await child(parent);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(TaskState.TASK_STATE_SUBMITTED);
    await assertLocalGrant(delegated.grant);
    // Direct ingress to the child still requires its own inbound opt-in.
    await expect(
      createLocalRootGrant(ws, agents[1], user),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    await expect(assertLocalGrant(delegated.grant)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(child(parent)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      childGrant(parent.id, assertDefined(parent.leaseToken), randomUUID()),
    ).rejects.toThrow();
    await expect(
      childGrant(parent.id, assertDefined(parent.leaseToken), agents[4]),
    ).rejects.toThrow();
  });
  it("rejects root cycles, excessive depth and forged current-run leases", async () => {
    const parent = await root();
    const b = await child(parent);
    const bRun = assertDefined(await claimTask(b.row.id));
    await expect(
      childGrant(bRun.id, assertDefined(bRun.leaseToken), agents[0]),
    ).rejects.toThrow();
    await expect(childGrant(parent.id, "wrong", agents[1])).rejects.toThrow();
    await expect(
      submitTask(b.grant, request(), { parentLeaseToken: "wrong" }),
    ).rejects.toThrow();
    const c = await childGrant(
      bRun.id,
      assertDefined(bRun.leaseToken),
      agents[3],
    );
    const cRun = assertDefined(
      await claimTask(
        (
          await submitTask(c, request(), {
            parentLeaseToken: assertDefined(bRun.leaseToken),
          })
        ).id,
      ),
    );
    const d = await childGrant(
      cRun.id,
      assertDefined(cRun.leaseToken),
      agents[4],
    );
    const dRun = assertDefined(
      await claimTask(
        (
          await submitTask(d, request(), {
            parentLeaseToken: assertDefined(cRun.leaseToken),
          })
        ).id,
      ),
    );
    await expect(
      childGrant(dRun.id, assertDefined(dRun.leaseToken), agents[2]),
    ).rejects.toThrow();
  });
  it("keeps the parent WORKING, releases its lease and resumes once after a parallel join", async () => {
    const parent = await root();
    const b = await child(parent, 1);
    const c = await child(parent, 2);
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
      c.row.id,
    ]);
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      3,
      undefined,
      textArtifact("Waiting for specialists"),
    );
    expect(await getTaskRow(grant, parent.id)).toMatchObject({
      phase: "waiting",
      state: 2,
      leaseToken: null,
      resumeCount: 0,
    });
    const bRun = assertDefined(await claimTask(b.row.id));
    await finishTask(
      bRun.id,
      assertDefined(bRun.leaseToken),
      3,
      undefined,
      textArtifact("Review result"),
    );
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("waiting");
    const cRun = assertDefined(await claimTask(c.row.id));
    await finishTask(
      cRun.id,
      assertDefined(cRun.leaseToken),
      3,
      undefined,
      textArtifact("Test result"),
    );
    await reconcileLocalWaits();
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.leaseToken).not.toBe(parent.leaseToken);
    expect(await claimTask(parent.id)).toBeNull();
    expect(
      JSON.stringify(Task.fromJSON(resumed.snapshot).history.at(-1)),
    ).toContain("Review result");
    expect(
      JSON.stringify(Task.fromJSON(resumed.snapshot).history.at(-1)),
    ).toContain("Test result");
    await finishTask(
      parent.id,
      assertDefined(resumed.leaseToken),
      3,
      undefined,
      textArtifact("Combined report"),
    );
    expect((await getTask(grant, parent.id)).status?.state).toBe(3);
    expect((await eventsAfter(grant, parent.id, 0)).length).toBeGreaterThan(4);
  });
  it("supports question → parent continuation → child continuation with the same task ID", async () => {
    const parent = await root();
    const b = await child(parent);
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    const run = assertDefined(await claimTask(b.row.id));
    await requestLocalInput(
      run.id,
      assertDefined(run.leaseToken),
      "Which branch?",
    );
    await finishTask(run.id, assertDefined(run.leaseToken), 3);
    expect((await getTask(b.grant, run.id)).status?.state).toBe(6);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const continuedGrant = await childGrant(
      parent.id,
      assertDefined(resumed.leaseToken),
      agents[1],
    );
    const continued = await submitTask(
      continuedGrant,
      request("main", { taskId: run.id }),
      { parentLeaseToken: assertDefined(resumed.leaseToken) },
    );
    expect(continued.id).toBe(run.id);
    expect(continued.deadlineAt).toEqual(run.deadlineAt);
    const next = assertDefined(await claimTask(run.id));
    await finishTask(
      run.id,
      assertDefined(next.leaseToken),
      3,
      undefined,
      textArtifact("Reviewed main"),
    );
    await finishTask(
      parent.id,
      assertDefined(resumed.leaseToken),
      3,
      undefined,
      textArtifact("Done"),
    );
    expect((await getTask(grant, parent.id)).status?.state).toBe(3);
  });
  it("cannot turn an executor crash after requesting input or wait into a pause", async () => {
    const parent = await root();
    await requestLocalInput(
      parent.id,
      assertDefined(parent.leaseToken),
      "More information?",
    );
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_FAILED,
      "Executor failed",
    );
    expect((await getTask(grant, parent.id)).status?.state).toBe(4);
  });
  it("automatically joins outstanding children when the parent ends its turn early", async () => {
    const parent = await root();
    await child(parent);
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      3,
      undefined,
      textArtifact("Submitted"),
    );
    expect(await getTaskRow(grant, parent.id)).toMatchObject({
      state: 2,
      phase: "waiting",
      leaseToken: null,
    });
  });
  it("rejects waiting on foreign, unrelated or self tasks", async () => {
    const parent = await root();
    const other = await root();
    const foreign = await child(other);
    await expect(
      requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
        foreign.row.id,
      ]),
    ).rejects.toThrow();
    await expect(
      requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
        parent.id,
      ]),
    ).rejects.toThrow();
  });
  it("cascades cancellation and never reports an active child stopped before acknowledgment", async () => {
    const parent = await root();
    const b = await child(parent);
    const c = await child(parent, 2);
    const bRun = assertDefined(await claimTask(b.row.id));
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
      c.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    expect((await requestCancellation(grant, parent.id)).status?.state).toBe(5);
    expect(
      await db.a2ATask.findUnique({ where: { id: b.row.id } }),
    ).toMatchObject({ state: 2, cancelRequestedAt: expect.any(Date) });
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: c.row.id } })).state,
    ).toBe(5);
    await finishTask(
      bRun.id,
      assertDefined(bRun.leaseToken),
      3,
      undefined,
      textArtifact("must not publish"),
    );
    expect(
      Task.fromJSON(
        (await db.a2ATask.findUniqueOrThrow({ where: { id: b.row.id } }))
          .snapshot,
      ).artifacts,
    ).toEqual([]);
  });
  it("revalidates actor, ancestor edges and configuration before resuming", async () => {
    const parent = await root();
    const b = await child(parent);
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    await expect(assertLocalGrant(b.grant)).rejects.toThrow();
    await reconcileLocalWaits();
    expect((await getTask(grant, parent.id)).status?.state).toBe(4);
    const fresh = await createLocalRootGrant(ws, agents[0], user);
    await db.user.update({
      where: { id: user },
      data: { status: "suspended" },
    });
    await expect(assertLocalGrant(fresh)).rejects.toThrow();
  });
  it("does not let waiting renew the root deadline or inflate task budgets", async () => {
    const parent = await root();
    const b = await child(parent);
    expect(b.row.deadlineAt.getTime()).toBeLessThanOrEqual(
      parent.deadlineAt.getTime(),
    );
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    await db.a2ATask.update({
      where: { id: parent.id },
      data: { deadlineAt: new Date(0) },
    });
    await reconcileLocalWaits();
    expect((await getTask(grant, parent.id)).status?.state).toBe(4);
  });
  it("revokes task model/MCP credentials on suspension and prevents stale-lease publication", async () => {
    const parent = await root();
    const token = await runtimeToken(parent);
    await assertLocalRuntimeToken(token);
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(true);
    const b = await child(parent);
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    await expect(assertLocalRuntimeToken(token)).rejects.toThrow();
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      3,
      undefined,
      textArtifact("stale result"),
    );
    expect((await getTask(grant, parent.id)).artifacts).toEqual([]);
  });
  it("uses the official MCP client/transport with task-scoped credentials", async () => {
    const parent = await root();
    const token = await createAgentRuntimeToken(await runtimeToken(parent));
    const url = `https://toolplane.test/api/v1/agent-runtime/tasks/${parent.id}/tools`;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return req.method === "POST"
          ? handleRuntimeTools(req, parent.id)
          : new Response(null, { status: 405 });
      },
    });
    const client = new Client({ name: "local-a2a-test", version: "1" });
    try {
      await client.connect(transport);
      const args = {
        target: `agent:${agents[1]}`,
        message: "Do this task",
        messageId: randomUUID(),
        wait: false,
      };
      const result = await client.callTool({
        name: "pi_a2a_submit",
        arguments: args,
      });
      expect(result.isError).toBe(false);
      const acceptedContent = result.content as Array<{
        type: string;
        text?: string;
      }>;
      const accepted = JSON.parse(
        assertDefined(assertDefined(acceptedContent[0]).text),
      ) as {
        taskId: string;
      };
      expect(accepted.taskId).toEqual(expect.any(String));
      const status = await client.callTool({
        name: "pi_a2a_status",
        arguments: { target: args.target, taskId: accepted.taskId },
      });
      expect(status.isError).toBe(false);
      expect(JSON.stringify(status)).toContain("TASK_STATE_SUBMITTED");
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      const event = await db.logEvent.findFirstOrThrow({
        where: {
          workspaceId: ws,
          eventName: "a2a.request",
          toolName: "pi_a2a_submit",
        },
        include: { detail: true },
      });
      expect(event).toMatchObject({
        actorId: user,
        agentId: agents[0],
        httpStatus: null,
        outcome: "success",
        attributes: {
          data: {
            a2a: {
              direction: "internal",
              transport: "mcp",
              taskId: parent.id,
              rootTaskId: parent.id,
            },
          },
        },
      });
      expect(event.detail?.data).toMatchObject({
        workspaceMcpPayload: false,
        payload: { request: args, response: result, responseComplete: true },
      });
      expect(JSON.stringify(event)).not.toContain(token);
      const rejectedArgs = {
        target: `agent:${agents[1]}`,
        taskId: randomUUID(),
      };
      const rejected = await client.callTool({
        name: "pi_a2a_status",
        arguments: rejectedArgs,
      });
      expect(rejected.isError).toBe(true);
      const failure = await db.logEvent.findFirstOrThrow({
        where: {
          workspaceId: ws,
          eventName: "a2a.request",
          toolName: "pi_a2a_status",
          // The earlier successful status call has the same tool name.
          detail: {
            is: {
              data: {
                path: ["payload", "request", "taskId"],
                equals: rejectedArgs.taskId,
              },
            },
          },
        },
        include: { detail: true },
      });
      expect(failure).toMatchObject({
        outcome: "error",
        httpStatus: null,
        attributes: { data: { a2a: { taskId: parent.id } } },
      });
      expect(failure.detail?.data).toMatchObject({
        payload: { request: rejectedArgs, response: rejected },
      });
    } finally {
      await client.close();
    }
  });
  it("waits for a platform child's result and mirrors it into the parent's sub-agent activity", async () => {
    const parent = await root();
    const token = await createAgentRuntimeToken(await runtimeToken(parent));
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `https://toolplane.test/api/v1/agent-runtime/tasks/${parent.id}/tools`,
      ),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return req.method === "POST"
            ? handleRuntimeTools(req, parent.id)
            : new Response(null, { status: 405 });
        },
      },
    );
    const client = new Client({ name: "local-a2a-wait-test", version: "1" });
    try {
      await client.connect(transport);
      const submitted = client.callTool({
        name: "pi_a2a_submit",
        arguments: {
          target: `agent:${agents[1]}`,
          message: "Return the marker",
          messageId: randomUUID(),
        },
      });
      // The child row is created inside the in-flight tool call and the server waits on
      // real Postgres state, so fake timers cannot drive this; poll for the row briefly.
      let childRow: A2ATask | null = null;
      for (let attempt = 0; !childRow && attempt < 100; attempt++) {
        childRow = await db.a2ATask.findFirst({
          where: { parentTaskId: parent.id },
        });
        if (!childRow) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const run = assertDefined(await claimTask(assertDefined(childRow).id));
      await finishTask(
        run.id,
        assertDefined(run.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("child marker 42"),
      );
      const result = await submitted;
      expect(result.isError).toBe(false);
      const content = result.content as Array<{ text?: string }>;
      const body = JSON.parse(
        assertDefined(assertDefined(content[0]).text),
      ) as {
        taskId: string;
        pending?: boolean;
        task: unknown;
      };
      expect(body.taskId).toBe(run.id);
      expect(body.pending).toBeUndefined();
      expect(Task.fromJSON(body.task).status?.state).toBe(
        TaskState.TASK_STATE_COMPLETED,
      );
      expect(JSON.stringify(body.task)).toContain("child marker 42");
      const view = await readTaskUi(
        { workspaceId: ws, actorId: user, agentId: agents[0], slug: "fixture" },
        parent.id,
        parent.id,
      );
      expect(view.activities).toEqual([
        expect.objectContaining({
          type: "tool",
          status: "completed",
          toolCallId: `platform-child:${run.id}`,
          source: { subagentId: run.id, subagentName: "Agent 1" },
          output: "child marker 42",
        }),
      ]);
    } finally {
      await client.close();
    }
  });
  it("blocks ordinary runtime tokens and cross-task MCP access", async () => {
    const parent = await root();
    const payload = await runtimeToken(parent);
    const ordinary = {
      ...payload,
      a2aTaskId: undefined,
      a2aLeaseToken: undefined,
    };
    await expect(
      executeLocalMcpTool(ordinary, "a2a_list_agents", {}),
    ).rejects.toThrow();
    const other = await root();
    const otherPayload = await runtimeToken(other);
    expect(otherPayload.sandboxId).toBe(payload.sandboxId);
    for (const invalid of [
      { ...payload, a2aContextId: undefined },
      { ...payload, a2aContextId: other.contextId },
      { ...payload, sandboxId: sandboxes[0] },
      { ...payload, a2aLeaseToken: assertDefined(other.leaseToken) },
    ]) {
      await expect(assertLocalRuntimeToken(invalid)).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
      expect(await isAgentRuntimeGrantCurrent(invalid)).toBe(false);
    }
    const token = await createAgentRuntimeToken(payload);
    const req = new Request("https://toolplane.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect((await handleRuntimeTools(req, "wrong-task")).status).toBe(401);
  });
  it("enforces a root-wide task count including completed child work", async () => {
    const parent = await root();
    for (let i = 1; i < LOCAL_LIMITS.tasksPerRoot; i++) {
      const b = await child(parent);
      const run = assertDefined(await claimTask(b.row.id));
      await finishTask(run.id, assertDefined(run.leaseToken), 3);
    }
    await expect(child(parent)).rejects.toThrow("capacity");
    expect(await db.a2ATask.count({ where: { rootTaskId: parent.id } })).toBe(
      LOCAL_LIMITS.tasksPerRoot,
    );
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === "1")(
    "atomically claims one parent continuation under PostgreSQL concurrency",
    async () => {
      const parent = await root();
      const b = await child(parent);
      const run = assertDefined(await claimTask(b.row.id));
      await finishTask(run.id, assertDefined(run.leaseToken), 3);
      await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
        b.row.id,
      ]);
      await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
      const claimed = await Promise.all([
        claimTask(parent.id),
        claimTask(parent.id),
        claimTask(parent.id),
      ]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
    },
  );
  it("runs a durable parent-child-parent cycle through the native Worker port", async () => {
    const initial = await submitTask(grant, request());
    let childId = "";
    await executeAgentTask(initial.id, async (parent, signal) => {
      signal.throwIfAborted();
      const b = await child(parent);
      childId = b.row.id;
      await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
        childId,
      ]);
      return { state: 3, artifact: textArtifact("Delegated") };
    });
    await executeAgentTask(childId, async () => ({
      state: 3,
      artifact: textArtifact("Specialist result"),
    }));
    await reconcileLocalWaits();
    await executeAgentTask(initial.id, async (resumed) => {
      expect(
        Message.toJSON(
          assertDefined(Task.fromJSON(resumed.snapshot).history.at(-1)),
        ),
      ).toMatchObject({ role: "ROLE_USER" });
      return { state: 3, artifact: textArtifact("Combined answer") };
    });
    expect((await getTask(grant, initial.id)).status?.state).toBe(3);
  });
  it("preserves waiting work across restart, but fails uncertain executing children instead of replaying them", async () => {
    const parent = await root();
    const b = await child(parent);
    await claimTask(b.row.id);
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      b.row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    await startAgentWorker();
    stopAgentWorker();
    expect(await getTaskRow(grant, parent.id)).toMatchObject({
      state: 2,
      phase: "waiting",
    });
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: b.row.id } })).state,
    ).toBe(4);
  });
  it("automatically rejoins a child question even when the parent forgot to explicitly await", async () => {
    const parent = await root();
    const delegated = await child(parent);
    const executing = assertDefined(await claimTask(delegated.row.id));
    await requestLocalInput(
      executing.id,
      assertDefined(executing.leaseToken),
      "Which branch?",
    );
    await finishTask(
      executing.id,
      assertDefined(executing.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
    );
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("I delegated it."),
    );
    expect(await getTaskRow(grant, parent.id)).toMatchObject({
      state: TaskState.TASK_STATE_WORKING,
      phase: "resumable",
      leaseToken: null,
    });
    const resumed = assertDefined(await claimTask(parent.id));
    expect(JSON.stringify(resumed.snapshot)).toContain("Which branch?");
  });
  it("revalidates local authority before committing a successful executor result", async () => {
    const parent = await root();
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInboundEnabled: false },
    });
    await expect(
      finishTask(
        parent.id,
        assertDefined(parent.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("late"),
      ),
    ).rejects.toThrow();
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_FAILED,
    );
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } })).state,
    ).toBe(TaskState.TASK_STATE_FAILED);
  });
  it("keeps a busy local sandbox task queued instead of failing or replaying it", async () => {
    await startAgentWorker();
    try {
      const queued = await submitTask(grant, request());
      let release!: () => void;
      const lock = withSandboxExecutionLease(
        (await mapTaskSandbox(await getTaskRow(grant, queued.id))).sandboxId,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const executor = vi.fn(async () => ({
        state: TaskState.TASK_STATE_COMPLETED,
        artifact: textArtifact("done"),
      }));
      try {
        await executeAgentTask(queued.id, executor);
        expect(executor).not.toHaveBeenCalled();
        expect(await getTaskRow(grant, queued.id)).toMatchObject({
          state: TaskState.TASK_STATE_SUBMITTED,
          phase: "queued",
          leaseToken: null,
        });
      } finally {
        release();
        await lock;
      }
      await executeAgentTask(queued.id, executor);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(
        assertDefined((await getTask(grant, queued.id)).status).state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      stopAgentWorker();
    }
  });
});

describe("console task tree authorization", () => {
  const actor = () => ({
    workspaceId: ws,
    actorId: user,
    agentId: agents[0],
    slug: "unused",
  });
  it("shows owned root and descendants without execution grants or private prompts", async () => {
    const parent = await root();
    const delegated = await child(parent);
    await db.agent.update({
      where: { id: agents[1] },
      data: { a2aInternalEnabled: false },
    });
    const tree = await getConsoleTaskTree(actor(), parent.id, delegated.row.id);
    expect(tree.nodes.map((n) => n.id)).toEqual([parent.id, delegated.row.id]);
    expect(tree.selectedTask).toMatchObject({
      id: delegated.row.id,
      status: { state: "TASK_STATE_SUBMITTED" },
    });
    expect(tree.selectedTask.history ?? []).toEqual([]);
    expect(tree.restricted).toBe(false);
    for (const value of [
      assertDefined(parent.leaseToken),
      "fixture-secret",
      "targetBinding",
      "ancestorAgentIds",
    ])
      expect(JSON.stringify(tree)).not.toContain(value);
  });
  it("denies another member, foreign root and direct delegated entry", async () => {
    const parent = await root();
    const delegated = await child(parent);
    await expect(
      getConsoleTaskTree({ ...actor(), actorId: otherUser }, parent.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      getConsoleTaskTree(actor(), delegated.row.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    const second = await root();
    await expect(
      getConsoleTaskTree(actor(), second.id, delegated.row.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it("restricts a stale console tree to its visible parent after an edge is revoked", async () => {
    const parent = await root();
    const delegated = await child(parent);
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    const tree = await getConsoleTaskTree(actor(), parent.id);
    expect(tree.restricted).toBe(true);
    expect(tree.nodes.map((node) => node.id)).toEqual([parent.id]);
    expect(tree.selectedTask.id).toBe(parent.id);
    expect(JSON.stringify(tree)).not.toContain(delegated.row.id);
    expect(JSON.stringify(tree)).not.toContain(
      assertDefined(parent.leaseToken),
    );
    await expect(
      getConsoleTaskTree(actor(), parent.id, delegated.row.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it("uses current read authority, not an expired execution credential, for history", async () => {
    const parent = await root();
    const delegated = await child(parent);
    await requestCancellation(grant, parent.id);
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_CANCELED,
    );
    const stored = await db.a2ATask.findUniqueOrThrow({
      where: { id: delegated.row.id },
    });
    await db.a2ATask.update({
      where: { id: stored.id },
      data: { grant: { ...delegated.grant, expiresAt: 1 } },
    });
    expect(
      (await getConsoleTaskTree(actor(), parent.id, stored.id)).selectedTask.id,
    ).toBe(stored.id);
  });
});

describe("scoped native task artifacts", () => {
  it("publishes standard JSON and binary artifacts atomically and makes retries idempotent", async () => {
    const task = await root();
    const data = {
      artifactId: "report-v1",
      name: "review.json",
      parts: [{ data: { z: "last", a: "first" } }],
    };
    await publishLocalArtifact(task.id, assertDefined(task.leaseToken), data);
    const count = (await eventsAfter(grant, task.id, 0)).length;
    expect(
      await publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
        ...data,
        parts: [{ data: { a: "first", z: "last" } }],
      }),
    ).toMatchObject({ replay: true });
    expect((await eventsAfter(grant, task.id, 0)).length).toBe(count);
    await expect(
      publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
        ...data,
        parts: [{ text: "changed" }],
      }),
    ).rejects.toThrow();
    const patch = {
      artifactId: "patch-v1",
      name: "fix.patch",
      parts: [
        {
          raw: Buffer.from("diff --git").toString("base64"),
          mediaType: "text/x-diff",
        },
      ],
    };
    await publishLocalArtifact(task.id, assertDefined(task.leaseToken), patch);
    const wire = Task.toJSON(await getTask(grant, task.id)) as {
      artifacts: Array<{ parts: unknown[]; metadata: Record<string, unknown> }>;
    };
    expect(wire.artifacts[0].parts[0]).toMatchObject({
      data: { a: "first", z: "last" },
      mediaType: "application/json",
    });
    // Binary bytes become an owned immutable file handle, never persisted base64.
    const patchPart = assertDefined(
      (await getTask(grant, task.id)).artifacts.find(
        (artifact) => artifact.artifactId === patch.artifactId,
      )?.parts[0],
    );
    const fileId = patchPart.metadata?.toolplaneFileId;
    if (typeof fileId !== "string")
      throw new Error("Published binary artifact has no owned file handle");
    const storedFile = await openTaskFile(task.id, fileId);
    expect(await new Response(storedFile.body).text()).toBe("diff --git");
    expect(storedFile.file.mimeType).toBe("text/x-diff");
    expect(JSON.stringify(wire)).not.toContain(
      Buffer.from("diff --git").toString("base64"),
    );
    const binaryEventCount = (await eventsAfter(grant, task.id, 0)).length;
    expect(
      await publishLocalArtifact(
        task.id,
        assertDefined(task.leaseToken),
        patch,
      ),
    ).toMatchObject({ replay: true });
    expect((await eventsAfter(grant, task.id, 0)).length).toBe(
      binaryEventCount,
    );
    await expect(
      publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
        ...patch,
        parts: [
          {
            raw: Buffer.from("changed patch").toString("base64"),
            mediaType: "text/x-diff",
          },
        ],
      }),
    ).rejects.toThrow();
    const unchanged = await openTaskFile(task.id, fileId);
    expect(await new Response(unchanged.body).text()).toBe("diff --git");
    expect(await db.a2ATaskFile.count({ where: { taskId: task.id } })).toBe(1);
    expect(
      wire.artifacts[1].metadata["toolplane.dev/provenance"],
    ).toMatchObject({
      taskId: task.id,
      contextId: task.contextId,
      targetId: agents[0],
      targetKind: "local",
      sizeBytes: Buffer.byteLength("diff --git"),
      digestAlgorithm: "sha256-canonical-parts-json",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const reader = await createLocalRootGrant(ws, agents[0], otherUser);
    await expect(getTask(reader, task.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
  it("rejects stale execution leases and attempts to publish after suspension", async () => {
    const task = await root();
    const data = {
      artifactId: "x",
      name: "report.txt",
      parts: [{ text: "report" }],
    };
    await expect(
      publishLocalArtifact(task.id, "stale", data),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await requestLocalInput(
      task.id,
      assertDefined(task.leaseToken),
      "Which branch?",
    );
    await expect(
      publishLocalArtifact(task.id, assertDefined(task.leaseToken), data),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it("honors caller output modes without guessing JSON from ordinary model text", async () => {
    const input = request();
    assertDefined(input.configuration).acceptedOutputModes = [
      "application/json",
    ];
    const task = assertDefined(
      await claimTask((await submitTask(grant, input)).id),
    );
    await expect(
      publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
        artifactId: "no",
        name: "no.txt",
        parts: [{ text: "not accepted" }],
      }),
    ).rejects.toThrow();
    await publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
      artifactId: "yes",
      name: "report.json",
      parts: [{ data: { ok: true } }],
    });
    await finishTask(
      task.id,
      assertDefined(task.leaseToken),
      3,
      undefined,
      textArtifact("Completed review"),
    );
    const result = await getTask(grant, task.id);
    expect(result.status?.state).toBe(3);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].artifactId).toBe("yes");
    const missing = assertDefined(
      await claimTask(
        (
          await submitTask(grant, {
            ...input,
            message: {
              ...assertDefined(input.message),
              messageId: randomUUID(),
            },
          })
        ).id,
      ),
    );
    await finishTask(
      missing.id,
      assertDefined(missing.leaseToken),
      3,
      undefined,
      textArtifact('{"not":"parsed"}'),
    );
    expect((await getTask(grant, missing.id)).status?.state).toBe(4);
  });
});

describe("native task context persistence", () => {
  it("creates follow-ups in one context, retains the old terminal task and deduplicates retries", async () => {
    const first = await submitTask(grant, request("Review"));
    const running = assertDefined(await claimTask(first.id));
    await finishTask(
      first.id,
      assertDefined(running.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("First report"),
    );
    const previous = await getTask(grant, first.id);
    const nextRequest = request("Refine the report", {
      contextId: previous.contextId,
      referenceTaskIds: [previous.id],
    });
    const next = await submitTask(grant, nextRequest);
    const replay = await submitTask(grant, nextRequest);
    expect(next.id).not.toBe(first.id);
    expect(replay.id).toBe(next.id);
    expect(next.contextId).toBe(first.contextId);
    expect((await getTask(grant, first.id)).status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    expect((await getTask(grant, first.id)).artifacts).toEqual(
      previous.artifacts,
    );
    expect(
      await db.conversation.count({ where: { agent: { workspaceId: ws } } }),
    ).toBe(0);
    expect(await db.workSession.count({ where: { workspaceId: ws } })).toBe(0);
  });
  it("answers an input-required task without renewing its deadline or replacing its task ID", async () => {
    const first = await root();
    await requestLocalInput(
      first.id,
      assertDefined(first.leaseToken),
      "Which branch?",
    );
    await finishTask(
      first.id,
      assertDefined(first.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
    );
    const waiting = await getTask(grant, first.id);
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const reply = request("main", {
      taskId: waiting.id,
      contextId: waiting.contextId,
    });
    const continued = await submitTask(grant, reply);
    expect(continued.id).toBe(first.id);
    expect(continued.contextId).toBe(first.contextId);
    expect(continued.deadlineAt).toEqual(first.deadlineAt);
    expect((await submitTask(grant, reply)).id).toBe(first.id);
    const run = assertDefined(await claimTask(first.id));
    await finishTask(
      run.id,
      assertDefined(run.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("Reviewed main"),
    );
    expect(
      (await getTask(grant, first.id)).history.some((message) =>
        message.parts.some(
          (part) =>
            part.content?.$case === "text" && part.content.value === "main",
        ),
      ),
    ).toBe(true);
  });
  it("returns bounded task history only through the authorized root and excludes it by default", async () => {
    const parent = await root();
    const delegated = await child(parent);
    const actor = {
      workspaceId: ws,
      actorId: user,
      agentId: agents[0],
      slug: "test",
    };
    expect(
      (await getConsoleTaskTree(actor, parent.id)).selectedTask.history ?? [],
    ).toEqual([]);
    const viewed = await getConsoleTaskTree(actor, parent.id, parent.id, 32);
    expect(
      Task.fromJSON(viewed.selectedTask).history[0].parts[0].content?.value,
    ).toBe("Do this task");
    await expect(
      getConsoleTaskTree(
        { ...actor, actorId: otherUser },
        parent.id,
        parent.id,
        32,
      ),
    ).rejects.toThrow();
    await expect(
      getConsoleTaskTree(actor, delegated.row.id, delegated.row.id, 32),
    ).rejects.toThrow();
    await expect(
      getConsoleTaskTree(actor, parent.id, parent.id, 33),
    ).rejects.toThrow();
  });
});

describe("native Pi UI projections", () => {
  const actor = () => ({
    workspaceId: ws,
    actorId: user,
    agentId: agents[0],
    slug: "local-test",
  });
  async function dialog() {
    const row = await root();
    const token = await runtimeToken(row);
    const request = {
      type: "extension_ui_request" as const,
      id: randomUUID(),
      method: "confirm" as const,
      title: "Native confirmation",
      message: "Continue?",
    };
    expect(await updateTaskUi(token, { action: "request", request })).toEqual(
      {},
    );
    return { row, token, request };
  }
  it("answers exact native dialogs once without granting tool permissions", async () => {
    const { row, token, request } = await dialog();
    expect((await readTaskUi(actor(), row.id, row.id)).uiRequests).toEqual([
      request,
    ]);
    const response = {
      type: "extension_ui_response" as const,
      id: request.id,
      confirmed: true,
    };
    await respondTaskUi(actor(), row.id, row.id, response);
    await expect(
      respondTaskUi(actor(), row.id, row.id, response),
    ).rejects.toThrow();
    expect(
      await updateTaskUi(token, { action: "poll", id: request.id }),
    ).toEqual({ response });
    expect((await readTaskUi(actor(), row.id, row.id)).uiRequests).toEqual([]);
    await updateTaskUi(token, { action: "resolve", id: request.id });
    expect(
      await updateTaskUi(token, { action: "poll", id: request.id }),
    ).toEqual({
      response: {
        type: "extension_ui_response",
        id: request.id,
        cancelled: true,
      },
    });
    await expect(
      updateTaskUi(token, {
        action: "request",
        request: { ...request, title: "Changed" },
      }),
    ).rejects.toThrow();
  });
  it("validates native multi-question choices before persisting answers", async () => {
    const { row, token } = await dialog();
    const request = {
      type: "extension_ui_request" as const,
      id: randomUUID(),
      method: "ask" as const,
      title: "Scope",
      questions: [
        {
          id: "runtime",
          question: "Runtime?",
          options: [{ label: "OMP" }, { label: "Pi" }],
        },
        {
          id: "checks",
          question: "Checks?",
          multi: true,
          options: [{ label: "UI" }, { label: "API" }],
        },
      ],
    };
    await updateTaskUi(token, { action: "request", request });
    const response = {
      type: "extension_ui_response" as const,
      id: request.id,
      answers: [
        { id: "runtime", selectedOptions: ["OMP"] },
        { id: "checks", selectedOptions: ["UI", "API"] },
      ],
    };
    for (const answers of [
      [{ id: "runtime", selectedOptions: ["unknown"] }, response.answers[1]],
      [{ id: "runtime", selectedOptions: ["OMP", "Pi"] }, response.answers[1]],
      [response.answers[0], response.answers[0]],
      [response.answers[0]],
    ])
      await expect(
        respondTaskUi(actor(), row.id, row.id, { ...response, answers }),
      ).rejects.toThrow();
    await expect(
      respondTaskUi(actor(), row.id, row.id, { ...response, cancelled: true }),
    ).rejects.toThrow();
    await respondTaskUi(actor(), row.id, row.id, response);
    expect(
      await updateTaskUi(token, { action: "poll", id: request.id }),
    ).toEqual({ response });
    await expect(
      respondTaskUi(actor(), row.id, row.id, response),
    ).rejects.toThrow();
  });
  it("rejects cross actor, root, workspace, lease and expired dialog responses", async () => {
    const { row, token, request } = await dialog();
    const response = {
      type: "extension_ui_response" as const,
      id: request.id,
      confirmed: false,
    };
    await expect(
      readTaskUi({ ...actor(), actorId: otherUser }, row.id, row.id),
    ).rejects.toThrow();
    await expect(
      respondTaskUi(
        { ...actor(), actorId: otherUser },
        row.id,
        row.id,
        response,
      ),
    ).rejects.toThrow();
    await expect(
      respondTaskUi(actor(), randomUUID(), row.id, response),
    ).rejects.toThrow();
    await expect(
      updateTaskUi(
        { ...token, workspaceId: randomUUID() },
        { action: "poll", id: request.id },
      ),
    ).rejects.toThrow();
    await expect(
      updateTaskUi(
        { ...token, a2aLeaseToken: "stale" },
        { action: "poll", id: request.id },
      ),
    ).rejects.toThrow();
    await updateTaskUi(token, { action: "resolve", id: request.id });
    await expect(
      respondTaskUi(actor(), row.id, row.id, response),
    ).rejects.toThrow();
    await requestCancellation(grant, row.id);
    await expect(
      updateTaskUi(token, { action: "poll", id: request.id }),
    ).rejects.toThrow();
  });
  it("persists bounded latest todos and widgets after completion without blocking execution", async () => {
    const { row, token } = await dialog();
    await expect(assertLocalRuntimeToken(token)).resolves.toBeDefined();
    const todos = [
      { id: 1, text: "Native branch todo", done: false },
      {
        id: 2,
        text: "Wait for review",
        done: false,
        phase: "Release",
        status: "blocked" as const,
        blocker: "User decision",
      },
    ];
    await updateTaskUi(token, { action: "todos", todos });
    for (let i = 0; i < 70; i++)
      await updateTaskUi(token, {
        action: "request",
        request: {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message: `Notice ${i}`,
        },
      });
    await updateTaskUi(token, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setStatus",
        statusKey: "native",
        statusText: "Ready",
      },
    });
    await updateTaskUi(token, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setStatus",
        statusKey: "native",
      },
    });
    expect((await readTaskUi(actor(), row.id, row.id)).uiEvents).toHaveLength(
      63,
    );
    await finishTask(
      row.id,
      assertDefined(row.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      "Done",
    );
    const view = await readTaskUi(actor(), row.id, row.id);
    expect(view.uiRequests).toEqual([]);
    expect(view.todos).toEqual(todos);
    expect((await getTask(grant, row.id)).status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    await expect(
      updateTaskUi(token, { action: "todos", todos: [] }),
    ).rejects.toThrow();
    const queued = await submitTask(
      grant,
      request("Continue", { contextId: row.contextId }),
    );
    expect((await readTaskUi(actor(), queued.id, queued.id)).todos).toEqual(
      todos,
    );
    expect(
      (await readTaskUi(actor(), queued.id, queued.id)).uiRequests,
    ).toEqual([]);
    const next = assertDefined(await claimTask(queued.id));
    await updateTaskUi(await runtimeToken(next), {
      action: "todos",
      todos: [],
    });
    expect((await readTaskUi(actor(), queued.id, queued.id)).todos).toEqual([]);
  }, 30_000);
  it("bounds pending native dialogs but frees slots on cancellation and keeps IDs non-replayable", async () => {
    const { row, token, request } = await dialog();
    for (let i = 1; i < 32; i++)
      await updateTaskUi(token, {
        action: "request",
        request: { ...request, id: randomUUID() },
      });
    await expect(
      updateTaskUi(token, {
        action: "request",
        request: { ...request, id: randomUUID() },
      }),
    ).rejects.toThrow();
    await updateTaskUi(token, { action: "resolve", id: request.id });
    await updateTaskUi(token, {
      action: "request",
      request: { ...request, id: randomUUID() },
    });
    expect(await updateTaskUi(token, { action: "request", request })).toEqual({
      response: {
        type: "extension_ui_response",
        id: request.id,
        cancelled: true,
      },
    });
    await expect(
      updateTaskUi(token, {
        action: "request",
        request: { ...request, title: "Changed dialog" },
      }),
    ).rejects.toThrow("Native dialog ID was reused.");
    expect((await readTaskUi(actor(), row.id, row.id)).uiRequests).toHaveLength(
      32,
    );
  });
});

describe("unified native ingress mappings", () => {
  it("pauses denied collaboration and resumes within the same pinned context", async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aPolicy: { schemaVersion: 1, targets: [] } },
    });
    grant = await createLocalRootGrant(ws, agents[0], user);
    const running = await root();
    const denied = await executeLocalMcpTool(
      await runtimeToken(running),
      "a2a_send_message",
      { agentId: agents[1], request: SendMessageRequest.toJSON(request()) },
    );
    expect(denied).toMatchObject({ approvalRequired: true, accepted: true });
    expect(
      await db.a2ATask.count({ where: { parentTaskId: running.id } }),
    ).toBe(0);
    await finishTask(
      running.id,
      assertDefined(running.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      undefined,
    );
    const waiting = await getTask(grant, running.id);
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(JSON.stringify(waiting)).toContain(
      "A reply cannot grant permissions",
    );
    await submitTask(
      grant,
      request("Use only approved work instead", { taskId: running.id }),
    );
    const resumed = assertDefined(await claimTask(running.id));
    expect(resumed.contextId).toBe(running.contextId);
    expect(resumed.nativeOperationId).toBeNull();
    expect((resumed.grant as unknown as LocalA2AGrant).agentRevisionId).toBe(
      grant.agentRevisionId,
    );
  });
  const actor = () => ({
    workspaceId: ws,
    actorId: user,
    agentId: agents[0],
    slug: "local-test",
  });
  async function entry(kind: "chat" | "control" | "work" | "channel" = "chat") {
    const conversation = await db.conversation.create({
      data: {
        agentId: agents[0],
        agentRevisionId: grant.agentRevisionId,
        legacyRevisionUnresolved: false,
        title: "Existing conversation",
        messages: {
          create: [
            {
              role: "user",
              parts: [{ type: "text", text: "Historical message" }],
            },
            {
              role: "assistant",
              parts: [
                { type: "tool-call", toolName: "old-dangerous-operation" },
              ],
            },
          ],
        },
      },
    });
    let sourceId = conversation.id;
    let channelId: string | undefined;
    if (kind === "channel") {
      const channel = await db.agentChannelConnection.create({
        data: {
          workspaceId: ws,
          agentId: agents[0],
          sandboxId: sandboxes[0],
          a2aActorId: user,
          name: `Entry ${randomUUID()}`,
          platform: "weixin",
          status: "running",
          inboundTokenHash: randomUUID(),
          inboundTokenSecret: {},
          inboundTokenPrefix: "fixture",
          credentials: { token: "channel-private-fixture" },
        },
      });
      channelId = channel.id;
      await db.conversation.update({
        where: { id: conversation.id },
        data: { runtimeSessionKey: `channel:${channel.id}:fixture` },
      });
    }
    if (kind === "work")
      sourceId = (
        await db.workSession.create({
          data: {
            workspaceId: ws,
            agentId: agents[0],
            agentRevisionId: grant.agentRevisionId,
            legacyRevisionUnresolved: false,
            sandboxId: sandboxes[0],
            conversationId: conversation.id,
            a2aActorId: user,
            runtimeKind: "pi-sdk",
            status: "running",
            runtimeSnapshot: {
              workingDirectory: ".",
              deploymentIds: [],
              installedSkillIds: [],
            },
          },
        })
      ).id;
    return {
      kind,
      sourceId,
      channelId,
      workspaceId: ws,
      agentId: agents[0],
      actorId: user,
      messageId: randomUUID(),
      text: "New task only",
    };
  }
  it.each(["chat", "work"] as const)(
    "keeps existing and new %s entries on the published provider after an unapplied draft provider change",
    async (kind) => {
      const draftProvider = await db.modelProvider.create({
        data: {
          workspaceId: ws,
          name: "Unapplied draft provider",
          format: "openai",
          baseUrl: "https://draft-model.test.invalid",
          apiKey: "draft-secret-never-used",
        },
      });
      async function pinnedEntry() {
        const input = await entry(kind);
        if (kind === "work")
          await db.workSession.update({
            where: { id: input.sourceId },
            data: {
              runtimeSnapshot: {
                piPackages: [],
                workingDirectory: ".",
                deploymentIds: [],
                installedSkillIds: [],
              },
            },
          });
        return input;
      }
      try {
        const input = await pinnedEntry();
        const first = await submitAgentEntry(input, vi.fn());
        const original = assertDefined(await claimTask(first.row.id));
        const originalOptions = await localTaskOptions(
          original,
          new AbortController().signal,
          "",
        );
        const originalToken = assertDefined(
          await verifyAgentRuntimeToken(originalOptions.runtimeAccessToken),
        );
        await db.agent.update({
          where: { id: agents[0] },
          data: {
            providerId: draftProvider.id,
            model: "unapplied-draft-model",
          },
        });

        await assertLocalGrant(first.grant);
        expect(await resolveAgentRuntimeGrant(originalToken)).toMatchObject({
          runtimeKind: "pi-sdk",
          model: "fixture",
        });
        expect(await localTarget(db, ws, agents[0])).toMatchObject({
          agentRevisionId: grant.agentRevisionId,
          providerId: provider,
        });
        expect(await createLocalRootGrant(ws, agents[0], user)).toMatchObject({
          agentRevisionId: grant.agentRevisionId,
          targetBinding: grant.targetBinding,
        });
        await finishTask(
          original.id,
          assertDefined(original.leaseToken),
          TaskState.TASK_STATE_COMPLETED,
          undefined,
          textArtifact("completed before follow-up"),
        );

        for (const nextInput of [
          {
            ...input,
            messageId: randomUUID(),
            text: "Continue pinned session",
          },
          await pinnedEntry(),
        ]) {
          const accepted = await submitAgentEntry(nextInput, vi.fn());
          expect(accepted.grant.agentRevisionId).toBe(grant.agentRevisionId);
          if (nextInput.sourceId === input.sourceId)
            expect(accepted.row.contextId).toBe(first.row.contextId);
          else expect(accepted.row.contextId).not.toBe(first.row.contextId);
          const running = assertDefined(await claimTask(accepted.row.id));
          const options = await localTaskOptions(
            running,
            new AbortController().signal,
            "",
          );
          expect(options).toMatchObject({
            agentRevisionId: grant.agentRevisionId,
            provider: { id: provider },
            modelId: "fixture",
          });
          const token = assertDefined(
            await verifyAgentRuntimeToken(options.runtimeAccessToken),
          );
          expect(token.providerId).toBe(provider);
          expect(
            await resolveAgentRuntimeGrant(token, {
              providerId: provider,
              model: "fixture",
            }),
          ).toMatchObject({ runtimeKind: "pi-sdk", model: "fixture" });
          expect(
            await resolveAgentRuntimeGrant({
              ...token,
              providerId: draftProvider.id,
            }),
          ).toBeNull();
          await finishTask(
            running.id,
            assertDefined(running.leaseToken),
            TaskState.TASK_STATE_COMPLETED,
            undefined,
            textArtifact("completed on pinned provider"),
          );
        }
      } finally {
        await db.agent.update({
          where: { id: agents[0] },
          data: { providerId: provider, model: "fixture" },
        });
        await db.modelProvider.delete({ where: { id: draftProvider.id } });
      }
    },
  );
  it.each(["pi-sdk", "omp"] as const)(
    "runs authorized %s Work delegation with its pinned inputs, stream and child projection",
    async (runtimeKind) => {
      const skill = await db.installedSkill.create({
        data: {
          workspaceId: ws,
          name: "Excluded Work skill",
          slug: `work-skill-${randomUUID()}`,
          source: "custom",
          content:
            "This bound skill is excluded by the narrower Work snapshot.",
        },
      });
      await db.agentSkill.create({
        data: { agentId: agents[0], installedSkillId: skill.id },
      });
      try {
        if (runtimeKind === "omp") {
          await db.agent.update({
            where: { id: agents[0] },
            data: { runtimeKind, subagentMode: "native" },
          });
        }
        await publishFixtureAgentRevision(ws, agents[0]);
        grant = await createLocalRootGrant(ws, agents[0], user);
        const input = await entry("work");
        const work = await db.workSession.findUniqueOrThrow({
          where: { id: input.sourceId },
        });
        await db.workSession.update({
          where: { id: work.id },
          data: {
            runtimeKind,
            runtimeSnapshot: {
              piPackages: [],
              workingDirectory: "project",
              deploymentIds: [],
              installedSkillIds: [],
            },
          },
        });
        await db.conversation.update({
          where: { id: work.conversationId },
          data: { reasoningEffort: "high" },
        });
        const parts = [
          { type: "text", text: input.text },
          {
            type: "text",
            text: "Pinned reference",
            reference: { id: "reference" },
          },
          {
            type: "file",
            filename: "input.txt",
            mediaType: "text/plain",
            url: "attachment:owned-input",
          },
        ];
        await db.message.create({
          data: { conversationId: work.conversationId, role: "user", parts },
        });
        const accepted = await submitAgentEntry(input, vi.fn());
        const parent = assertDefined(await claimTask(accepted.row.id));
        const options = await localTaskOptions(
          parent,
          new AbortController().signal,
          "Authorized collaboration",
        );
        expect(options).toMatchObject({
          runtimeKind,
          conversationId: work.conversationId,
          runtimeSessionId: work.conversationId,
          workingDirectory: "project",
          reasoningEffort: "high",
          historyRequired: true,
        });
        expect(options.messages.at(-1)?.parts).toEqual(parts);
        expect(options.messages).toHaveLength(3);
        expect(options.mcpServers).toEqual([
          expect.objectContaining({ deploymentId: "toolplane-runtime" }),
        ]);
        expect(options.skills).toEqual([]);
        if (runtimeKind === "omp")
          expect(options.ompCapabilities?.mode).toBe("native");
        const token = assertDefined(
          await verifyAgentRuntimeToken(options.runtimeAccessToken),
        );
        expect(token).toMatchObject({
          a2aTaskId: parent.id,
          a2aLeaseToken: parent.leaseToken,
          deploymentIds: [],
        });
        await assertLocalRuntimeToken(token);
        const submitted = (await executePiCommunicationTool(
          token,
          "pi_a2a_submit",
          {
            target: `agent:${agents[1]}`,
            message: "Return Work child marker",
            messageId: randomUUID(),
            wait: false,
          },
        )) as { taskId: string };
        const childRun = assertDefined(await claimTask(submitted.taskId));
        expect(taskSandbox(childRun).sandboxId).not.toBe(
          taskSandbox(parent).sandboxId,
        );
        await finishTask(
          childRun.id,
          assertDefined(childRun.leaseToken),
          TaskState.TASK_STATE_COMPLETED,
          undefined,
          textArtifact("Work child marker 42"),
        );
        const result = await executePiCommunicationTool(
          token,
          "pi_a2a_status",
          {
            target: `agent:${agents[1]}`,
            taskId: childRun.id,
          },
        );
        expect(JSON.stringify(result)).toContain("Work child marker 42");
        expect(
          (await db.workSession.findUniqueOrThrow({ where: { id: work.id } }))
            .uiProjection,
        ).toMatchObject({
          activities: [
            expect.objectContaining({
              toolCallId: `platform-child:${childRun.id}`,
              status: "completed",
              output: "Work child marker 42",
            }),
          ],
        });
        const deltas: string[] = [],
          activities: unknown[] = [];
        const stop = observeWorkRuntime(work.id, {
          onTextDelta: (delta) => {
            deltas.push(delta);
          },
          onActivity: (activity) => {
            activities.push(activity);
          },
        });
        vi.mocked(runSandboxAgentTurn).mockImplementationOnce(async (turn) => {
          await turn.onTextDelta?.("Parent used Work child marker 42");
          await turn.onActivity?.({
            type: "tool",
            status: "completed",
            toolCallId: "read",
            toolName: "read",
          });
          await turn.onCommands?.([{ name: "compact" }]);
          return "Parent used Work child marker 42";
        });
        try {
          const execution = await executeLocalTask(
            parent,
            new AbortController().signal,
          );
          expect(JSON.stringify(execution.artifact)).toContain(
            "Parent used Work child marker 42",
          );
          expect(deltas).toEqual(["Parent used Work child marker 42"]);
          expect(activities).toEqual([
            expect.objectContaining({
              toolCallId: "read",
              status: "completed",
            }),
          ]);
          expect(
            await db.message.count({
              where: { conversationId: work.conversationId, role: "assistant" },
            }),
          ).toBe(1);
        } finally {
          stop();
        }
      } finally {
        await db.agentSkill.deleteMany({
          where: { agentId: agents[0], installedSkillId: skill.id },
        });
      }
    },
  );

  it("preserves Work slash commands and excludes them from model input", async () => {
    const input = {
      ...(await entry("work")),
      text: "/compact keep the marker",
    };
    const work = await db.workSession.findUniqueOrThrow({
      where: { id: input.sourceId },
    });
    await db.workSession.update({
      where: { id: work.id },
      data: {
        runtimeSnapshot: {
          piPackages: [],
          workingDirectory: ".",
          deploymentIds: [],
          installedSkillIds: [],
        },
      },
    });
    await db.message.create({
      data: {
        conversationId: work.conversationId,
        role: "user",
        parts: [{ type: "text", text: input.text }],
      },
    });
    const accepted = await submitAgentEntry(input, vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const options = await localTaskOptions(
      parent,
      new AbortController().signal,
      "",
    );
    expect(options.command).toBe(input.text);
    expect(JSON.stringify(options.messages)).not.toContain(input.text);
    expect(options.runtimeSessionId).toBe(work.conversationId);
  });

  it.each(["pi-sdk", "omp"] as const)(
    "binds a new %s Work Context to its existing conversation sandbox before authorizing model and MCP requests",
    async (runtimeKind) => {
      if (runtimeKind === "omp") {
        await db.agent.update({
          where: { id: agents[0] },
          data: { runtimeKind, subagentMode: "native" },
        });
        await publishFixtureAgentRevision(ws, agents[0]);
        grant = await createLocalRootGrant(ws, agents[0], user);
      }
      const input = await entry("work");
      await db.workSession.update({
        where: { id: input.sourceId },
        data: {
          runtimeKind,
          runtimeSnapshot: {
            piPackages: [],
            workingDirectory: ".",
            deploymentIds: [],
            installedSkillIds: [],
          },
        },
      });
      const accepted = await submitAgentEntry(input, vi.fn());
      const parent = assertDefined(await claimTask(accepted.row.id));
      const original = await db.a2AContext.findUniqueOrThrow({
        where: { id: parent.contextId },
      });
      // Reproduce the first task handoff into a Work with an existing native volume.
      // Keep the conversation mapping and clear only the newly admitted Context.
      await db.a2AContext.update({
        where: { id: parent.contextId },
        data: { sandboxId: null },
      });
      const options = await localTaskOptions(
        parent,
        new AbortController().signal,
        "",
      );
      const token = assertDefined(
        await verifyAgentRuntimeToken(options.runtimeAccessToken),
      );
      expect(token.conversationId).toBe(
        (
          await db.workSession.findUniqueOrThrow({
            where: { id: input.sourceId },
          })
        ).conversationId,
      );
      expect(token.a2aContextId).toBe(parent.contextId);
      expect(options.sandboxId).toBe(original.sandboxId);
      expect(
        (
          await db.a2AContext.findUniqueOrThrow({
            where: { id: parent.contextId },
          })
        ).sandboxId,
      ).toBe(original.sandboxId);
      expect(
        await resolveAgentRuntimeGrant(token, {
          providerId: options.provider.id,
          model: options.modelId,
        }),
      ).toMatchObject({ runtimeKind, model: options.modelId });
      expect(await resolveAgentRuntimeGrant(token)).toMatchObject({
        mcpToolPolicy: {},
      });
      const otherInput = await entry("chat");
      const other = assertDefined(
        await claimTask((await submitAgentEntry(otherInput, vi.fn())).row.id),
      );
      const otherMapping = taskSandbox(other);
      expect(
        await resolveAgentRuntimeGrant({
          ...token,
          a2aContextId: other.contextId,
        }),
      ).toBeNull();
      expect(otherMapping.sandboxId).toBe(token.sandboxId);
      const foreign = assertDefined(
        await claimTask((await child(parent)).row.id),
      );
      const foreignMapping = taskSandbox(foreign);
      expect(
        await resolveAgentRuntimeGrant({
          ...token,
          sandboxId: foreignMapping.sandboxId,
        }),
      ).toBeNull();
      await db.a2AContext.update({
        where: { id: parent.contextId },
        data: { sandboxId: foreignMapping.sandboxId },
      });
      await expect(
        localTaskOptions(parent, new AbortController().signal, ""),
      ).rejects.toThrow("sandbox mappings conflict");
      expect(await resolveAgentRuntimeGrant(token)).toBeNull();
      expect(
        (
          await db.a2AContext.findUniqueOrThrow({
            where: { id: parent.contextId },
          })
        ).sandboxId,
      ).toBe(foreignMapping.sandboxId);
    },
  );

  it("stages retained Work and reads child files using pinned revisions while enforcing live revocation", async () => {
    const input = await entry("work");
    await db.workSession.update({
      where: { id: input.sourceId },
      data: {
        runtimeSnapshot: {
          piPackages: [],
          workingDirectory: ".",
          deploymentIds: [],
          installedSkillIds: [],
        },
      },
    });
    const accepted = await submitAgentEntry(input, vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const delegated = await child(parent);
    const childRun = assertDefined(await claimTask(delegated.row.id));
    const file = await storeTaskFile(
      childRun.id,
      "retained-child-file",
      "result.txt",
      "text/plain",
      new Blob(["Retained child file marker"]).stream(),
    );
    await db.agent.updateMany({
      where: { id: { in: [agents[0], agents[1]] } },
      data: {
        systemPrompt:
          "New default must not replace the old task's file authority",
      },
    });
    const parentRevision = await publishFixtureAgentRevision(ws, agents[0]);
    const childRevision = await publishFixtureAgentRevision(ws, agents[1]);
    expect(parentRevision.id).not.toBe(accepted.grant.agentRevisionId);
    expect(childRevision.id).not.toBe(delegated.grant.agentRevisionId);
    // Even a task with zero incoming files must pass the real file-reader gate.
    // This is the same localTaskOptions path used by an already-pinned Work turn.
    const options = await localTaskOptions(
      parent,
      new AbortController().signal,
      "",
    );
    expect(options.agentRevisionId).toBe(accepted.grant.agentRevisionId);
    expect(await listTaskFiles(parent.id)).toEqual([]);
    expect(await listTaskFiles(childRun.id)).toEqual([
      expect.objectContaining({ id: file.id }),
    ]);
    const stored = await openTaskFile(childRun.id, file.id);
    expect(await new Response(stored.body).text()).toBe(
      "Retained child file marker",
    );
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    await expect(listTaskFiles(childRun.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(openTaskFile(childRun.id, file.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await db.agentSubAgent.create({
      data: { parentId: agents[0], childId: agents[1] },
    });
    expect(await listTaskFiles(childRun.id)).toHaveLength(1);
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aOutboundEnabled: false },
    });
    await expect(listTaskFiles(childRun.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it.each(["chat", "work"] as const)(
    "advances %s entry context pins explicitly, retaining history and using the new revision next turn",
    async (kind) => {
      const input = await entry(kind);
      const conversationId =
        kind === "work"
          ? (
              await db.workSession.findUniqueOrThrow({
                where: { id: input.sourceId },
              })
            ).conversationId
          : input.sourceId;
      const accepted = await submitAgentEntry(input, vi.fn());
      const parent = assertDefined(await claimTask(accepted.row.id));
      await finishTask(
        parent.id,
        assertDefined(parent.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("Retained old result"),
      );
      // This fixture drives the task ledger directly, so mirror the coordinator's
      // completed-turn transition before invoking the explicit upgrade service.
      if (kind === "work")
        await db.workSession.update({
          where: { id: input.sourceId },
          data: { status: "idle", completedAt: new Date() },
        });
      const historical = await db.a2ATask.findUniqueOrThrow({
        where: { id: parent.id },
      });
      const oldContext = await db.a2AContext.findUniqueOrThrow({
        where: { id: parent.contextId },
      });
      const otherInput = await entry("chat");
      const other = await submitAgentEntry(otherInput, vi.fn());
      const otherTask = assertDefined(await claimTask(other.row.id));
      await finishTask(
        otherTask.id,
        assertDefined(otherTask.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("Other session"),
      );
      await db.agent.update({
        where: { id: agents[0] },
        data: { systemPrompt: "Explicitly upgraded instructions" },
      });
      const revision = await publishFixtureAgentRevision(ws, agents[0]);
      const scope = {
        workspaceId: ws,
        agentId: agents[0],
        conversationId,
        targetVersion: revision.version,
      };
      await upgradeAgentConversationRevision(scope);
      expect(
        await db.a2AContext.findUniqueOrThrow({
          where: { id: parent.contextId },
        }),
      ).toMatchObject({
        id: parent.contextId,
        agentRevisionId: revision.id,
        sandboxId: oldContext.sandboxId,
      });
      expect(
        (
          await db.a2AContext.findUniqueOrThrow({
            where: { id: parent.contextId },
          })
        ).targetBinding,
      ).not.toBe(oldContext.targetBinding);
      expect(
        (
          await db.a2AContext.findUniqueOrThrow({
            where: { id: otherTask.contextId },
          })
        ).agentRevisionId,
      ).toBe(oldContext.agentRevisionId);
      expect(
        await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } }),
      ).toEqual(historical);
      expect(
        await db.a2AEntryReceipt.count({ where: { taskId: parent.id } }),
      ).toBe(1);

      // Reproduce the persisted state left by older upgrade code; same-version
      // explicit upgrade repairs only the already-authorized session's own context.
      await db.a2AContext.update({
        where: { id: parent.contextId },
        data: {
          agentRevisionId: oldContext.agentRevisionId,
          targetBinding: oldContext.targetBinding,
        },
      });
      await upgradeAgentConversationRevision(scope);
      expect(
        (
          await db.a2AContext.findUniqueOrThrow({
            where: { id: parent.contextId },
          })
        ).agentRevisionId,
      ).toBe(revision.id);
      if (kind === "work")
        await db.workSession.update({
          where: { id: input.sourceId },
          data: { status: "running" },
        });
      const next = await submitAgentEntry(
        {
          ...input,
          messageId: randomUUID(),
          text: "Continue under the explicit upgrade",
        },
        vi.fn(),
      );
      expect(next.row.contextId).toBe(parent.contextId);
      expect(next.row.grant).toMatchObject({ agentRevisionId: revision.id });
      const claimed = assertDefined(await claimTask(next.row.id));
      const options = await localTaskOptions(
        claimed,
        new AbortController().signal,
        "",
      );
      expect(options.agentRevisionId).toBe(revision.id);
      expect(options.sandboxId).toBe(oldContext.sandboxId);
      expect(options.runtimeSessionId).toBe(
        kind === "work" ? conversationId : parent.contextId,
      );
      await assertLocalRuntimeToken(
        assertDefined(
          await verifyAgentRuntimeToken(options.runtimeAccessToken),
        ),
      );
      expect(
        await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } }),
      ).toEqual(historical);
    },
  );

  it("blocks explicit session upgrade while a terminal root's descendant is still stopping", async () => {
    const input = await entry("chat");
    const accepted = await submitAgentEntry(input, vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const delegated = await child(parent);
    const childRun = assertDefined(await claimTask(delegated.row.id));
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_FAILED,
    );
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } })).state,
    ).toBe(TaskState.TASK_STATE_FAILED);
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: childRun.id } }))
        .state,
    ).toBe(TaskState.TASK_STATE_WORKING);
    await db.agent.update({
      where: { id: agents[0] },
      data: { systemPrompt: "Next revision" },
    });
    const revision = await publishFixtureAgentRevision(ws, agents[0]);
    const scope = {
      workspaceId: ws,
      agentId: agents[0],
      conversationId: input.sourceId,
      targetVersion: revision.version,
    };
    await expect(upgradeAgentConversationRevision(scope)).rejects.toMatchObject(
      { code: "busy" },
    );
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: input.sourceId },
        })
      ).agentRevisionId,
    ).toBe(accepted.grant.agentRevisionId);
    expect(
      (
        await db.a2AContext.findUniqueOrThrow({
          where: { id: parent.contextId },
        })
      ).agentRevisionId,
    ).toBe(accepted.grant.agentRevisionId);
    await finishTask(
      childRun.id,
      assertDefined(childRun.leaseToken),
      TaskState.TASK_STATE_CANCELED,
    );
    await expect(
      upgradeAgentConversationRevision(scope),
    ).resolves.toMatchObject({ version: revision.version });
  });

  it("does not inject platform delegation tools into Work without pinned outbound grants", async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: {
        a2aOutboundEnabled: false,
        a2aPolicy: { schemaVersion: 1, targets: [] },
      },
    });
    await publishFixtureAgentRevision(ws, agents[0]);
    grant = await createLocalRootGrant(ws, agents[0], user);
    const input = await entry("work");
    const parent = assertDefined(
      await claimTask((await submitAgentEntry(input, vi.fn())).row.id),
    );
    const signed = await createAgentRuntimeToken(await runtimeToken(parent));
    const client = new Client({
      name: "work-no-delegation-grant",
      version: "1",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://toolplane.test/runtime-tools"),
      {
        requestInit: { headers: { authorization: `Bearer ${signed}` } },
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return req.method === "POST"
            ? handleRuntimeTools(req, parent.id)
            : new Response(null, { status: 405 });
        },
      },
    );
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("a2a_publish_artifact");
      expect(names.some((name) => name.startsWith("pi_a2a_"))).toBe(false);
      expect(
        (
          await client.callTool({
            name: "pi_a2a_submit",
            arguments: {
              target: `agent:${agents[1]}`,
              message: "Not authorized",
              messageId: randomUUID(),
              wait: false,
            },
          })
        ).isError,
      ).toBe(true);
      expect(
        await db.a2ATask.count({ where: { parentTaskId: parent.id } }),
      ).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("cancels Work's leased descendants without reauthorizing a canceled entry, and rejects mismatches", async () => {
    const input = await entry("work");
    const accepted = await submitAgentEntry(input, vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const delegated = await child(parent);
    const runningChild = assertDefined(await claimTask(delegated.row.id));
    const nested = await child(runningChild, 3);
    const runningNested = assertDefined(await claimTask(nested.row.id));
    const tokens = await Promise.all([
      runtimeToken(parent),
      runtimeToken(runningChild, 1),
      runtimeToken(runningNested, 3),
    ]);
    await expect(
      requestWorkEntryCancellation(input.sourceId, parent.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await db.workSession.update({
      where: { id: input.sourceId },
      data: {
        status: "cancelling",
        cancelRequestedAt: new Date(),
      },
    });
    await expect(
      requestCancellation(accepted.grant, parent.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      requestWorkEntryCancellation(input.sourceId, runningChild.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    const other = await entry("work");
    await db.workSession.update({
      where: { id: other.sourceId },
      data: { cancelRequestedAt: new Date() },
    });
    await expect(
      requestWorkEntryCancellation(other.sourceId, parent.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await db.workSession.update({
      where: { id: input.sourceId },
      data: { a2aActorId: otherUser },
    });
    await expect(
      requestWorkEntryCancellation(input.sourceId, parent.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await db.workSession.update({
      where: { id: input.sourceId },
      data: { a2aActorId: user },
    });
    await requestWorkEntryCancellation(input.sourceId, parent.id);
    for (const row of [parent, runningChild, runningNested]) {
      expect(
        (await db.a2ATask.findUniqueOrThrow({ where: { id: row.id } }))
          .cancelRequestedAt,
      ).not.toBeNull();
    }
    for (const token of tokens)
      await expect(assertLocalRuntimeToken(token)).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_CANCELED,
    );
    await expect(
      requestWorkEntryCancellation(input.sourceId, parent.id),
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED },
    });
  });
  it.each(["chat", "control", "work"] as const)(
    "admits ordinary %s with both directions off, then requires explicit collaboration authority",
    async (kind) => {
      const input = await entry(kind);
      await db.agent.updateMany({
        where: { id: { in: [agents[0], agents[1]] } },
        data: {
          a2aInternalEnabled: false,
          a2aInboundEnabled: false,
          a2aOutboundEnabled: false,
        },
      });
      await expect(
        createLocalRootGrant(ws, agents[0], user),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      const accepted = await submitAgentEntry(input, vi.fn());
      expect(accepted.row.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      expect(accepted.row.executionBackend).toBe("pi-sdk");
      expect(accepted.grant.ownerKey).not.toBe(grant.ownerKey);
      expect(
        (await getConsoleTaskTree(actor(), accepted.row.id)).selectedTask.id,
      ).toBe(accepted.row.id);
      await expect(
        getConsoleTaskTree({ ...actor(), actorId: otherUser }, accepted.row.id),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      const claimed = assertDefined(await claimTask(accepted.row.id));
      await assertLocalGrant(accepted.grant);
      await expect(child(claimed)).rejects.toThrow();
      // The immutable entry revision already authorizes this edge. Live outbound still
      // needs explicit approval; the child's inbound switch governs only direct ingress.
      await db.agent.update({
        where: { id: agents[0] },
        data: { a2aOutboundEnabled: true },
      });
      const delegated = await child(claimed);
      const childRun = assertDefined(await claimTask(delegated.row.id));
      expect((await getTask(delegated.grant, childRun.id)).status?.state).toBe(
        TaskState.TASK_STATE_WORKING,
      );
      expect(
        (await getConsoleTaskTree(actor(), claimed.id, childRun.id))
          .selectedTask.id,
      ).toBe(childRun.id);
      await expect(
        childGrant(claimed.id, assertDefined(claimed.leaseToken), agents[4]),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      const token = await runtimeToken(claimed);
      await expect(assertLocalRuntimeToken(token)).resolves.toBeDefined();
      expect(
        await executeLocalMcpTool(token, "a2a_list_agents", {}),
      ).toMatchObject({
        agents: expect.arrayContaining([{ id: agents[1], name: "Agent 1" }]),
      });
      const childToken = await runtimeToken(childRun, 1);
      await expect(assertLocalRuntimeToken(childToken)).resolves.toBeDefined();
      await finishTask(
        childRun.id,
        assertDefined(childRun.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("Approved child result"),
      );
      expect((await getTask(delegated.grant, childRun.id)).status?.state).toBe(
        TaskState.TASK_STATE_COMPLETED,
      );
      await finishTask(
        claimed.id,
        assertDefined(claimed.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("Done"),
      );
      expect(
        (await getTask(accepted.grant, accepted.row.id)).status?.state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
      const next = await submitAgentEntry(
        { ...input, messageId: randomUUID(), text: "Continue" },
        vi.fn(),
      );
      expect(next.row.contextId).toBe(accepted.row.contextId);
    },
  );
  it("revokes ordinary-entry descendants and runtime credentials when a selected edge is removed", async () => {
    await db.agent.updateMany({
      where: { id: { in: agents } },
      data: { a2aInternalEnabled: false },
    });
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInboundEnabled: false },
    });
    const accepted = await submitAgentEntry(await entry(), vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const delegated = await child(parent);
    const childRun = assertDefined(await claimTask(delegated.row.id));
    const descendant = await child(childRun, 3);
    const descendantRun = assertDefined(await claimTask(descendant.row.id));
    const childToken = await runtimeToken(childRun, 1),
      descendantToken = await runtimeToken(descendantRun, 3);
    for (const token of [childToken, descendantToken]) {
      await expect(assertLocalRuntimeToken(token)).resolves.toBeDefined();
      expect(await isAgentRuntimeGrantCurrent(token)).toBe(true);
    }
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    for (const authority of [delegated.grant, descendant.grant])
      await expect(assertLocalGrant(authority)).rejects.toThrow();
    for (const token of [childToken, descendantToken]) {
      await expect(assertLocalRuntimeToken(token)).rejects.toThrow();
      expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    }
    await expect(
      executeLocalMcpTool(await runtimeToken(parent), "a2a_get_task", {
        taskId: childRun.id,
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      executeLocalMcpTool(childToken, "a2a_get_task", {
        taskId: descendantRun.id,
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      finishTask(
        descendantRun.id,
        assertDefined(descendantRun.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("Revoked result"),
      ),
    ).rejects.toThrow();
  });
  it("does not expose ordinary chat tasks to explicit A2A even after opt-in", async () => {
    const input = await entry();
    const accepted = await submitAgentEntry(input, vi.fn());
    await expect(getTask(grant, accepted.row.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(
      (await getConsoleTaskTree(actor(), accepted.row.id)).selectedTask.id,
    ).toBe(accepted.row.id);
    await db.conversation.delete({ where: { id: input.sourceId } });
    await expect(
      getConsoleTaskTree(actor(), accepted.row.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it("executes a normal chat Task through the worker with A2A disabled", async () => {
    const input = await entry();
    await db.agent.update({
      where: { id: agents[0] },
      data: {
        a2aInternalEnabled: false,
        a2aInboundEnabled: false,
        a2aOutboundEnabled: false,
      },
    });
    await startAgentWorker();
    try {
      const accepted = await submitAgentEntry(input, vi.fn());
      expect(accepted.row.executionBackend).toBe("pi-sdk");
      const executor = vi.fn(async () => ({
        state: TaskState.TASK_STATE_COMPLETED,
        artifact: textArtifact("Chat reply"),
      }));
      await executeAgentTask(accepted.row.id, executor);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(
        (await getTask(accepted.grant, accepted.row.id)).status?.state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      stopAgentWorker();
    }
  });
  it.each(["chat", "control", "work", "channel"] as const)(
    "maps %s to Task and Context without executing old history",
    async (kind) => {
      const input = {
        ...(await entry(kind)),
        text: "New task only password=fixture-entry-private",
      };
      const count = await db.conversation.count({
        where: { agentId: agents[0] },
      });
      const accepted = await submitAgentEntry(input, vi.fn());
      expect(accepted.row.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      expect(accepted.row.executionBackend).toBe("pi-sdk");
      expect(
        (accepted.row.grant as unknown as LocalA2AGrant).entryPolicy?.kind,
      ).toBe(kind);
      expect(Task.fromJSON(accepted.row.snapshot).history).toHaveLength(1);
      expect(JSON.stringify(accepted.row.snapshot)).not.toContain(
        "old-dangerous-operation",
      );
      expect(
        await db.conversation.count({ where: { agentId: agents[0] } }),
      ).toBe(count);
      expect(
        await db.a2AEntryBinding.count({
          where: { lastTaskId: accepted.row.id },
        }),
      ).toBe(1);
      expect(
        await db.a2AEntryReceipt.count({ where: { taskId: accepted.row.id } }),
      ).toBe(1);
      const events = await db.logEvent.findMany({
        where: { workspaceId: ws },
        include: { detail: true },
      });
      for (const privateText of [
        "fixture-entry-private",
        "channel-private-fixture",
        "Historical message",
        "old-dangerous-operation",
      ])
        expect(JSON.stringify(events)).not.toContain(privateText);
    },
  );
  it("retries the initial message after acceptance without manufacturing different context identifiers", async () => {
    const input = await entry();
    const first = await submitAgentEntry(input, vi.fn());
    const duplicate = await submitAgentEntry(input, vi.fn());
    expect(duplicate.row.id).toBe(first.row.id);
    expect(duplicate.replay).toBe(true);
    await expect(
      submitAgentEntry({ ...input, text: "changed" }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitAgentEntry({ ...input, messageId: randomUUID() }, vi.fn()),
    ).rejects.toThrow();
    expect(
      await db.a2AEntryReceipt.count({ where: { taskId: first.row.id } }),
    ).toBe(1);
  });
  it("replays a durable Pi entry receipt without submitting a second task", async () => {
    const input = await entry();
    const policy = await db.$transaction(async (tx) =>
      createEntryPolicy(tx, grant, {
        kind: input.kind,
        sourceId: input.sourceId,
      }),
    );
    const legacyGrant = { ...grant, entryPolicy: policy };
    const messageId = `entry-${createHash("sha256")
      .update(JSON.stringify([input.kind, input.sourceId, input.messageId]))
      .digest("hex")}`;
    const original = await submitTask(
      legacyGrant,
      SendMessageRequest.fromJSON({
        message: {
          messageId,
          role: "ROLE_USER",
          parts: [{ text: input.text }],
        },
        configuration: { returnImmediately: true },
      }),
    );
    const binding = await db.a2AEntryBinding.create({
      data: {
        ownerKey: localOwnerKey(ws, agents[0], user),
        kind: input.kind,
        sourceId: input.sourceId,
        contextId: original.contextId,
        lastTaskId: original.id,
      },
    });
    await db.a2AEntryReceipt.create({
      data: {
        bindingId: binding.id,
        messageId: input.messageId,
        inputHash: createHash("sha256")
          .update(JSON.stringify([input.text]))
          .digest("hex"),
        taskId: original.id,
      },
    });
    await db.agent.update({
      where: { id: agents[0] },
      data: {
        a2aInternalEnabled: false,
        a2aInboundEnabled: false,
        a2aOutboundEnabled: false,
      },
    });
    const replay = await submitAgentEntry(input, vi.fn());
    expect(replay).toMatchObject({
      row: { id: original.id, executionBackend: "pi-sdk" },
      replay: true,
    });
    expect(
      (await getConsoleTaskTree(actor(), original.id)).selectedTask.id,
    ).toBe(original.id);
    expect(
      await db.a2ATask.count({ where: { context: { workspaceId: ws } } }),
    ).toBe(1);
    await expect(
      submitAgentEntry({ ...input, text: "changed" }, vi.fn()),
    ).rejects.toThrow("reused with different content");
  });
  it("creates a new terminal follow-up in the same context and preserves the original receipt", async () => {
    const input = await entry();
    const first = await submitAgentEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(first.row.id));
    await finishTask(
      claimed.id,
      assertDefined(claimed.leaseToken),
      3,
      undefined,
      textArtifact("completed"),
    );
    const next = await submitAgentEntry(
      { ...input, messageId: randomUUID(), text: "Follow up" },
      vi.fn(),
    );
    expect(next.row.id).not.toBe(first.row.id);
    expect(next.row.contextId).toBe(first.row.contextId);
    expect((await submitAgentEntry(input, vi.fn())).row.id).toBe(first.row.id);
    expect((await getTask(first.grant, first.row.id)).status?.state).toBe(3);
  });
  it("continues a pinned Pi INPUT_REQUIRED task with the same task and original deadline", async () => {
    const input = await entry();
    const first = await submitAgentEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(first.row.id));
    await finishTask(
      claimed.id,
      assertDefined(claimed.leaseToken),
      TaskState.TASK_STATE_INPUT_REQUIRED,
      "Which branch?",
    );
    const next = await submitAgentEntry(
      { ...input, messageId: randomUUID(), text: "main" },
      vi.fn(),
    );
    expect(next.row.id).toBe(first.row.id);
    expect(next.row.deadlineAt).toEqual(first.row.deadlineAt);
  });
  it("does not accept another workspace, target, or an unrecorded Work operator", async () => {
    const input = await entry("work");
    await expect(
      submitAgentEntry({ ...input, actorId: otherUser }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitAgentEntry({ ...input, agentId: agents[1] }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitAgentEntry({ ...input, workspaceId: "unrelated" }, vi.fn()),
    ).rejects.toThrow();
    await db.workSession.update({
      where: { id: input.sourceId },
      data: { a2aActorId: null },
    });
    await expect(submitAgentEntry(input, vi.fn())).rejects.toThrow();
  });
  it("rechecks a Work cancellation for root and child tools rather than inheriting old authority", async () => {
    const input = await entry("work");
    const accepted = await submitAgentEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(accepted.row.id));
    const child = await childGrant(
      claimed.id,
      assertDefined(claimed.leaseToken),
      agents[1],
    );
    await db.workSession.update({
      where: { id: input.sourceId },
      data: { cancelRequestedAt: new Date() },
    });
    await expect(assertLocalGrant(accepted.grant)).rejects.toThrow();
    await expect(assertLocalGrant(child)).rejects.toThrow();
    await expect(readTaskUi(actor(), claimed.id, claimed.id)).rejects.toThrow();
  });
  it("separates different users on a shared conversation without borrowing their context", async () => {
    const input = await entry();
    const first = await submitAgentEntry(input, vi.fn());
    const second = await submitAgentEntry(
      { ...input, actorId: otherUser },
      vi.fn(),
    );
    expect(second.row.contextId).not.toBe(first.row.contextId);
    await expect(getTask(second.grant, first.row.id)).rejects.toThrow();
  });
  it("binds channels to an explicit operator and revokes the whole delegated chain", async () => {
    const channel = await db.agentChannelConnection.create({
      data: {
        workspaceId: ws,
        agentId: agents[0],
        platform: "telegram",
        name: "Fixture",
        status: "running",
        inboundTokenHash: randomUUID(),
        inboundTokenSecret: {},
        inboundTokenPrefix: "test",
      },
    });
    const conversation = await db.conversation.create({
      data: {
        agentId: agents[0],
        agentRevisionId: grant.agentRevisionId,
        legacyRevisionUnresolved: false,
        runtimeSessionKey: `channel:${channel.id}:telegram:chat`,
      },
    });
    const input = {
      kind: "channel" as const,
      sourceId: conversation.id,
      channelId: channel.id,
      workspaceId: ws,
      agentId: agents[0],
      actorId: user,
      messageId: "channel-message",
      text: "New task",
    };
    await expect(submitAgentEntry(input, vi.fn())).rejects.toThrow();
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: user },
    });
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInboundEnabled: false },
    });
    const accepted = await submitAgentEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(accepted.row.id));
    const child = await childGrant(
      claimed.id,
      assertDefined(claimed.leaseToken),
      agents[1],
    );
    const credential = await runtimeToken(claimed);
    await updateTaskUi(credential, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: "channel-dialog",
        method: "input",
        title: "Native input",
      },
    });
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: null },
    });
    await expect(assertLocalGrant(accepted.grant)).rejects.toThrow();
    await expect(assertLocalGrant(child)).rejects.toThrow();
    await expect(readTaskUi(actor(), claimed.id, claimed.id)).rejects.toThrow();
  });
  it("rolls back bindings and receipts when native admission fails", async () => {
    const input = await entry();
    const real = db.$transaction.bind(db);
    const spy = vi.spyOn(db, "$transaction");
    spy.mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>) =>
      real(async (tx) => {
        const original = tx.a2AEntryReceipt.create;
        tx.a2AEntryReceipt.create = vi
          .fn()
          .mockRejectedValue(new Error("disk failure"));
        try {
          return await fn(tx);
        } finally {
          tx.a2AEntryReceipt.create = original;
        }
      })) as typeof db.$transaction);
    await expect(submitAgentEntry(input, vi.fn())).rejects.toThrow(
      "disk failure",
    );
    spy.mockRestore();
    expect(
      await db.a2AEntryBinding.count({ where: { sourceId: input.sourceId } }),
    ).toBe(0);
    expect(
      await db.a2ATask.count({ where: { context: { workspaceId: ws } } }),
    ).toBe(0);
  });
  it("rejects silent attachment dropping and never reports a failed task as success", async () => {
    expect(() =>
      latestEntryText({
        role: "user",
        parts: [
          { type: "text", text: "hello" },
          { type: "file", url: "secret" },
        ],
      }),
    ).toThrow();
    expect(
      latestEntryText({
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe("hello");
    expect(() =>
      agentEntryResult(
        Task.fromJSON({ id: "failed", status: { state: "TASK_STATE_FAILED" } }),
        "/task",
      ),
    ).toThrow();
  });
});

describe("independent platform and native subagents", () => {
  const nativePolicy = { maxConcurrency: 4, maxDepth: 3 };
  const save = (native: boolean, agentIds: string[] = []) =>
    savePlatformSubagents(ws, user, agents[0], {
      native,
      agentIds,
      nativePolicy,
    });
  type Option = {
    id: string;
    checked: boolean;
    disabled?: boolean;
    reason?: string;
  };

  it("reports precise readiness, rejects new unready children and keeps existing edges", async () => {
    await db.agent.update({
      where: { id: agents[1] },
      data: { a2aInboundEnabled: false },
    });
    const draft = await db.agent.create({
      data: {
        workspaceId: ws,
        slug: `draft-${randomUUID()}`,
        name: "Unpublished child",
        runtimeKind: "omp",
      },
    });
    await db.sandbox.update({
      where: { id: sandboxes[2] },
      data: { network: "none" },
    });
    try {
      const options = (await listPlatformSubagents(ws, user, agents[0]))
        .agents as Option[];
      expect(options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: agents[2],
            checked: true,
            disabled: false,
            reason: "SUBAGENT_SANDBOX_REQUIRED",
          }),
          expect.objectContaining({
            id: draft.id,
            checked: false,
            disabled: true,
            reason: "SUBAGENT_REVISION_UNAVAILABLE",
          }),
        ]),
      );
      // A disabled inbound switch is not a delegation readiness problem.
      expect(options.find((option) => option.id === agents[1])).toEqual(
        expect.not.objectContaining({ reason: expect.anything() }),
      );
      await expect(save(false, [agents[1], draft.id])).rejects.toMatchObject({
        code: "SUBAGENT_REVISION_UNAVAILABLE",
      });
      await save(false, [agents[1], agents[2]]);
      expect(
        await db.agentSubAgent.count({ where: { parentId: agents[0] } }),
      ).toBe(2);
      expect(
        (await db.agent.findUniqueOrThrow({ where: { id: agents[1] } }))
          .a2aInboundEnabled,
      ).toBe(false);
    } finally {
      await db.sandbox.update({
        where: { id: sandboxes[2] },
        data: { network: "isolated" },
      });
    }
  });

  it("rejects invalid, self, cyclic, cross-workspace and unauthorized selections", async () => {
    expect(
      SubagentSettingsSchema.safeParse({
        native: "yes",
        agentIds: [],
        nativePolicy,
      }).success,
    ).toBe(false);
    for (const policy of [
      { maxConcurrency: 0, maxDepth: 3 },
      { maxConcurrency: 9, maxDepth: 3 },
      { maxConcurrency: 4, maxDepth: 0 },
      { maxConcurrency: 4, maxDepth: 5 },
    ])
      expect(
        SubagentSettingsSchema.safeParse({
          native: true,
          agentIds: [],
          nativePolicy: policy,
        }).success,
      ).toBe(false);
    await expect(save(true)).rejects.toMatchObject({
      code: "SUBAGENT_NATIVE_OMP_REQUIRED",
    });
    await expect(save(false, [agents[0]])).rejects.toMatchObject({
      code: "SUBAGENT_SELF",
    });
    await expect(
      savePlatformSubagents(ws, user, agents[4], {
        native: false,
        agentIds: [agents[0]],
        nativePolicy,
      }),
    ).rejects.toMatchObject({ code: "SUBAGENT_CYCLE" });
    await expect(
      savePlatformSubagents(ws, otherUser, agents[0], {
        native: false,
        agentIds: [],
        nativePolicy,
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    const foreign = await db.workspace.create({
      data: {
        slug: `foreign-mode-${randomUUID()}`,
        name: "Foreign",
        ownerId: otherUser,
      },
    });
    try {
      const target = await db.agent.create({
        data: {
          workspaceId: foreign.id,
          slug: "foreign",
          name: "Foreign",
          runtimeKind: "omp",
        },
      });
      await expect(save(false, [target.id])).rejects.toMatchObject({
        code: "SUBAGENT_FORBIDDEN",
      });
      await expect(
        listPlatformSubagents(ws, user, target.id),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        listPlatformSubagents(foreign.id, user, target.id),
      ).rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it("enables native tasks and platform delegation together without touching remote authority", async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: { runtimeKind: "omp" },
    });
    const platform = await publishFixtureAgentRevision(ws, agents[0]);
    const {
      subagentMode: _mode,
      nativeSubagentPolicy: _policy,
      ...legacy
    } = platform.config;
    expect(AgentRevisionConfigSchema.parse(legacy)).toEqual(legacy);
    expect(marketReleaseChecksum(AgentRevisionConfigSchema.parse(legacy))).toBe(
      marketReleaseChecksum(legacy),
    );
    const remote = await db.remoteA2AAgent.create({
      data: {
        workspaceId: ws,
        name: "Remote",
        cardUrl: "https://remote.test/.well-known/agent-card.json",
        rpcUrl: "https://remote.test/rpc",
        card: {},
        enabled: true,
        allowedAgentIds: [agents[0], agents[1]],
      },
    });
    expect(await save(true, [agents[1]])).toMatchObject({
      native: true,
      nativePolicy,
    });
    expect(
      (await db.remoteA2AAgent.findUniqueOrThrow({ where: { id: remote.id } }))
        .allowedAgentIds,
    ).toEqual([agents[0], agents[1]]);
    const both = await publishFixtureAgentRevision(ws, agents[0]);
    expect(both.config).toMatchObject({
      subagentMode: "native",
      nativeSubagentPolicy: nativePolicy,
      subagents: [],
      a2a: { outboundEnabled: true },
    });
    expect(both.config.a2a.policy.targets).toEqual([
      expect.objectContaining({ kind: "local", targetId: agents[1] }),
    ]);
    expect(
      AgentRevisionConfigSchema.safeParse({
        ...both.config,
        nativeSubagentPolicy: undefined,
      }).success,
    ).toBe(false);
    expect(
      AgentRevisionConfigSchema.safeParse({
        ...both.config,
        subagentMode: "invalid",
      }).success,
    ).toBe(false);
    grant = await createLocalRootGrant(ws, agents[0], user);
    const parent = await root();
    expect(
      (await childGrant(parent.id, assertDefined(parent.leaseToken), agents[1]))
        .agentId,
    ).toBe(agents[1]);
    const token = await runtimeToken(parent);
    expect(await executeLocalMcpTool(token, "a2a_list_agents", {})).toEqual({
      agents: [{ id: agents[1], name: "Agent 1" }],
    });
    const signed = await createAgentRuntimeToken(token);
    const client = new Client({
      name: "native-and-platform-test",
      version: "1",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://toolplane.test/runtime-tools"),
      {
        requestInit: { headers: { authorization: `Bearer ${signed}` } },
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return req.method === "POST"
            ? handleRuntimeTools(req, parent.id)
            : new Response(null, { status: 405 });
        },
      },
    );
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("pi_a2a_submit");
    } finally {
      await client.close();
    }
    expect(agentPermissionAdditions(platform.config, both.config)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "delegation", resourceId: "native" }),
      ]),
    );
    expect(agentPermissionAdditions(both.config, both.config)).toEqual([]);
    const expanded = AgentRevisionConfigSchema.parse({
      ...both.config,
      nativeSubagentPolicy: { maxConcurrency: 8, maxDepth: 4 },
    });
    expect(
      diffAgentRevisions(both, { version: both.version + 1, config: expanded }),
    ).toMatchObject({ changedFields: ["a2a"], grantsNewPermissions: true });
    expect(
      diffAgentRevisions({ version: 1, config: expanded }, both),
    ).toMatchObject({ changedFields: ["a2a"], grantsNewPermissions: false });
  });

  it("keeps remote-only outbound as configured when saving the selection", async () => {
    const remoteOnly = {
      kind: "remote" as const,
      targetId: "remote-only",
      capabilityIds: [],
      maxCalls: 1,
      maxDepth: 1,
      maxConcurrent: 1,
      timeoutSeconds: 60,
      maxInputBytes: 1024,
      dataAllowance: "text_only" as const,
    };
    await db.agent.update({
      where: { id: agents[0] },
      data: {
        a2aOutboundEnabled: false,
        a2aPolicy: { schemaVersion: 1, targets: [remoteOnly] },
      },
    });
    await save(false);
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: agents[0] } }),
    ).toMatchObject({
      a2aOutboundEnabled: false,
      a2aPolicy: { schemaVersion: 1, targets: [remoteOnly] },
    });
    await save(false, [agents[1]]);
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agents[0] } }))
        .a2aOutboundEnabled,
    ).toBe(true);
  });

  it("keeps sessions on their pinned native setting after the draft changes", async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: { runtimeKind: "omp" },
    });
    await save(true);
    const native = await publishFixtureAgentRevision(ws, agents[0]);
    const conversation = await db.conversation.create({
      data: {
        agentId: agents[0],
        agentRevisionId: native.id,
        legacyRevisionUnresolved: false,
      },
    });
    await save(false, [agents[1]]);
    const platform = await publishFixtureAgentRevision(ws, agents[0]);
    const live = await db.agent.findUniqueOrThrow({ where: { id: agents[0] } });
    expect((await resolvePinnedAgent(live, native.id)).subagentMode).toBe(
      "native",
    );
    expect(
      (await requireAgentRevision(db, agents[0], platform.id)).config
        .subagentMode,
    ).toBe("platform");
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).agentRevisionId,
    ).toBe(native.id);
  });
});
