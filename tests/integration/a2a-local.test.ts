// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { createHash, randomUUID } from "node:crypto";
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
  checkNativeToolApproval,
  decideNativeToolApproval,
  listNativeToolApprovals,
  nativeApprovalHash,
} from "@/lib/a2a/tool-approvals";
import { publishLocalArtifact } from "@/lib/a2a/local-artifacts";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import {
  createLocalRootGrant,
  createLocalEntryGrant,
  childGrant,
  assertLocalGrant,
  LOCAL_LIMITS,
  localOwnerKey,
} from "@/lib/a2a/local-policy";
import { createEntryPolicy } from "@/lib/a2a/entry-policy";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import {
  submitTask,
  claimTask,
  bindPiHarnessOperation,
  finishTask,
  getTask,
  getTaskRow,
  requestCancellation,
  eventsAfter,
} from "@/lib/a2a/store";
import type { A2ATask } from "@prisma/client";
import {
  requestLocalWait,
  requestLocalInput,
  reconcileLocalWaits,
} from "@/lib/a2a/local-continuation";
import { textArtifact } from "@/lib/a2a/model";
import {
  executeA2ATask,
  startA2AWorker,
  stopA2AWorker,
} from "@/lib/a2a/worker";
import {
  createAgentRuntimeToken,
  type AgentRuntimeTokenPayload,
} from "@/lib/agents/runtime-access";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { handleLocalMcp } from "@/lib/a2a/local-mcp";
import { executeLocalMcpTool } from "@/lib/a2a/local-mcp-tools";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";
import { isAgentRuntimeGrantCurrent } from "@/lib/agents/runtime-grant";
import { submitNativeEntry } from "@/lib/a2a/ingress";
import { localAgentCard } from "@/lib/a2a/local-http";

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
vi.mock("@/lib/a2a/worker", async (original) => ({
  ...(await original<typeof import("@/lib/a2a/worker")>()),
  wakeA2AWorker: vi.fn(),
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
async function child(
  parent: Awaited<ReturnType<typeof root>>,
  index = 1,
  input = request(),
) {
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
function runtimeToken(
  parent: Awaited<ReturnType<typeof root>>,
  index = 0,
): AgentRuntimeTokenPayload {
  return {
    workspaceId: ws,
    agentId: agents[index],
    sandboxId: sandboxes[index],
    providerId: provider,
    deploymentIds: [],
    exp: Math.floor(Date.now() / 1000) + 300,
    a2aTaskId: parent.id,
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
        runtimeKind: ["claude-code", "claude-code", "dsh", "hermes-rpc", "pi"][
          i
        ],
        providerId: provider,
        model: "fixture",
        a2aInternalEnabled: true,
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    agents.push(agent.id);
    sandboxes.push(sandbox.id);
  }
});
beforeEach(async () => {
  await db.logEvent.deleteMany({ where: { workspaceId: ws } });
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
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
    data: { a2aInternalEnabled: true, systemPrompt: null },
  });
  // Legacy joins/questions use a non-Pi root; ingress tests explicitly select Pi below.
  await db.agent.update({
    where: { id: agents[0] },
    data: { runtimeKind: "claude-code" },
  });
  await db.workspace.update({ where: { id: ws }, data: { status: "active" } });
  await db.user.update({ where: { id: user }, data: { status: "active" } });
  grant = await createLocalRootGrant(ws, agents[0], user);
});
afterAll(async () => {
  stopA2AWorker();
  if (ws) {
    await db.logEvent.deleteMany({ where: { workspaceId: ws } });
    await db.auditEvent.deleteMany({ where: { workspaceId: ws } });
    await db.workspace.delete({ where: { id: ws } });
  }
  await db.user.deleteMany({
    where: { id: { in: [user, otherUser].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("local Agent authorization and legacy continuations", () => {
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
  it("authorizes selected children without their public opt-in and rejects missing edges", async () => {
    await db.agent.update({
      where: { id: agents[1] },
      data: { a2aInternalEnabled: false },
    });
    const parent = await root();
    const delegated = await child(parent);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(TaskState.TASK_STATE_SUBMITTED);
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
    const token = runtimeToken(parent);
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
    const token = await createAgentRuntimeToken(runtimeToken(parent));
    const url = `https://toolplane.test/api/v1/agent-runtime/a2a/${parent.id}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return req.method === "POST"
          ? handleLocalMcp(req, parent.id)
          : new Response(null, { status: 405 });
      },
    });
    const client = new Client({ name: "local-a2a-test", version: "1" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(9);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "a2a_list_remote_agents",
          "a2a_send_remote_message",
        ]),
      );
      const args = {
        agentId: agents[1],
        request: SendMessageRequest.toJSON(request()),
      };
      const result = await client.callTool({
        name: "a2a_send_message",
        arguments: args,
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("TASK_STATE_SUBMITTED");
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      const event = await db.logEvent.findFirstOrThrow({
        where: {
          workspaceId: ws,
          eventName: "a2a.request",
          toolName: "a2a_send_message",
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
      const rejected = await client.callTool({
        name: "a2a_get_task",
        arguments: { taskId: randomUUID() },
      });
      expect(rejected.isError).toBe(true);
      const failure = await db.logEvent.findFirstOrThrow({
        where: {
          workspaceId: ws,
          eventName: "a2a.request",
          toolName: "a2a_get_task",
        },
        include: { detail: true },
      });
      expect(failure).toMatchObject({
        outcome: "error",
        httpStatus: null,
        attributes: { data: { a2a: { taskId: parent.id } } },
      });
      expect(failure.detail?.data).toMatchObject({
        payload: { response: rejected },
      });
    } finally {
      await client.close();
    }
  });
  it("blocks ordinary runtime tokens and cross-task MCP access", async () => {
    const parent = await root();
    const payload = runtimeToken(parent);
    const ordinary = {
      ...payload,
      a2aTaskId: undefined,
      a2aLeaseToken: undefined,
    };
    await expect(
      executeLocalMcpTool(ordinary, "a2a_list_agents", {}),
    ).rejects.toThrow();
    const token = await createAgentRuntimeToken(payload);
    const req = new Request("https://toolplane.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect((await handleLocalMcp(req, "wrong-task")).status).toBe(401);
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
    await executeA2ATask(initial.id, async (parent, signal) => {
      signal.throwIfAborted();
      const b = await child(parent);
      childId = b.row.id;
      await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
        childId,
      ]);
      return { state: 3, artifact: textArtifact("Delegated") };
    });
    await executeA2ATask(childId, async () => ({
      state: 3,
      artifact: textArtifact("Specialist result"),
    }));
    await reconcileLocalWaits();
    await executeA2ATask(initial.id, async (resumed) => {
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
    await startA2AWorker();
    stopA2AWorker();
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
      data: { a2aInternalEnabled: false },
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
    // Reset the worker's stop flag without letting its timer run the fixture.
    await startA2AWorker();
    const queued = await submitTask(grant, request());
    let release!: () => void;
    const lock = withSandboxExecutionLease(
      sandboxes[0],
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
      await executeA2ATask(queued.id, executor);
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
    await executeA2ATask(queued.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(assertDefined((await getTask(grant, queued.id)).status).state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    stopA2AWorker();
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
  it("rejects a stale console tree after its selected edge is revoked", async () => {
    const parent = await root();
    const delegated = await child(parent);
    await db.agentSubAgent.delete({
      where: { parentId_childId: { parentId: agents[0], childId: agents[1] } },
    });
    await expect(getConsoleTaskTree(actor(), parent.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
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
    await publishLocalArtifact(task.id, assertDefined(task.leaseToken), {
      artifactId: "patch-v1",
      name: "fix.patch",
      parts: [
        {
          raw: Buffer.from("diff --git").toString("base64"),
          mediaType: "text/x-diff",
        },
      ],
    });
    const wire = Task.toJSON(await getTask(grant, task.id)) as {
      artifacts: Array<{ parts: unknown[] }>;
    };
    expect(wire.artifacts[0].parts[0]).toMatchObject({
      data: { a: "first", z: "last" },
      mediaType: "application/json",
    });
    expect(wire.artifacts[1].parts[0]).toMatchObject({
      raw: Buffer.from("diff --git").toString("base64"),
      mediaType: "text/x-diff",
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

describe("native tool approval decisions", () => {
  const actor = () => ({
    workspaceId: ws,
    actorId: user,
    agentId: agents[0],
    slug: "local-test",
  });
  async function pending() {
    const conversation = await db.conversation.create({
      data: { agentId: agents[0], title: "Interactive approval" },
    });
    const entry = await createEntryPolicy(db, grant, {
      kind: "chat",
      sourceId: conversation.id,
    });
    grant = await createLocalEntryGrant(db, ws, agents[0], user, entry);
    const row = await root();
    const token = { ...runtimeToken(row), a2aApprovalRequired: true as const };
    await checkNativeToolApproval(token, { action: "ready" });
    const input = {
      action: "check" as const,
      callId: randomUUID(),
      toolName: "bash",
      input: { command: "touch approved-only.txt" },
    };
    const result = await checkNativeToolApproval(token, input);
    if (!result.approvalId || !result.inputHash)
      throw new Error("Missing approval");
    return {
      row,
      token,
      input,
      result: {
        ...result,
        approvalId: result.approvalId,
        inputHash: result.inputHash,
      },
    };
  }
  it("blocks model/runtime access until the pre-tool hook is registered", async () => {
    const row = await root();
    const token = { ...runtimeToken(row), a2aApprovalRequired: true as const };
    await expect(assertLocalRuntimeToken(token)).rejects.toThrow();
    await checkNativeToolApproval(token, { action: "ready" });
    await expect(assertLocalRuntimeToken(token)).resolves.toBeDefined();
  });
  it("remains pending without a human and never turns an agent message into permission", async () => {
    const value = await pending();
    expect(value.result.status).toBe("pending");
    expect(
      (await checkNativeToolApproval(value.token, value.input)).status,
    ).toBe("pending");
    await expect(
      submitTask(grant, request("I approve", { taskId: value.row.id })),
    ).rejects.toThrow();
    expect((await getTask(grant, value.row.id)).status?.state).toBe(
      TaskState.TASK_STATE_WORKING,
    );
  });
  it("consumes an approval once for exactly the current call and arguments", async () => {
    const value = await pending();
    await decideNativeToolApproval(actor(), {
      rootTaskId: value.row.id,
      taskId: value.row.id,
      approvalId: value.result.approvalId,
      inputHash: value.result.inputHash,
      decision: "approved",
    });
    expect(
      (await checkNativeToolApproval(value.token, value.input)).status,
    ).toBe("allow");
    expect(
      (await checkNativeToolApproval(value.token, value.input)).status,
    ).toBe("deny");
    await expect(
      checkNativeToolApproval(value.token, {
        ...value.input,
        input: { command: "rm approved-only.txt" },
      }),
    ).rejects.toThrow();
  });
  it("denial and expired decisions never grant execution", async () => {
    const value = await pending();
    await decideNativeToolApproval(actor(), {
      rootTaskId: value.row.id,
      taskId: value.row.id,
      approvalId: value.result.approvalId,
      inputHash: value.result.inputHash,
      decision: "denied",
    });
    expect(
      (await checkNativeToolApproval(value.token, value.input)).status,
    ).toBe("deny");
    const second = await pending();
    await db.a2AToolApproval.update({
      where: { id: second.result.approvalId },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      decideNativeToolApproval(actor(), {
        rootTaskId: second.row.id,
        taskId: second.row.id,
        approvalId: second.result.approvalId,
        inputHash: second.result.inputHash,
        decision: "approved",
      }),
    ).rejects.toThrow();
    expect(
      (await checkNativeToolApproval(second.token, second.input)).status,
    ).toBe("deny");
  });
  it("rejects another user, a wrong root and stale input hashes", async () => {
    const value = await pending();
    const decision = {
      rootTaskId: value.row.id,
      taskId: value.row.id,
      approvalId: value.result.approvalId,
      inputHash: value.result.inputHash,
      decision: "approved" as const,
    };
    await expect(
      decideNativeToolApproval({ ...actor(), actorId: otherUser }, decision),
    ).rejects.toThrow();
    await expect(
      decideNativeToolApproval(actor(), {
        ...decision,
        rootTaskId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      decideNativeToolApproval(actor(), {
        ...decision,
        inputHash: "0".repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      listNativeToolApprovals(
        { ...actor(), actorId: otherUser },
        value.row.id,
        value.row.id,
      ),
    ).rejects.toThrow();
  });
  it("denies approved calls after cancel, configuration changes or a stale lease", async () => {
    const value = await pending();
    await decideNativeToolApproval(actor(), {
      rootTaskId: value.row.id,
      taskId: value.row.id,
      approvalId: value.result.approvalId,
      inputHash: value.result.inputHash,
      decision: "approved",
    });
    await expect(
      checkNativeToolApproval(
        { ...value.token, a2aLeaseToken: "stale" },
        value.input,
      ),
    ).rejects.toThrow();
    await requestCancellation(grant, value.row.id);
    await expect(
      checkNativeToolApproval(value.token, value.input),
    ).rejects.toThrow();
    const second = await pending();
    await db.agent.update({
      where: { id: agents[0] },
      data: { systemPrompt: "Changed authority" },
    });
    await expect(
      checkNativeToolApproval(second.token, second.input),
    ).rejects.toThrow();
  });
  it("supports parallel decisions without granting a sibling call or reopening the task", async () => {
    const value = await pending();
    const otherInput = {
      ...value.input,
      callId: randomUUID(),
      input: { command: "another-action" },
    };
    const other = await checkNativeToolApproval(value.token, otherInput);
    await decideNativeToolApproval(actor(), {
      rootTaskId: value.row.id,
      taskId: value.row.id,
      approvalId: value.result.approvalId,
      inputHash: value.result.inputHash,
      decision: "approved",
    });
    expect(
      (await checkNativeToolApproval(value.token, value.input)).status,
    ).toBe("allow");
    expect(
      (await checkNativeToolApproval(value.token, otherInput)).status,
    ).toBe("pending");
    expect(other.status).toBe("pending");
    await expect(assertLocalRuntimeToken(value.token)).resolves.toBeDefined();
  });
  it("cannot mark successful completion while an approval is unresolved", async () => {
    const value = await pending();
    await finishTask(
      value.row.id,
      assertDefined(value.row.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
    );
    expect((await getTask(grant, value.row.id)).status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    await expect(
      checkNativeToolApproval(value.token, value.input),
    ).rejects.toThrow();
  });
  it("authorizes an inbound A2A root tool once without a human and completes with its result", async () => {
    const row = await root();
    const token = { ...runtimeToken(row), a2aApprovalRequired: true as const };
    await checkNativeToolApproval(token, { action: "ready" });
    const input = {
      action: "check" as const,
      callId: randomUUID(),
      toolName: "search_12306_train_tickets",
      input: { date: "2026-09-29", origin: "贵阳", destination: "北京" },
    };
    const results = await Promise.all([
      checkNativeToolApproval(token, input),
      checkNativeToolApproval(token, input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "allow",
      "deny",
    ]);
    expect(
      await db.a2AToolApproval.findUniqueOrThrow({
        where: { id: assertDefined(results[0].approvalId) },
      }),
    ).toMatchObject({ status: "consumed", decidedBy: null, taskId: row.id });
    await expect(
      checkNativeToolApproval(token, {
        ...input,
        input: { ...input.input, destination: "上海" },
      }),
    ).rejects.toThrow();
    await finishTask(
      row.id,
      assertDefined(row.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("Train query result"),
    );
    expect((await getTask(grant, row.id)).status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });
  it.each(["cancel", "lease", "configuration", "workspace", "expiry"] as const)(
    "rejects inbound A2A tools after %s invalidation",
    async (reason) => {
      const row = await root();
      const token = {
        ...runtimeToken(row),
        a2aApprovalRequired: true as const,
      };
      await checkNativeToolApproval(token, { action: "ready" });
      if (reason === "cancel") await requestCancellation(grant, row.id);
      if (reason === "lease") token.a2aLeaseToken = "stale";
      if (reason === "configuration")
        await db.agent.update({
          where: { id: agents[0] },
          data: { a2aInternalEnabled: false },
        });
      if (reason === "workspace") token.workspaceId = randomUUID();
      if (reason === "expiry")
        await db.a2ATask.update({
          where: { id: row.id },
          data: { deadlineAt: new Date(0) },
        });
      await expect(
        checkNativeToolApproval(token, {
          action: "check",
          callId: randomUUID(),
          toolName: "read",
          input: { path: "notes.txt" },
        }),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      expect(
        await db.a2AToolApproval.count({ where: { taskId: row.id } }),
      ).toBe(0);
    },
  );
  it("authorizes a delegated tool once without a human decision and retains its owned receipt", async () => {
    const parent = await root();
    const delegated = await child(parent);
    const row = assertDefined(await claimTask(delegated.row.id));
    const token = {
      ...runtimeToken(row, 1),
      a2aApprovalRequired: true as const,
    };
    await checkNativeToolApproval(token, { action: "ready" });
    const input = {
      action: "check" as const,
      callId: randomUUID(),
      toolName: "write",
      input: { path: "result.txt", content: "delegated" },
    };
    const results = await Promise.all([
      checkNativeToolApproval(token, input),
      checkNativeToolApproval(token, input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "allow",
      "deny",
    ]);
    const receipt = await db.a2AToolApproval.findUniqueOrThrow({
      where: { id: assertDefined(results[0].approvalId) },
    });
    expect(receipt).toMatchObject({
      status: "consumed",
      decidedBy: null,
      taskId: row.id,
      leaseToken: row.leaseToken,
    });
    expect(receipt.consumedAt).not.toBeNull();
    await expect(
      checkNativeToolApproval(token, {
        ...input,
        input: { path: "other.txt", content: "changed" },
      }),
    ).rejects.toThrow();
    await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [
      row.id,
    ]);
    await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
    await reconcileLocalWaits();
    expect(
      await listNativeToolApprovals(actor(), parent.id, row.id),
    ).toMatchObject([{ status: "consumed" }]);
    await expect(
      listNativeToolApprovals(
        { ...actor(), actorId: otherUser },
        parent.id,
        row.id,
      ),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(
      (await checkNativeToolApproval(token, { ...input, callId: randomUUID() }))
        .status,
    ).toBe("allow");
  });
  it.each(["edge", "parent-cancel", "child-cancel", "lease"] as const)(
    "rejects delegated tool authorization after %s revocation",
    async (reason) => {
      const parent = await root();
      const delegated = await child(parent);
      const row = assertDefined(await claimTask(delegated.row.id));
      const token = {
        ...runtimeToken(row, 1),
        a2aApprovalRequired: true as const,
      };
      await checkNativeToolApproval(token, { action: "ready" });
      if (reason === "edge")
        await db.agentSubAgent.delete({
          where: {
            parentId_childId: { parentId: agents[0], childId: agents[1] },
          },
        });
      if (reason === "parent-cancel")
        await requestCancellation(grant, parent.id);
      if (reason === "child-cancel")
        await requestCancellation(delegated.grant, row.id);
      if (reason === "lease") token.a2aLeaseToken = "expired-lease";
      await expect(
        checkNativeToolApproval(token, {
          action: "check",
          callId: randomUUID(),
          toolName: "bash",
          input: { command: "touch forbidden.txt" },
        }),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      expect(
        await db.a2AToolApproval.count({ where: { taskId: row.id } }),
      ).toBe(0);
    },
  );
  it.each(["pending", "denied", "expired", "consumed"] as const)(
    "handles an existing %s child decision without reviving a denial",
    async (status) => {
      const parent = await root();
      const delegated = await child(parent);
      const row = assertDefined(await claimTask(delegated.row.id));
      const token = {
        ...runtimeToken(row, 1),
        a2aApprovalRequired: true as const,
      };
      await checkNativeToolApproval(token, { action: "ready" });
      const input = {
        action: "check" as const,
        callId: randomUUID(),
        toolName: "write",
        input: { path: "result.txt" },
      };
      await db.a2AToolApproval.create({
        data: {
          taskId: row.id,
          leaseToken: assertDefined(row.leaseToken),
          callId: input.callId,
          toolName: input.toolName,
          input: input.input,
          inputHash: nativeApprovalHash(input.toolName, input.input),
          status,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect((await checkNativeToolApproval(token, input)).status).toBe(
        status === "pending" ? "allow" : "deny",
      );
    },
  );
  it("canonicalizes object key order but not array order", () => {
    expect(nativeApprovalHash("tool", { a: 1, b: 2 })).toBe(
      nativeApprovalHash("tool", { b: 2, a: 1 }),
    );
    expect(nativeApprovalHash("tool", [1, 2])).not.toBe(
      nativeApprovalHash("tool", [2, 1]),
    );
    expect(() => nativeApprovalHash("tool", "x".repeat(17000))).toThrow();
  });
});

describe("unified native ingress mappings", () => {
  beforeEach(async () => {
    await db.agent.update({
      where: { id: agents[0] },
      data: { runtimeKind: "pi" },
    });
    grant = await createLocalRootGrant(ws, agents[0], user);
  });
  // Inject terminal execution only; these admission tests do not run a model or Harness.
  async function nativeProof(row: A2ATask) {
    return {
      nativeOperationId: await bindPiHarnessOperation(
        row.id,
        assertDefined(row.leaseToken),
        randomUUID(),
      ),
    };
  }
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
            sandboxId: sandboxes[0],
            conversationId: conversation.id,
            a2aActorId: user,
            runtimeKind: "pi",
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
  it.each(["chat", "control", "work"] as const)(
    "lets ordinary %s delegate, approve and complete with both switches off",
    async (kind) => {
      const { submitNativeEntry } = await import("@/lib/a2a/ingress");
      const input = await entry(kind);
      await db.agent.updateMany({
        where: { id: { in: [agents[0], agents[1]] } },
        data: { a2aInternalEnabled: false },
      });
      await expect(
        createLocalRootGrant(ws, agents[0], user),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      const accepted = await submitNativeEntry(input, vi.fn());
      expect(accepted.row.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      expect(accepted.row.executionBackend).toBe("pi-harness");
      expect(accepted.grant.ownerKey).not.toBe(grant.ownerKey);
      expect(
        (await getConsoleTaskTree(actor(), accepted.row.id)).selectedTask.id,
      ).toBe(accepted.row.id);
      await expect(
        getConsoleTaskTree({ ...actor(), actorId: otherUser }, accepted.row.id),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      const claimed = assertDefined(await claimTask(accepted.row.id));
      await assertLocalGrant(accepted.grant);
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
      const token = {
        ...runtimeToken(claimed),
        a2aApprovalRequired: true as const,
      };
      await checkNativeToolApproval(token, { action: "ready" });
      const callId = randomUUID();
      const approval = await checkNativeToolApproval(token, {
        action: "check",
        callId,
        toolName: "read",
        input: { path: "notes.txt" },
      });
      expect(approval.status).toBe("pending");
      expect(
        await listNativeToolApprovals(actor(), claimed.id, claimed.id),
      ).toHaveLength(1);
      await decideNativeToolApproval(actor(), {
        rootTaskId: claimed.id,
        taskId: claimed.id,
        approvalId: assertDefined(approval.approvalId),
        inputHash: assertDefined(approval.inputHash),
        decision: "approved",
      });
      await expect(
        decideNativeToolApproval(
          { ...actor(), actorId: otherUser },
          {
            rootTaskId: claimed.id,
            taskId: claimed.id,
            approvalId: assertDefined(approval.approvalId),
            inputHash: assertDefined(approval.inputHash),
            decision: "approved",
          },
        ),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
      expect(
        (
          await checkNativeToolApproval(token, {
            action: "check",
            callId,
            toolName: "read",
            input: { path: "notes.txt" },
          })
        ).status,
      ).toBe("allow");
      await expect(assertLocalRuntimeToken(token)).resolves.toBeDefined();
      expect(
        await executeLocalMcpTool(token, "a2a_list_agents", {}),
      ).toMatchObject({
        agents: expect.arrayContaining([{ id: agents[1], name: "Agent 1" }]),
      });
      const childToken = {
        ...runtimeToken(childRun, 1),
        a2aApprovalRequired: true as const,
      };
      await checkNativeToolApproval(childToken, { action: "ready" });
      const childInput = {
        action: "check" as const,
        callId: randomUUID(),
        toolName: "write",
        input: { path: "result.txt", content: "Approved child result" },
      };
      const childApproval = await checkNativeToolApproval(
        childToken,
        childInput,
      );
      expect(childApproval.status).toBe("allow");
      expect(
        await listNativeToolApprovals(actor(), claimed.id, childRun.id),
      ).toMatchObject([{ status: "consumed", toolName: "write" }]);
      expect(
        (await checkNativeToolApproval(childToken, childInput)).status,
      ).toBe("deny");
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
        await nativeProof(claimed),
      );
      expect(
        (await getTask(accepted.grant, accepted.row.id)).status?.state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
      const next = await submitNativeEntry(
        { ...input, messageId: randomUUID(), text: "Continue" },
        vi.fn(),
      );
      expect(next.row.contextId).toBe(accepted.row.contextId);
    },
  );
  it("revokes switches-off descendants and runtime credentials when a selected edge is removed", async () => {
    await db.agent.updateMany({
      where: { id: { in: agents } },
      data: { a2aInternalEnabled: false },
    });
    const accepted = await submitNativeEntry(await entry(), vi.fn());
    const parent = assertDefined(await claimTask(accepted.row.id));
    const delegated = await child(parent);
    const childRun = assertDefined(await claimTask(delegated.row.id));
    const descendant = await child(childRun, 3);
    const descendantRun = assertDefined(await claimTask(descendant.row.id));
    const childToken = runtimeToken(childRun, 1),
      descendantToken = runtimeToken(descendantRun, 3);
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
      executeLocalMcpTool(runtimeToken(parent), "a2a_get_task", {
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
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const accepted = await submitNativeEntry(input, vi.fn());
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
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInternalEnabled: false },
    });
    await startA2AWorker();
    try {
      const accepted = await submitNativeEntry(input, vi.fn());
      expect(accepted.row.executionBackend).toBe("pi-harness");
      const executor = vi.fn(async (row: A2ATask) => ({
        state: TaskState.TASK_STATE_COMPLETED,
        artifact: textArtifact("Chat reply"),
        ...(await nativeProof(row)),
      }));
      await executeA2ATask(accepted.row.id, executor);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(
        (await getTask(accepted.grant, accepted.row.id)).status?.state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      stopA2AWorker();
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
      const accepted = await submitNativeEntry(input, vi.fn());
      expect(accepted.row.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      expect(accepted.row.executionBackend).toBe("pi-harness");
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
      const event = await db.logEvent.findFirstOrThrow({
        where: {
          workspaceId: ws,
          eventName: "a2a.request",
          rpcMethod: "SendMessage",
        },
        include: { detail: true },
      });
      expect(event).toMatchObject({
        actorId: user,
        agentId: agents[0],
        outcome: "success",
        httpStatus: null,
        attributes: {
          data: {
            a2a: {
              entryKind: kind,
              direction: "inbound",
              transport: "entry",
              taskId: accepted.row.id,
              taskState: "TASK_STATE_SUBMITTED",
            },
          },
        },
      });
      expect(event.detail?.data).toMatchObject({
        payload: {
          request: {
            message: {
              role: "ROLE_USER",
              parts: [{ text: 'New task only password="[REDACTED]"' }],
            },
          },
          response: {
            task: {
              id: accepted.row.id,
              status: { state: "TASK_STATE_SUBMITTED" },
            },
          },
        },
      });
      expect(JSON.stringify(event)).not.toContain("fixture-entry-private");
      expect(JSON.stringify(event)).not.toContain("channel-private-fixture");
      expect(JSON.stringify(event.detail?.data)).not.toContain(
        "Historical message",
      );
      expect(JSON.stringify(event.detail?.data)).not.toContain(
        "old-dangerous-operation",
      );
    },
  );
  it("retries the initial message after acceptance without manufacturing different context identifiers", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const first = await submitNativeEntry(input, vi.fn());
    const duplicate = await submitNativeEntry(input, vi.fn());
    expect(duplicate.row.id).toBe(first.row.id);
    expect(duplicate.replay).toBe(true);
    await expect(
      submitNativeEntry({ ...input, text: "changed" }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitNativeEntry({ ...input, messageId: randomUUID() }, vi.fn()),
    ).rejects.toThrow();
    expect(
      await db.a2AEntryReceipt.count({ where: { taskId: first.row.id } }),
    ).toBe(1);
    const events = await db.logEvent.findMany({
      where: {
        workspaceId: ws,
        eventName: "a2a.request",
        rpcMethod: "SendMessage",
      },
      include: { detail: true },
    });
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event.detail?.data).toMatchObject({
        payload: { response: { task: { id: first.row.id } } },
      });
  });
  it("replays a pre-upgrade native entry without submitting a second task", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const policy = await db.$transaction(async (tx) =>
      (await import("@/lib/a2a/entry-policy")).createEntryPolicy(tx, grant, {
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
    await db.a2ATask.update({
      where: { id: original.id },
      data: { executionBackend: "legacy" },
    });
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
      data: { a2aInternalEnabled: false },
    });
    const replay = await submitNativeEntry(input, vi.fn());
    expect(replay).toMatchObject({
      row: { id: original.id, executionBackend: "legacy" },
      replay: true,
    });
    expect(
      (await getConsoleTaskTree(actor(), original.id)).selectedTask.id,
    ).toBe(original.id);
    expect(
      await db.a2ATask.count({ where: { context: { workspaceId: ws } } }),
    ).toBe(1);
    await expect(
      submitNativeEntry({ ...input, text: "changed" }, vi.fn()),
    ).rejects.toThrow("reused with different content");
  });
  it("creates a new terminal follow-up in the same context and preserves the original receipt", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const first = await submitNativeEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(first.row.id));
    await finishTask(
      claimed.id,
      assertDefined(claimed.leaseToken),
      3,
      undefined,
      textArtifact("completed"),
      await nativeProof(claimed),
    );
    const next = await submitNativeEntry(
      { ...input, messageId: randomUUID(), text: "Follow up" },
      vi.fn(),
    );
    expect(next.row.id).not.toBe(first.row.id);
    expect(next.row.contextId).toBe(first.row.contextId);
    expect((await submitNativeEntry(input, vi.fn())).row.id).toBe(first.row.id);
    expect((await getTask(first.grant, first.row.id)).status?.state).toBe(3);
  });
  it("continues a historical legacy INPUT_REQUIRED task with the same task and original deadline", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const first = await submitNativeEntry(input, vi.fn());
    await db.a2ATask.update({
      where: { id: first.row.id },
      data: { executionBackend: "legacy" },
    });
    const claimed = assertDefined(await claimTask(first.row.id));
    await finishTask(
      claimed.id,
      assertDefined(claimed.leaseToken),
      TaskState.TASK_STATE_INPUT_REQUIRED,
      "Which branch?",
    );
    const next = await submitNativeEntry(
      { ...input, messageId: randomUUID(), text: "main" },
      vi.fn(),
    );
    expect(next.row.id).toBe(first.row.id);
    expect(next.row.deadlineAt).toEqual(first.row.deadlineAt);
  });
  it("does not accept another workspace, target, or an unrecorded Work operator", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry("work");
    await expect(
      submitNativeEntry({ ...input, actorId: otherUser }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitNativeEntry({ ...input, agentId: agents[1] }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      submitNativeEntry({ ...input, workspaceId: "unrelated" }, vi.fn()),
    ).rejects.toThrow();
    await db.workSession.update({
      where: { id: input.sourceId },
      data: { a2aActorId: null },
    });
    await expect(submitNativeEntry(input, vi.fn())).rejects.toThrow();
  });
  it("rechecks a Work cancellation for root and child tools rather than inheriting old authority", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry("work");
    const accepted = await submitNativeEntry(input, vi.fn());
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
    await expect(
      listNativeToolApprovals(actor(), claimed.id, claimed.id),
    ).rejects.toThrow();
  });
  it("separates different users on a shared conversation without borrowing their context", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
    const input = await entry();
    const first = await submitNativeEntry(input, vi.fn());
    const second = await submitNativeEntry(
      { ...input, actorId: otherUser },
      vi.fn(),
    );
    expect(second.row.contextId).not.toBe(first.row.contextId);
    await expect(getTask(second.grant, first.row.id)).rejects.toThrow();
  });
  it("binds channels to an explicit operator and revokes the whole delegated chain", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
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
    await expect(submitNativeEntry(input, vi.fn())).rejects.toThrow();
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: user },
    });
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInternalEnabled: false },
    });
    await expect(submitNativeEntry(input, vi.fn())).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInternalEnabled: true },
    });
    const accepted = await submitNativeEntry(input, vi.fn());
    const claimed = assertDefined(await claimTask(accepted.row.id));
    const child = await childGrant(
      claimed.id,
      assertDefined(claimed.leaseToken),
      agents[1],
    );
    const credential = { ...runtimeToken(claimed), a2aApprovalRequired: true };
    await checkNativeToolApproval(credential, { action: "ready" });
    await checkNativeToolApproval(credential, {
      action: "check",
      callId: "channel-tool",
      toolName: "read",
      input: { secretPath: "fixture" },
    });
    await db.agentChannelConnection.update({
      where: { id: channel.id },
      data: { a2aActorId: null },
    });
    await expect(assertLocalGrant(accepted.grant)).rejects.toThrow();
    await expect(assertLocalGrant(child)).rejects.toThrow();
    await expect(
      listNativeToolApprovals(actor(), claimed.id, claimed.id),
    ).rejects.toThrow();
  });
  it("rolls back bindings and receipts when native admission fails", async () => {
    const { submitNativeEntry } = await import("@/lib/a2a/ingress");
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
    await expect(submitNativeEntry(input, vi.fn())).rejects.toThrow(
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
    const { latestEntryText, nativeEntryResult } = await import(
      "@/lib/a2a/ingress"
    );
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
      nativeEntryResult(
        Task.fromJSON({ id: "failed", status: { state: "TASK_STATE_FAILED" } }),
        "/task",
      ),
    ).toThrow();
  });
});
