// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { assertDefined } from "../assert-defined";
import { db } from "@/lib/db";
import { createAgentApiKey } from "@/lib/agents/public-api/auth";
import {
  assertLiveGrant,
  resolveA2AGrant,
  type A2AGrant,
} from "@/lib/a2a/principal";
import {
  claimTask,
  eventsAfter,
  finishTask,
  getTask,
  getTaskRow,
  interruptTask,
  listTasks,
  requestCancellation,
  submitTask,
} from "@/lib/a2a/store";
import {
  A2A_LIMITS,
  jsonEvent,
  taskEvent,
  terminal,
  textArtifact,
} from "@/lib/a2a/model";
import {
  A2AQuotaError,
  A2A_TASK_STORAGE_BYTES,
  outputBucket,
  refreshTaskStorage,
  reserveNativeExecutionOutput,
} from "@/lib/a2a/quotas";
import { startA2AWorker, stopA2AWorker } from "@/lib/a2a/worker";

const OUTPUT_CHARGE = vi.hoisted(() => {
  // The retained client schema has a 200000-character minimum quota.
  process.env.TOOLPLANE_A2A_OUTPUT_CHARACTERS = "250000";
  return 250_000;
});

// Exercise the alternate DB module-loading boundary without changing production pooling.
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
  agentId: string,
  endpointId: string,
  publicId: string,
  clientId: string;
let grant: A2AGrant, other: A2AGrant, token: string;
const credentialRequest = (value: string) =>
  new Request("https://toolplane.test/a2a", {
    headers: { authorization: `Bearer ${value}` },
  });
const request = (extra: Record<string, unknown> = {}) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "Retained user input" }],
      ...extra,
    },
    configuration: { returnImmediately: true },
  });
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const settledEvents = (id: string) =>
  db.logEvent.findMany({
    where: {
      workspaceId,
      eventName: "a2a.task.settled",
      attributes: { path: ["data", "a2a", "taskId"], equals: id },
    },
    include: { detail: true },
    orderBy: { occurredAt: "asc" },
  });

