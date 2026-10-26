// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Message,
  SendMessageRequest,
  Task,
  TaskState,
  ListTasksRequest,
} from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createAgentApiKey } from "@/lib/agents/public-api/auth";
import {
  resolveA2AGrant,
  assertLiveGrant,
  type A2AGrant,
} from "@/lib/a2a/principal";
import {
  submitTask,
  getTask,
  getTaskRow,
  listTasks,
  requestCancellation,
  eventsAfter,
} from "@/lib/a2a/store";
import { executeA2ATask, stopA2AWorker } from "@/lib/a2a/worker";
import { jsonEvent, taskEvent } from "@/lib/a2a/model";
// The embedded local transport requires one client; PostgreSQL keeps its normal pool.
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
let userId: string,
  workspaceId: string,
  endpointId: string,
  publicId: string,
  clientId: string,
  revisionId: string;
let grant: A2AGrant, other: A2AGrant;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const request = (text = "Review") =>
  SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] },
    configuration: { returnImmediately: true },
  });
beforeAll(async () => {
  process.env.AUTH_SECRET =
    "isolated-a2a-integration-test-secret-not-production";
  const stamp = randomUUID();
  userId = (
    await db.user.create({
      data: { email: `a2a-${stamp}@test.invalid`, passwordHash: "test-only" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `a2a-${stamp}`, name: "A2A history", ownerId: userId },
    })
  ).id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      slug: "public-source",
      name: "Historical service",
      runtimeKind: "pi-sdk",
    },
  });
  const endpoint = await db.agentEndpoint.create({
    data: {
      workspaceId,
      sourceAgentId: agent.id,
      publicId: `agep_${stamp.replaceAll("-", "")}`,
      name: "Historical service",
      status: "active",
      a2aEnabled: true,
      rpmLimit: 10000,
      dailyRequestLimit: 100000,
      maxConcurrent: 10,
    },
  });
  endpointId = endpoint.id;
  publicId = endpoint.publicId;
  revisionId = (
    await db.agentEndpointRevision.create({
      data: {
        endpointId,
        version: 1,
        systemPrompt: "Historical manifest",
        runtimeImage: "historical-runtime-image",
        toolPolicy: {},
      },
    })
  ).id;
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { currentRevisionId: revisionId },
  });
  async function makeGrant(name: string) {
    const client = await db.agentApiClient.create({
      data: {
        endpointId,
        name,
        scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
        rpmLimit: 10000,
        dailyRequestLimit: 100000,
        maxConcurrent: 10,
      },
    });
    const key = await createAgentApiKey({
      clientId: client.id,
      endpointPublicId: publicId,
      workspaceId,
      sourceAgentId: agent.id,
      name,
    });
    return (
      await resolveA2AGrant(
        new Request("https://toolplane.test/a2a", {
          headers: { authorization: `Bearer ${key.token}` },
        }),
        publicId,
      )
    ).grant;
  }
  grant = await makeGrant("main");
  clientId = grant.clientId;
  other = await makeGrant("other");
});
beforeEach(async () => {
  await db.a2AContext.deleteMany({ where: { endpointId } });
  await db.agentApiClient.update({
    where: { id: clientId },
    data: { status: "active" },
  });
});
afterAll(async () => {
  stopA2AWorker();
  if (workspaceId) {
    await db.logEvent.deleteMany({ where: { workspaceId } });
    await db.auditEvent.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
// Historical A2ARequest hashes use recursively sorted JSON keys, including SDK defaults.
function canonicalRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalRequest(entry)]),
    );
  }
  return value;
}

/** Insert persisted pre-cutover work without exercising the now-disabled admission path. */
async function historicalTask(state = TaskState.TASK_STATE_COMPLETED) {
  const input = request();
  const message = assertDefined(input.message);
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalRequest({
          message: Message.toJSON(message),
          metadata: input.metadata,
        }),
      ),
    )
    .digest("hex");
  const context = await db.a2AContext.create({
    data: {
      workspaceId,
      endpointId,
      revisionId,
      clientId,
      ownerKey: grant.ownerKey,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const id = randomUUID();
  const snapshot = Task.fromJSON({
    id,
    contextId: context.id,
    status: { state },
    history: [Message.toJSON(message)],
  });
  const row = await db.a2ATask.create({
    data: {
      id,
      contextId: context.id,
      state,
      snapshot: json(Task.toJSON(snapshot)),
      request: json(SendMessageRequest.toJSON(input)),
      grant: json(grant),
      deadlineAt: new Date(Date.now() + 60000),
      completedAt: state === TaskState.TASK_STATE_COMPLETED ? new Date() : null,
      events: {
        create: { sequence: 1, payload: json(jsonEvent(taskEvent(snapshot))) },
      },
      requests: {
        create: {
          ownerKey: grant.ownerKey,
          messageId: message.messageId,
          contentHash,
        },
      },
    },
  });
  return { row, input };
}
describe("published A2A cutover", () => {
  it("rejects new work transactionally without creating a context, request or task", async () => {
    const input = request();
    await expect(submitTask(grant, input)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(await db.a2AContext.count({ where: { endpointId } })).toBe(0);
    expect(
      await db.a2ARequest.count({ where: { ownerKey: grant.ownerKey } }),
    ).toBe(0);
  });
  it("replays historical accepted messages without creating execution", async () => {
    const { row, input } = await historicalTask();
    expect((await submitTask(grant, input)).id).toBe(row.id);
    expect(await db.a2ATask.count({ where: { context: { endpointId } } })).toBe(
      1,
    );
  });
  it("retains scoped history, listing and events", async () => {
    const { row } = await historicalTask();
    expect((await getTask(grant, row.id)).status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    expect((await getTaskRow(grant, row.id)).id).toBe(row.id);
    expect(
      (await listTasks(grant, ListTasksRequest.fromJSON({}))).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([row.id]);
    expect(await eventsAfter(grant, row.id, 0)).toHaveLength(1);
    await expect(getTask(other, row.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(
      (await listTasks(other, ListTasksRequest.fromJSON({}))).tasks,
    ).toHaveLength(0);
  });
  it("keeps revocation effective for historical task access", async () => {
    const { row } = await historicalTask();
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { status: "disabled" },
    });
    await expect(assertLiveGrant(grant, "read")).rejects.toThrow();
    await expect(getTask(other, row.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
  it("still cancels queued historical work", async () => {
    const { row } = await historicalTask(TaskState.TASK_STATE_SUBMITTED);
    expect((await requestCancellation(grant, row.id)).status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
    expect((await getTaskRow(grant, row.id)).cancelRequestedAt).not.toBeNull();
  });
  it("settles queued published tasks as failed instead of manufacturing a result", async () => {
    const { row } = await historicalTask(TaskState.TASK_STATE_SUBMITTED);
    await executeA2ATask(row.id);
    const task = await getTask(grant, row.id);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(task.artifacts).toHaveLength(0);
  });
});
