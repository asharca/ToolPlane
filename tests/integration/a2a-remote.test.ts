// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  REMOTE_CARD,
  REMOTE_RPC,
  remoteCard,
  remoteTask,
} from "../fixtures/a2a-remote";
import {
  mutateRemoteRegistry,
  remoteCredential,
  remoteRegistryView,
} from "@/lib/a2a/remote-registry";
import { remoteChildGrant, assertRemoteGrant } from "@/lib/a2a/remote-policy";
import { createLocalRootGrant } from "@/lib/a2a/local-policy";
import {
  submitTask,
  claimTask,
  finishTask,
  getTask,
  getTaskRow,
  interruptTask,
  requestCancellation,
} from "@/lib/a2a/store";
import {
  requestLocalWait,
  reconcileLocalWaits,
} from "@/lib/a2a/local-continuation";
import {
  executeRemoteTask,
  reconcileRemoteTasks,
} from "@/lib/a2a/remote-executor";
import {
  executeA2ATask,
  startA2AWorker,
  stopA2AWorker,
} from "@/lib/a2a/worker";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import type { ConsoleActor } from "@/lib/a2a/console-service";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import type { A2ALogBinding } from "@/lib/observability/a2a-log";
import { withLogContext } from "@/lib/observability/context";

const network = vi.hoisted(() => ({ discover: vi.fn(), rpc: vi.fn() }));
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
vi.mock("@/lib/a2a/remote-network", async (original) => ({
  ...(await original<typeof import("@/lib/a2a/remote-network")>()),
  fetchRemoteJson: network.discover,
  // Only the network boundary is replaced; the official ClientFactory/JSONRPC transport remains unchanged.
  remoteRpcFetch:
    (url: string, token: string | undefined, _binding: A2ALogBinding) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(url);
      const rpc = await request.json();
      const result = await network.rpc(rpc, token);
      const { validateRemoteResponse } = await import("@/lib/a2a/remote-wire");
      validateRemoteResponse(rpc, result);
      return Response.json(result);
    },
}));
vi.mock("@/lib/a2a/worker", async (original) => ({
  ...(await original<typeof import("@/lib/a2a/worker")>()),
  wakeA2AWorker: vi.fn(),
}));

let user: string,
  member: string,
  ws: string,
  agent: string,
  otherAgent: string,
  remote: string;