beforeAll(async () => {
  process.env.AUTH_SECRET = "isolated-a2a-history-test-secret-not-production";
  const stamp = randomUUID();
  userId = (
    await db.user.create({
      data: {
        email: `a2a-history-${stamp}@test.invalid`,
        passwordHash: "test-only",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `a2a-history-${stamp}`,
        name: "Retained A2A",
        ownerId: userId,
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "retained-service",
        name: "Retained Hermes Agent",
        runtimeKind: "hermes",
      },
    })
  ).id;
  const endpoint = await db.agentEndpoint.create({
    data: {
      workspaceId,
      sourceAgentId: agentId,
      publicId: `agep_${stamp.replaceAll("-", "")}`,
      name: "Retained service",
      status: "active",
      a2aEnabled: true,
      rpmLimit: 10000,
      dailyRequestLimit: 100000,
      maxConcurrent: 10,
    },
  });
  endpointId = endpoint.id;
  publicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId,
      version: 1,
      systemPrompt: "Retained definition",
      runtimeImage: "legacy:retained",
      toolPolicy: {},
    },
  });
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { currentRevisionId: revision.id },
  });
  const client = async (name: string) => {
    const row = await db.agentApiClient.create({
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
      clientId: row.id,
      endpointPublicId: publicId,
      workspaceId,
      sourceAgentId: agentId,
      name,
    });
    return {
      id: row.id,
      token: key.token,
      grant: (await resolveA2AGrant(credentialRequest(key.token), publicId))
        .grant,
    };
  };
  const main = await client("retained-owner");
  clientId = main.id;
  token = main.token;
  grant = main.grant;
  other = (await client("other-owner")).grant;
});
beforeEach(async () => {
  await db.a2AContext.deleteMany({ where: { endpointId } });
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: {
      a2aEnabled: true,
      dailyOutputCharacterLimit: 100000000,
      maxStoredCharacters: 250000000,
    },
  });
  await db.agentApiClient.update({
    where: { id: clientId },
    data: {
      status: "active",
      scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
      dailyOutputCharacterLimit: 20000000,
      maxStoredCharacters: 50000000,
    },
  });
  await db.agentApiKey.updateMany({
    where: { clientId },
    data: { revokedAt: null },
  });
  await db.agentApiUsageBucket.deleteMany({
    where: {
      key: {
        in: [
          outputBucket("workspace", workspaceId),
          outputBucket("endpoint", endpointId),
          outputBucket("client", clientId),
          outputBucket("client", other.clientId),
        ],
      },
    },
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

/** Import an already-recorded ledger row, never admit or dispatch a retired runtime. */
async function history(
  state: TaskState = TaskState.TASK_STATE_COMPLETED,
  owner = grant,
  statusAt = new Date(),
) {
  return db.$transaction(async (tx) => {
    const context = await tx.a2AContext.create({
      data: {
        workspaceId,
        targetKind: "published",
        endpointId,
        clientId: owner.clientId,
        revisionId: owner.revisionId,
        ownerKey: owner.ownerKey,
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const id = randomUUID();
    const input = request();
    const message = assertDefined(input.message);
    const snapshot = Task.fromJSON({
      id,
      contextId: context.id,
      history: [Message.toJSON(message)],
      status: { state, timestamp: statusAt.toISOString() },
      artifacts:
        state === TaskState.TASK_STATE_COMPLETED
          ? [textArtifact("Retained response")]
          : [],
    });
    const row = await tx.a2ATask.create({
      data: {
        id,
        contextId: context.id,
        state,
        statusAt,
        phase: terminal(state)
          ? "done"
          : state === TaskState.TASK_STATE_WORKING
            ? "executing"
            : state === TaskState.TASK_STATE_SUBMITTED
              ? "queued"
              : "paused",
        executionBackend: "legacy",
        leaseToken:
          state === TaskState.TASK_STATE_WORKING ? randomUUID() : null,
        completedAt: terminal(state) ? statusAt : null,
        deadlineAt: new Date(Date.now() + 60_000),
        snapshot: json(Task.toJSON(snapshot)),
        request: json(SendMessageRequest.toJSON(input)),
        grant: json(owner),
        requests: {
          create: {
            ownerKey: owner.ownerKey,
            messageId: message.messageId,
            contentHash: createHash("sha256")
              .update(JSON.stringify(SendMessageRequest.toJSON(input)))
              .digest("hex"),
          },
        },
        events: {
          create: {
            sequence: 1,
            payload: json(jsonEvent(taskEvent(snapshot))),
          },
        },
      },
    });
    await refreshTaskStorage(tx, id);
    return row;
  });
}

describe("retained published A2A history", () => {
  it("rejects all new or continuation sends before inserting or mutating any ledger row", async () => {
    const retained = await history(TaskState.TASK_STATE_INPUT_REQUIRED);
    for (const input of [
      request(),
      request({ contextId: retained.contextId }),
      request({ taskId: retained.id }),
    ])
      await expect(submitTask(grant, input)).rejects.toMatchObject({
        status: 410,
      });
    expect(await db.a2ATask.count({ where: { context: { endpointId } } })).toBe(
      1,
    );
    expect(await db.a2AContext.count({ where: { endpointId } })).toBe(1);
    expect(await db.a2ARequest.count({ where: { taskId: retained.id } })).toBe(
      1,
    );
    expect((await getTaskRow(grant, retained.id)).snapshot).toEqual(
      retained.snapshot,
    );
  });
  it("retains protocol artifacts, owner authorization and explicitly unresolved Agent revisions", async () => {
    const retained = await history();
    expect(await getTask(grant, retained.id)).toMatchObject({
      id: retained.id,
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: Task.fromJSON(retained.snapshot).artifacts,
    });
    expect(await eventsAfter(grant, retained.id, 0)).toHaveLength(1);
    expect(
      await db.a2AContext.findUnique({ where: { id: retained.contextId } }),
    ).toMatchObject({
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      revisionId: grant.revisionId,
    });
    await expect(getTask(other, retained.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(eventsAfter(other, retained.id, 0)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(
      requestCancellation(other, retained.id),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(
      JSON.stringify((await getTaskRow(grant, retained.id)).grant),
    ).not.toContain(token);
  });
  it("never acquires a new execution lease for a queued retired task", async () => {
    const retained = await history(TaskState.TASK_STATE_SUBMITTED);
    await expect(claimTask(retained.id)).rejects.toMatchObject({ status: 410 });
    expect(await getTaskRow(grant, retained.id)).toMatchObject({
      leaseToken: null,
      sequence: 1,
      phase: "queued",
    });
  });
  it("cancels queued history without allocating execution", async () => {
    const retained = await history(TaskState.TASK_STATE_SUBMITTED);
    const cancellations = await Promise.all([
      requestCancellation(grant, retained.id),
      requestCancellation(grant, retained.id),
    ]);
    expect(cancellations.map((task) => task.status?.state)).toEqual([
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_CANCELED,
    ]);
    expect(await claimTask(retained.id)).toBeNull();
    expect(await settledEvents(retained.id)).toHaveLength(1);
  });
  it("keeps cancellation pending until an existing execution lease settles and discards late output", async () => {
    const retained = await history(TaskState.TASK_STATE_WORKING);
    expect((await requestCancellation(grant, retained.id)).status?.state).toBe(
      TaskState.TASK_STATE_WORKING,
    );
    expect(
      (await getTaskRow(grant, retained.id)).cancelRequestedAt,
    ).not.toBeNull();
    await finishTask(
      retained.id,
      assertDefined(retained.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("must not publish"),
    );
    expect(await getTask(grant, retained.id)).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED },
      artifacts: [],
    });
    const events = await settledEvents(retained.id);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("cancelled");
    expect(JSON.stringify(events)).not.toMatch(
      /must not publish|Retained user input|ownerKey|runtimeState/,
    );
  });
  it("fences existing leases and rolls back oversized journal updates atomically", async () => {
    const retained = await history(TaskState.TASK_STATE_WORKING);
    await finishTask(
      retained.id,
      "wrong-lease",
      TaskState.TASK_STATE_COMPLETED,
    );
    expect((await getTaskRow(grant, retained.id)).sequence).toBe(1);
    await expect(
      finishTask(
        retained.id,
        assertDefined(retained.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("x".repeat(A2A_LIMITS.outputCharacters + 1)),
      ),
    ).rejects.toBeInstanceOf(A2AQuotaError);
    expect(await getTaskRow(grant, retained.id)).toMatchObject({
      sequence: 1,
      state: TaskState.TASK_STATE_WORKING,
      leaseToken: retained.leaseToken,
      snapshot: retained.snapshot,
    });
    expect(await eventsAfter(grant, retained.id, 1)).toEqual([]);
    expect(await settledEvents(retained.id)).toEqual([]);
    await finishTask(
      retained.id,
      assertDefined(retained.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("Committed existing execution output"),
    );
    await finishTask(
      retained.id,
      assertDefined(retained.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("late duplicate"),
    );
    expect(await settledEvents(retained.id)).toHaveLength(1);
    expect(JSON.stringify(await getTask(grant, retained.id))).not.toContain(
      "late duplicate",
    );
  });
  it("settles an expired existing execution as failure instead of accepting its proposed completion", async () => {
    const retained = await history(TaskState.TASK_STATE_WORKING);
    await db.a2ATask.update({
      where: { id: retained.id },
      data: { deadlineAt: new Date(0) },
    });
    await finishTask(
      retained.id,
      assertDefined(retained.leaseToken),
      TaskState.TASK_STATE_COMPLETED,
      undefined,
      textArtifact("late output"),
    );
    expect(await getTask(grant, retained.id)).toMatchObject({
      status: { state: TaskState.TASK_STATE_FAILED },
      artifacts: [],
    });
    expect(await settledEvents(retained.id)).toHaveLength(1);
  });
  it("uses signed owner- and filter-bound cursors for retained history", async () => {
    const earlier = await history(
      TaskState.TASK_STATE_COMPLETED,
      grant,
      new Date("2026-01-01T00:00:00Z"),
    );
    const later = await history(
      TaskState.TASK_STATE_COMPLETED,
      grant,
      new Date("2026-01-02T00:00:00Z"),
    );
    const first = await listTasks(
      grant,
      ListTasksRequest.fromJSON({ pageSize: 1, historyLength: 0 }),
    );
    expect(first.tasks.map((task) => task.id)).toEqual([later.id]);
    expect(first.tasks[0].history).toEqual([]);
    const second = await listTasks(
      grant,
      ListTasksRequest.fromJSON({
        pageSize: 1,
        historyLength: 0,
        pageToken: first.nextPageToken,
      }),
    );
    expect(second.tasks.map((task) => task.id)).toEqual([earlier.id]);
    expect(second.nextPageToken).toBe("");
    await expect(
      listTasks(
        other,
        ListTasksRequest.fromJSON({ pageToken: first.nextPageToken }),
      ),
    ).rejects.toThrow();
    await expect(
      listTasks(
        grant,
        ListTasksRequest.fromJSON({
          pageToken: first.nextPageToken,
          status: TaskState.TASK_STATE_FAILED,
        }),
      ),
    ).rejects.toThrow();
  });
  it("revalidates scopes and key revocation on retained reads", async () => {
    const retained = await history();
    await assertLiveGrant(grant, "read");
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { scopes: ["a2a:cancel"] },
    });
    await expect(getTask(grant, retained.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(eventsAfter(grant, retained.id, 0)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(
      listTasks(grant, ListTasksRequest.fromJSON({})),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { scopes: ["a2a:read"] },
    });
    const queued = await history(TaskState.TASK_STATE_SUBMITTED);
    await expect(requestCancellation(grant, queued.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect((await getTaskRow(grant, queued.id)).state).toBe(
      TaskState.TASK_STATE_SUBMITTED,
    );
    await db.agentApiKey.updateMany({
      where: { clientId },
      data: { revokedAt: new Date() },
    });
    await expect(getTask(grant, retained.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(eventsAfter(grant, retained.id, 0)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await expect(
      listTasks(grant, ListTasksRequest.fromJSON({})),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(requestCancellation(grant, queued.id)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
  it("rejects wildcard service scopes, cookies and browser-origin credentials", async () => {
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { scopes: ["*"] },
    });
    await expect(
      resolveA2AGrant(credentialRequest(token), publicId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveA2AGrant(
        new Request("https://toolplane.test/a2a", {
          headers: { cookie: "session=fixture" },
        }),
        publicId,
      ),
    ).rejects.toMatchObject({ status: 401 });
    const browser = credentialRequest(token);
    browser.headers.set("origin", "https://toolplane.test");
    await expect(resolveA2AGrant(browser, publicId)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("quarantines interrupted historical executions without replaying side effects", async () => {
    const retained = await history(TaskState.TASK_STATE_WORKING);
    await startA2AWorker();
    stopA2AWorker();
    expect((await getTask(grant, retained.id)).status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    await interruptTask(retained.id, "Late duplicate interruption");
    expect(await settledEvents(retained.id)).toHaveLength(1);
  });
});

describe("retained native journal and resource accounting", () => {
  it("keeps UTF-8 payload accounting consistent with retained events", async () => {
    const retained = await history();
    const before = (await getTaskRow(grant, retained.id)).storageBytes;
    await db.$transaction(async (tx) => {
      await tx.a2AEvent.create({
        data: {
          taskId: retained.id,
          sequence: 2,
          payload: { text: "界".repeat(1000) },
        },
      });
      await refreshTaskStorage(tx, retained.id);
    });
    expect(
      (await getTaskRow(grant, retained.id)).storageBytes - before,
    ).toBeGreaterThanOrEqual(3000);
  });
  it("can settle a failed existing lease when successful output exceeds the journal cap", async () => {
    const retained = await history(TaskState.TASK_STATE_WORKING);
    await db.a2ATask.update({
      where: { id: retained.id },
      data: {
        snapshot: {
          ...(Task.toJSON(Task.fromJSON(retained.snapshot)) as object),
          metadata: { retainedPayload: "x".repeat(A2A_TASK_STORAGE_BYTES) },
        },
      },
    });
    await expect(
      finishTask(
        retained.id,
        assertDefined(retained.leaseToken),
        TaskState.TASK_STATE_COMPLETED,
        undefined,
        textArtifact("too much"),
      ),
    ).rejects.toBeInstanceOf(A2AQuotaError);
    expect(await settledEvents(retained.id)).toEqual([]);
    expect(
      await db.a2ATask.findUnique({ where: { id: retained.id } }),
    ).toMatchObject({
      sequence: 1,
      state: TaskState.TASK_STATE_WORKING,
      leaseToken: retained.leaseToken,
    });
    expect(await eventsAfter(grant, retained.id, 1)).toEqual([]);
    await finishTask(
      retained.id,
      assertDefined(retained.leaseToken),
      TaskState.TASK_STATE_FAILED,
      "Stopped at the configured quota.",
    );
    expect((await getTask(grant, retained.id)).status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    expect(await settledEvents(retained.id)).toHaveLength(1);
  });
  it("preserves conservative reservations on both UTC days of an existing cross-midnight execution", async () => {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await reserveNativeExecutionOutput(
        tx,
        grant,
        new Date("2030-01-02T00:01:00Z"),
        new Date("2030-01-01T23:59:55Z"),
      );
    });
    const buckets = await db.agentApiUsageBucket.findMany({
      where: { key: outputBucket("client", clientId) },
      orderBy: { windowStart: "asc" },
    });
    expect(buckets.map((bucket) => bucket.windowStart.toISOString())).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2030-01-02T00:00:00.000Z",
    ]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([
      OUTPUT_CHARGE,
      OUTPUT_CHARGE,
    ]);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === "1")(
    "serializes existing-execution reservations without partially charging other scopes",
    async () => {
      await db.agentApiClient.update({
        where: { id: clientId },
        data: { dailyOutputCharacterLimit: OUTPUT_CHARGE },
      });
      const reserve = () =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
          await reserveNativeExecutionOutput(
            tx,
            grant,
            new Date("2030-01-01T12:01:00Z"),
            new Date("2030-01-01T12:00:00Z"),
          );
        });
      const results = await Promise.allSettled([reserve(), reserve()]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const buckets = await db.agentApiUsageBucket.findMany({
        where: {
          key: {
            in: [
              outputBucket("workspace", workspaceId),
              outputBucket("endpoint", endpointId),
              outputBucket("client", clientId),
            ],
          },
        },
      });
      expect(buckets).toHaveLength(3);
      expect(buckets.every((bucket) => bucket.count === OUTPUT_CHARGE)).toBe(
        true,
      );
    },
  );
});