let ctx: ConsoleActor, grant: LocalA2AGrant;
let peerState: string, peerDetail: string | undefined;
const message = (
  text = "Review only this explicit text",
  extra: Record<string, unknown> = {},
) =>
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
  return assertDefined(
    await claimTask((await submitTask(grant, message())).id),
  );
}
async function child(parent: Awaited<ReturnType<typeof root>>) {
  const authority = await remoteChildGrant(
    parent.id,
    assertDefined(parent.leaseToken),
    remote,
  );
  const row = await submitTask(authority, message(), {
    parentLeaseToken: assertDefined(parent.leaseToken),
  });
  return { grant: authority, row };
}
async function sendChild(parent: Awaited<ReturnType<typeof root>>) {
  const delegated = await child(parent),
    run = assertDefined(await claimTask(delegated.row.id));
  await executeRemoteTask(run, new AbortController().signal);
  return delegated;
}
async function due(id: string) {
  await db.a2ATask.update({
    where: { id },
    data: { remotePollAt: new Date(0) },
  });
  await reconcileRemoteTasks();
}
async function waiting(parent: Awaited<ReturnType<typeof root>>, id: string) {
  await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [id]);
  await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
}
const settledEvents = (taskId: string) =>
  db.logEvent.findMany({
    where: {
      workspaceId: ws,
      eventName: "a2a.task.settled",
      attributes: { path: ["data", "a2a", "taskId"], equals: taskId },
    },
    include: { detail: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const settledDetail = z.object({
  payload: z.object({ response: z.record(z.string(), z.unknown()) }),
});
const settledResponse = (data: unknown) =>
  Task.fromJSON(settledDetail.parse(data).payload.response);
beforeAll(async () => {
  process.env.AUTH_SECRET = "remote-tests-isolated-secret";
  vi.stubEnv(
    "TOOLPLANE_A2A_REMOTE_ORIGINS",
    JSON.stringify(["https://agent.example"]),
  );
  user = (
    await db.user.create({
      data: { email: `${randomUUID()}@remote.test`, passwordHash: "x" },
    })
  ).id;
  member = (
    await db.user.create({
      data: { email: `${randomUUID()}@remote.test`, passwordHash: "x" },
    })
  ).id;
  ws = (
    await db.workspace.create({
      data: {
        slug: `remote-${randomUUID()}`,
        name: "Remote fixture",
        ownerId: user,
        members: { create: { userId: member, role: "member" } },
      },
    })
  ).id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId: ws,
      name: "Model",
      format: "openai",
      baseUrl: "https://model.invalid",
      apiKey: "never-export-this-model-key",
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dep = await db.deployment.create({
      data: { workspaceId: ws, name: "Sandbox", source: "config" },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: ws,
        deploymentId: dep.id,
        name: "Sandbox",
        slug: `sandbox-${i}`,
        kind: "docker",
        network: "isolated",
      },
    });
    ids.push(
      (
        await db.agent.create({
          data: {
            workspaceId: ws,
            name: `Local ${i}`,
            slug: `local-${i}`,
            runtimeKind: "claude-code",
            model: "fixture",
            providerId: provider.id,
            a2aInternalEnabled: true,
            sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
          },
        })
      ).id,
    );
  }
  [agent, otherAgent] = ids;
  ctx = { workspaceId: ws, actorId: user, agentId: agent, slug: "fixture" };
});
beforeEach(async () => {
  vi.clearAllMocks();
  peerState = "TASK_STATE_WORKING";
  peerDetail = undefined;
  network.discover
    .mockReset()
    .mockImplementation(async () => Response.json(remoteCard()));
  network.rpc.mockImplementation(
    async (rpc: { id: unknown; method: string }) => ({
      jsonrpc: "2.0",
      id: rpc.id,
      result:
        rpc.method === "SendMessage"
          ? { task: remoteTask(peerState, peerDetail) }
          : remoteTask(peerState, peerDetail),
    }),
  );
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
  await db.remoteA2AAgent.deleteMany({ where: { workspaceId: ws } });
  await db.agent.updateMany({
    where: { workspaceId: ws },
    data: { a2aInternalEnabled: true, systemPrompt: null },
  });
  grant = await createLocalRootGrant(ws, agent, user);
  remote = (
    await mutateRemoteRegistry(ctx, {
      action: "register",
      cardUrl: REMOTE_CARD,
      token: "fixture-peer-key",
    })
  ).id;
});
afterAll(async () => {
  stopA2AWorker();
  vi.unstubAllEnvs();
  if (ws) {
    await db.auditEvent.deleteMany({ where: { workspaceId: ws } });
    await db.logEvent.deleteMany({ where: { workspaceId: ws } });
    await db.workspace.delete({ where: { id: ws } });
  }
  await db.user.deleteMany({
    where: { id: { in: [user, member].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("registered remote Agents in the native task core", () => {
  it("registers enabled for only the current Agent, encrypts credentials and exposes no secret", async () => {
    await db.agent.update({
      where: { id: agent },
      data: { a2aInternalEnabled: false },
    });
    const id = (
      await mutateRemoteRegistry(ctx, {
        action: "register",
        cardUrl: REMOTE_CARD,
        token: "another-secret",
      })
    ).id;
    const row = await db.remoteA2AAgent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      name: "Remote reviewer",
      rpcUrl: REMOTE_RPC,
      enabled: true,
      allowedAgentIds: [agent],
      revision: 1,
    });
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agent } }))
        .a2aInternalEnabled,
    ).toBe(false);
    expect(JSON.stringify(row.credential)).not.toContain("another-secret");
    expect(remoteCredential(row)).toBe("another-secret");
    expect(() =>
      remoteCredential({ ...row, workspaceId: "different" }),
    ).toThrow();
    const view = await remoteRegistryView(ctx);
    expect(JSON.stringify(view)).not.toMatch(
      /another-secret|fixture-peer-key|credential/,
    );
    const audit = await db.auditEvent.findMany({ where: { workspaceId: ws } });
    expect(JSON.stringify(audit)).not.toContain("another-secret");
  });
  it("honors advanced name and declared RPC overrides and supports cards without auth", async () => {
    const card = { ...remoteCard(), securityRequirements: [] };
    const rpcUrl = "https://agent.example/advanced";
    card.supportedInterfaces.push({
      url: rpcUrl,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    network.discover.mockResolvedValueOnce(Response.json(card));
    const { id } = await mutateRemoteRegistry(ctx, {
      action: "register",
      cardUrl: REMOTE_CARD,
      name: "Custom reviewer",
      rpcUrl,
    });
    expect(
      await db.remoteA2AAgent.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      name: "Custom reviewer",
      rpcUrl,
      enabled: true,
      allowedAgentIds: [agent],
      credential: null,
    });
  });
  it.each(["ambiguous", "cross-origin", "unsupported", "disallowed", "noauth"])(
    "creates nothing for a rejected %s card",
    async (reason) => {
      const card = remoteCard();
      if (reason === "ambiguous")
        card.supportedInterfaces.push({
          url: "https://agent.example/second",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        });
      if (reason === "cross-origin")
        card.supportedInterfaces[0].url = "https://other.example/rpc";
      if (reason === "unsupported")
        card.supportedInterfaces[0].protocolVersion = "0.3";
      network.discover.mockResolvedValueOnce(Response.json(card));
      const before = await db.remoteA2AAgent.count({
        where: { workspaceId: ws },
      });
      await expect(
        mutateRemoteRegistry(ctx, {
          action: "register",
          cardUrl:
            reason === "disallowed"
              ? "https://other.example/card"
              : REMOTE_CARD,
          ...(reason === "noauth" ? {} : { token: "peer-key" }),
        }),
      ).rejects.toThrow();
      expect(
        await db.remoteA2AAgent.count({ where: { workspaceId: ws } }),
      ).toBe(before);
    },
  );
  it("rechecks administrator authority after discovery before committing registration", async () => {
    await db.membership.updateMany({
      where: { workspaceId: ws, userId: member },
      data: { role: "admin" },
    });
    network.discover.mockImplementationOnce(async () => {
      await db.membership.updateMany({
        where: { workspaceId: ws, userId: member },
        data: { role: "member" },
      });
      return Response.json(remoteCard());
    });
    const before = await db.remoteA2AAgent.count({
      where: { workspaceId: ws },
    });
    try {
      await expect(
        mutateRemoteRegistry(
          { ...ctx, actorId: member },
          { action: "register", cardUrl: REMOTE_CARD, token: "peer-key" },
        ),
      ).rejects.toThrow(/administrator/);
      expect(
        await db.remoteA2AAgent.count({ where: { workspaceId: ws } }),
      ).toBe(before);
    } finally {
      await db.membership.updateMany({
        where: { workspaceId: ws, userId: member },
        data: { role: "member" },
      });
    }
  });
  it("requires current admin authority before any remote discovery and per-Agent grants", async () => {
    await expect(
      mutateRemoteRegistry(
        { ...ctx, actorId: member },
        {
          action: "register",
          name: "Denied",
          cardUrl: REMOTE_CARD,
          rpcUrl: REMOTE_RPC,
        },
      ),
    ).rejects.toThrow();
    expect(network.discover).toHaveBeenCalledTimes(1);
    const viewer = await remoteRegistryView({ ...ctx, actorId: member });
    expect(viewer.canManage).toBe(false);
    expect(
      (
        await remoteRegistryView({
          ...ctx,
          actorId: member,
          agentId: otherAgent,
        })
      ).agents,
    ).toHaveLength(0);
    const other = await createLocalRootGrant(ws, otherAgent, user),
      parent = assertDefined(
        await claimTask((await submitTask(other, message())).id),
      );
    await expect(
      remoteChildGrant(parent.id, assertDefined(parent.leaseToken), remote),
    ).rejects.toThrow();
  });
  it("creates native child identity without fake clients/Endpoints or exporting local authority", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    const context = await db.a2AContext.findUniqueOrThrow({
      where: { id: delegated.row.contextId },
    });
    expect(context).toMatchObject({
      targetKind: "remote",
      remoteAgentId: remote,
      workspaceId: ws,
      agentId: null,
      clientId: null,
      endpointId: null,
    });
    expect(await db.agentEndpoint.count({ where: { workspaceId: ws } })).toBe(
      0,
    );
    const [rpc, token] = network.rpc.mock.calls[0];
    expect(rpc.method).toBe("SendMessage");
    expect(token).toBe("fixture-peer-key");
    expect(rpc.params.message.messageId).not.toBe(
      SendMessageRequest.fromJSON(delegated.row.request).message?.messageId,
    );
    for (const secret of [
      ws,
      user,
      agent,
      parent.id,
      delegated.row.id,
      assertDefined(parent.leaseToken),
      "never-export-this-model-key",
    ])
      expect(JSON.stringify(rpc)).not.toContain(secret);
    expect(rpc.params).not.toHaveProperty("metadata");
    expect(rpc.params.configuration.returnImmediately).toBe(true);
    await expect(getTask(grant, delegated.row.id)).rejects.toThrow();
  });
  it("releases the execution lease and resumes a waiting parent without a second SendMessage", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    expect(await getTaskRow(delegated.grant, delegated.row.id)).toMatchObject({
      phase: "remote-waiting",
      state: 2,
      leaseToken: null,
    });
    expect(await settledEvents(parent.id)).toEqual([]);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    peerState = "TASK_STATE_COMPLETED";
    const unrelatedRequest = randomUUID(),
      unrelatedTrace = randomUUID();
    await withLogContext(
      { requestId: unrelatedRequest, traceId: unrelatedTrace, actorId: member },
      () => due(delegated.row.id),
    );
    await due(delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    expect(resumed.resumeCount).toBe(1);
    expect(JSON.stringify(Task.fromJSON(resumed.snapshot).history)).toContain(
      "Remote review result",
    );
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "GetTask",
      "GetTask",
    ]);
    const tree = await getConsoleTaskTree(ctx, parent.id, delegated.row.id);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.selectedTask).toMatchObject({
      id: delegated.row.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    const committed = await getTaskRow(delegated.grant, delegated.row.id),
      events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "success",
      requestId: null,
      actorId: user,
      agentId: agent,
      workspaceId: ws,
      durationMs: committed.statusAt.getTime() - committed.createdAt.getTime(),
      attributes: {
        data: {
          a2a: {
            taskId: delegated.row.id,
            contextId: delegated.row.contextId,
            rootTaskId: parent.id,
            parentTaskId: parent.id,
            remoteAgentId: remote,
            taskState: "TASK_STATE_COMPLETED",
          },
        },
      },
    });
    expect(events[0].traceId).not.toBe(unrelatedTrace);
    const response = settledResponse(assertDefined(events[0].detail).data);
    expect(response.id).toBe(delegated.row.id);
    expect(response.contextId).toBe(delegated.row.contextId);
    expect(response.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(response.history).toEqual([]);
    expect(response.artifacts[0].parts[0].content).toEqual({
      $case: "text",
      value: "Remote review result",
    });
    expect(assertDefined(events[0].detail).data).not.toHaveProperty(
      "payload.request",
    );
    expect(JSON.stringify(events)).not.toMatch(
      /peer-task|peer-context|fixture-peer-key|ownerKey|Review only this explicit text/,
    );
  });
  it("keeps remote task/context IDs stable through input-required continuation", async () => {
    const parent = await root();
    peerState = "TASK_STATE_INPUT_REQUIRED";
    peerDetail = "Which branch?";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const authority = await remoteChildGrant(
      parent.id,
      assertDefined(resumed.leaseToken),
      remote,
    );
    const follow = await submitTask(
      authority,
      message("main", { taskId: delegated.row.id }),
      { parentLeaseToken: assertDefined(resumed.leaseToken) },
    );
    peerState = "TASK_STATE_COMPLETED";
    peerDetail = undefined;
    const run = assertDefined(await claimTask(follow.id));
    await executeRemoteTask(run, new AbortController().signal);
    const calls = network.rpc.mock.calls.map(([rpc]) => rpc);
    expect(calls).toHaveLength(2);
    expect(calls[1].params.message).toMatchObject({
      taskId: "peer-task",
      contextId: "peer-context",
    });
    expect(calls[1].params.message.messageId).not.toBe(
      calls[0].params.message.messageId,
    );
    expect((await getTask(authority, follow.id)).status?.state).toBe(3);
    expect(follow.deadlineAt).toEqual(delegated.row.deadlineAt);
    const events = await settledEvents(follow.id);
    expect(events).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_INPUT_REQUIRED" } },
        },
      },
      {
        outcome: "success",
        attributes: { data: { a2a: { taskState: "TASK_STATE_COMPLETED" } } },
      },
    ]);
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });
  it("does not claim cancellation until the peer confirms and sends CancelTask at most once", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    expect(
      (await requestCancellation(delegated.grant, delegated.row.id)).status
        ?.state,
    ).toBe(2);
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(2);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    peerState = "TASK_STATE_CANCELED";
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(5);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "CancelTask",
      "GetTask",
    ]);
    const events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "cancelled",
      attributes: { data: { a2a: { taskState: "TASK_STATE_CANCELED" } } },
    });
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("cancels a queued input continuation without resending its business message", async () => {
    const parent = await root();
    peerState = "TASK_STATE_INPUT_REQUIRED";
    peerDetail = "Which branch?";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const authority = await remoteChildGrant(
      parent.id,
      assertDefined(resumed.leaseToken),
      remote,
    );
    await submitTask(authority, message("main", { taskId: delegated.row.id }), {
      parentLeaseToken: assertDefined(resumed.leaseToken),
    });
    await requestCancellation(authority, delegated.row.id);
    await waiting(resumed, delegated.row.id);
    await due(delegated.row.id);
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("waiting");
    peerState = "TASK_STATE_CANCELED";
    peerDetail = undefined;
    await due(delegated.row.id);
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("resumable");
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "CancelTask",
      "GetTask",
    ]);
  });
  it("observes externally resolved remote authorization without model approval or new submission", async () => {
    const parent = await root();
    peerState = "TASK_STATE_AUTH_REQUIRED";
    const delegated = await sendChild(parent);
    await expect(
      submitTask(
        delegated.grant,
        message("approved", { taskId: delegated.row.id }),
        { parentLeaseToken: assertDefined(parent.leaseToken) },
      ),
    ).rejects.toThrow();
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_AUTH_REQUIRED" } },
        },
      },
    ]);
    peerState = "TASK_STATE_WORKING";
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toHaveLength(1);
    peerState = "TASK_STATE_COMPLETED";
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(3);
    expect(
      network.rpc.mock.calls.filter(([rpc]) => rpc.method === "SendMessage"),
    ).toHaveLength(1);
    expect(await settledEvents(delegated.row.id)).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_AUTH_REQUIRED" } },
        },
      },
      {
        outcome: "success",
        attributes: { data: { a2a: { taskState: "TASK_STATE_COMPLETED" } } },
      },
    ]);
  });
  it("propagates root cancellation but can still cancel the known remote child", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await requestCancellation(grant, parent.id);
    expect((await getTask(grant, parent.id)).status?.state).toBe(5);
    peerState = "TASK_STATE_CANCELED";
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(5);
  });
  it("fails an uncertain submission without automatic resend or false cancellation", async () => {
    const parent = await root(),
      delegated = await child(parent);
    network.rpc.mockRejectedValueOnce(new Error("secret upstream exception"));
    await executeA2ATask(delegated.row.id);
    const task = await getTask(delegated.grant, delegated.row.id);
    expect(task.status?.state).toBe(4);
    expect(JSON.stringify(task)).not.toContain("secret upstream exception");
    expect(JSON.stringify(task)).toContain("may still");
    await executeA2ATask(delegated.row.id);
    await due(delegated.row.id);
    expect(network.rpc).toHaveBeenCalledTimes(1);
    const events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      attributes: { data: { a2a: { taskState: "TASK_STATE_FAILED" } } },
    });
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_FAILED);
  });
  it("invalidates outstanding tasks on key rotation or access revocation", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await mutateRemoteRegistry(ctx, {
      action: "replace-key",
      id: remote,
      revision: 1,
      token: "new-key",
    });
    await expect(assertRemoteGrant(delegated.grant)).rejects.toThrow();
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(4);
    expect(network.rpc).toHaveBeenCalledTimes(1);
    await expect(
      getConsoleTaskTree(ctx, parent.id, delegated.row.id),
    ).rejects.toThrow();
    await expect(
      mutateRemoteRegistry(ctx, {
        action: "configure",
        id: remote,
        revision: 1,
        enabled: true,
      }),
    ).rejects.toThrow();
  });
  it("withholds completed remote output from automatic continuation after authorization changes", async () => {
    const parent = await root();
    peerState = "TASK_STATE_COMPLETED";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await mutateRemoteRegistry(ctx, {
      action: "configure",
      id: remote,
      revision: 1,
      allowCurrentAgent: false,
    });
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const history = JSON.stringify(Task.fromJSON(resumed.snapshot).history);
    expect(history).not.toContain("Remote review result");
    expect(history).toContain("withheld");
  });
  it("rejects forged ancestry/actor/lease and cross-workspace configuration", async () => {
    const parent = await root(),
      delegated = await child(parent);
    await expect(
      submitTask(delegated.grant, message(), { parentLeaseToken: "wrong" }),
    ).rejects.toThrow();
    await expect(
      assertRemoteGrant({ ...delegated.grant, actorId: member }),
    ).rejects.toThrow();
    await expect(
      assertRemoteGrant({
        ...delegated.grant,
        ancestorTaskIds: [randomUUID()],
      }),
    ).rejects.toThrow();
    await expect(
      mutateRemoteRegistry(
        { ...ctx, workspaceId: randomUUID() },
        { action: "configure", id: remote, revision: 1, enabled: false },
      ),
    ).rejects.toThrow();
  });
  it("ignores stale observation errors after a newer phase/generation", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    const row = await getTaskRow(delegated.grant, delegated.row.id);
    await db.a2ATask.update({
      where: { id: row.id },
      data: { remoteMessageId: "new-generation" },
    });
    await interruptTask(row.id, "stale", {
      phase: "remote-waiting",
      remoteMessageId: row.remoteMessageId,
    });
    expect((await getTaskRow(delegated.grant, row.id)).state).toBe(2);
    expect(await settledEvents(row.id)).toEqual([]);
  });
  it("bounds failed read retries without issuing another business message", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    network.rpc.mockRejectedValue(new Error("read failed"));
    for (let i = 0; i < 5; i++) await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(4);
    expect(
      network.rpc.mock.calls.filter(([rpc]) => rpc.method === "SendMessage"),
    ).toHaveLength(1);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === "1")(
    "claims a remote task only once under concurrent PostgreSQL transactions",
    async () => {
      const parent = await root(),
        delegated = await child(parent);
      const claims = await Promise.all([
        claimTask(delegated.row.id),
        claimTask(delegated.row.id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    },
  );
  it("recovers a known remote task by observation only, never replaying SendMessage", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await db.a2ATask.update({
      where: { id: delegated.row.id },
      data: {
        phase: "executing",
        leaseToken: "obsolete",
        remotePollAt: new Date(0),
      },
    });
    await startA2AWorker();
    stopA2AWorker();
    expect(await getTaskRow(delegated.grant, delegated.row.id)).toMatchObject({
      phase: "remote-waiting",
      leaseToken: null,
    });
    peerState = "TASK_STATE_COMPLETED";
    await due(delegated.row.id);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "GetTask",
    ]);
  });
});
