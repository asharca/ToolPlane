// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { SendMessageRequest, Message, Task, TaskState } from "@a2a-js/sdk";
import type { A2AGrant } from "@/lib/a2a/principal";
import { resolveA2AGrant } from "@/lib/a2a/principal";
import { refreshTaskStorage } from "@/lib/a2a/quotas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createAgentApiKey } from "@/lib/agents/public-api/auth";
import { createApiToken } from "@/lib/auth/tokens";
import { handleLogRequest } from "@/lib/observability/views/api";
import type { A2ATaskDetail, ViewScope } from "@/lib/observability/views/types";
import { POST } from "@/app/api/v1/agent-endpoints/[endpointId]/a2a/route";
import {
  LOG_SETTINGS_KEY,
  invalidateLogSettings,
} from "@/lib/observability/settings";
import { jsonEvent, taskEvent, textArtifact, terminal } from "@/lib/a2a/model";
import {
  getLogEvent,
  getLogTrace,
  listLogEvents,
  LogAccessError,
} from "@/lib/observability/queries";
import * as auditModule from "@/lib/observability/audit";
import {
  listA2ATasks,
  getA2ATask,
  pollA2ATasks,
} from "@/lib/observability/views/a2a-tasks";
import {
  listAgentRuns,
  getAgentRun,
  pollAgentRuns,
} from "@/lib/observability/views/agent-runs";
import { withLogContext } from "@/lib/observability/context";
import { recordEvent } from "@/lib/observability/events";
import { listMcpCalls } from "@/lib/observability/views/mcp-calls";

// Route handlers run outside a Next request scope here; model a browser without a session.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const stamp = randomUUID();
let userId: string,
  adminId: string,
  foreignId: string,
  workspaceId: string,
  foreignWorkspaceId: string,
  agentId: string;
let endpointId: string, publicId: string, clientId: string, token: string;
let historicalGrant: A2AGrant;
let retainedTaskId: string;
const retainedCallerInput = "Retained caller input";
let previousSetting: string | null | undefined;
const requestIds: string[] = [];
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { email: `a2a-logs-${stamp}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  adminId = (
    await db.user.create({
      data: {
        email: `a2a-logs-admin-${stamp}@test.invalid`,
        passwordHash: "x",
        role: "admin",
      },
    })
  ).id;
  foreignId = (
    await db.user.create({
      data: {
        email: `a2a-logs-other-${stamp}@test.invalid`,
        passwordHash: "x",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `a2a-logs-${stamp}`,
        name: "Logging fixture",
        ownerId: userId,
      },
    })
  ).id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `a2a-logs-foreign-${stamp}`,
        name: "Foreign logging fixture",
        ownerId: foreignId,
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "fixture",
        name: "Logging fixture",
        runtimeKind: "claude-code",
      },
    })
  ).id;
  const endpoint = await db.agentEndpoint.create({
    data: {
      workspaceId,
      sourceAgentId: agentId,
      publicId: `agep_${stamp.replaceAll("-", "")}`,
      name: "Logging service",
      status: "active",
      a2aEnabled: true,
      rpmLimit: 10000,
      dailyRequestLimit: 100000,
      maxConcurrent: 20,
    },
  });
  endpointId = endpoint.id;
  publicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId,
      version: 1,
      systemPrompt: "Fixture not executed",
      runtimeImage: "fixture-not-executed",
      toolPolicy: {},
    },
  });
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { currentRevisionId: revision.id },
  });
  clientId = (
    await db.agentApiClient.create({
      data: {
        endpointId,
        name: "Logging client",
        scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
        rpmLimit: 10000,
        dailyRequestLimit: 100000,
        maxConcurrent: 20,
      },
    })
  ).id;
  token = (
    await createAgentApiKey({
      clientId,
      endpointPublicId: publicId,
      workspaceId,
      sourceAgentId: agentId,
      name: "Logging key",
    })
  ).token;
  historicalGrant = (
    await resolveA2AGrant(
      new Request(`http://localhost/api/v1/agent-endpoints/${publicId}/a2a`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      publicId,
    )
  ).grant;
  retainedTaskId = (await retainedHistory()).id;
  previousSetting =
    (await db.systemSetting.findUnique({ where: { key: LOG_SETTINGS_KEY } }))
      ?.value ?? null;
  await db.systemSetting.upsert({
    where: { key: LOG_SETTINGS_KEY },
    create: { key: LOG_SETTINGS_KEY, value: '{"captures":[]}' },
    update: { value: '{"captures":[]}' },
  });
  invalidateLogSettings();
});
afterAll(async () => {
  if (previousSetting === null)
    await db.systemSetting.deleteMany({ where: { key: LOG_SETTINGS_KEY } });
  else if (previousSetting !== undefined)
    await db.systemSetting.upsert({
      where: { key: LOG_SETTINGS_KEY },
      create: { key: LOG_SETTINGS_KEY, value: previousSetting },
      update: { value: previousSetting },
    });
  invalidateLogSettings();
  await db.logEvent.deleteMany({
    where: { OR: [{ workspaceId }, { requestId: { in: requestIds } }] },
  });
  await db.auditEvent.deleteMany({
    where: {
      OR: [{ workspaceId }, { actorId: { in: [userId, adminId, foreignId] } }],
    },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.user.deleteMany({
    where: { id: { in: [userId, adminId, foreignId] } },
  });
});
async function call(body: unknown, credential = token) {
  const response = await POST(
    new Request(`http://localhost/api/v1/agent-endpoints/${publicId}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "a2a-version": "1.0",
        authorization: `Bearer ${credential}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ endpointId: publicId }) },
  );
  const requestId = assertDefined(response.headers.get("x-request-id"));
  requestIds.push(requestId);
  const result = await response.json();
  const events = await db.logEvent.findMany({
    where: { requestId, domain: "a2a", eventName: "a2a.request" },
    include: { detail: true },
  });
  expect(events).toHaveLength(1);
  return { response, result, event: events[0] };
}
const readTaskRequest = () => ({
  jsonrpc: "2.0",
  id: 1,
  method: "GetTask",
  params: { id: retainedTaskId },
});

/** Already-recorded history is imported directly; retired runtimes are never admitted or dispatched. */
async function retainedHistory(
  state: TaskState = TaskState.TASK_STATE_COMPLETED,
) {
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  return db.$transaction(async (tx) => {
    const context = await tx.a2AContext.create({
      data: {
        workspaceId,
        targetKind: "published",
        endpointId,
        clientId,
        revisionId: historicalGrant.revisionId,
        ownerKey: historicalGrant.ownerKey,
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const id = randomUUID(),
      at = new Date();
    const input = SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: retainedCallerInput }],
      },
    });
    const snapshot = Task.fromJSON({
      id,
      contextId: context.id,
      history: [Message.toJSON(assertDefined(input.message))],
      status: { state, timestamp: at.toISOString() },
      artifacts:
        state === TaskState.TASK_STATE_COMPLETED
          ? [textArtifact("日志验收-hello password=fixture-private")]
          : [],
    });
    const row = await tx.a2ATask.create({
      data: {
        id,
        contextId: context.id,
        state,
        statusAt: at,
        phase: terminal(state) ? "done" : "executing",
        executionBackend: "legacy",
        leaseToken:
          state === TaskState.TASK_STATE_WORKING ? randomUUID() : null,
        completedAt: terminal(state) ? at : null,
        deadlineAt: new Date(Date.now() + 60_000),
        snapshot: json(Task.toJSON(snapshot)),
        request: json(SendMessageRequest.toJSON(input)),
        grant: json(historicalGrant),
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

/** Native task history exists independently of optional transport LogDetail rows. */
async function nativeLedger(
  input: {
    workspaceId?: string;
    rootTaskId?: string;
    parentTaskId?: string;
    request?: Prisma.InputJsonValue;
    snapshot?: Prisma.InputJsonValue;
    events?: Prisma.InputJsonValue[];
    grant?: Prisma.InputJsonValue;
  } = {},
) {
  const id = randomUUID();
  const targetAgentId = input.workspaceId
    ? (
        await db.agent.create({
          data: {
            workspaceId: input.workspaceId,
            slug: `native-logging-${id}`,
            name: "Foreign native ledger",
            runtimeKind: "pi-sdk",
          },
        })
      ).id
    : agentId;
  const context = await db.a2AContext.create({
    data: {
      workspaceId: input.workspaceId ?? workspaceId,
      targetKind: "local",
      agentId: targetAgentId,
      targetBinding: `local:${targetAgentId}`,
      ownerKey: `native-logging:${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return db.a2ATask.create({
    data: {
      id,
      contextId: context.id,
      rootTaskId: input.rootTaskId ?? id,
      parentTaskId: input.parentTaskId,
      executionBackend: "native",
      state: TaskState.TASK_STATE_COMPLETED,
      phase: "done",
      completedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60_000),
      grant: input.grant ?? {
        actorId: userId,
        privateAuthority: "never-disclose-grant",
      },
      request: input.request ?? {},
      snapshot: input.snapshot ?? {
        id,
        status: { state: "TASK_STATE_COMPLETED" },
      },
      events: {
        create: (input.events ?? []).map((payload, index) => ({
          sequence: index + 1,
          payload,
        })),
      },
    },
  });
}

describe("real authorized retained A2A protocol logging", () => {
  it("projects a bounded deadline code without exposing status detail in summaries", async () => {
    const row = await retainedHistory(TaskState.TASK_STATE_FAILED);
    try {
      const task = Task.fromJSON(row.snapshot);
      assertDefined(task.status).message = Message.fromJSON({
        messageId: randomUUID(),
        role: "ROLE_AGENT",
        parts: [
          {
            text: "PI_TASK_TOOL_TIMEOUT: private-tool-result password=private-value",
          },
        ],
      });
      await db.a2ATask.update({
        where: { id: row.id },
        data: { snapshot: Task.toJSON(task) as Prisma.InputJsonValue },
      });
      for (const scope of [
        { kind: "workspace", workspaceId, userId },
        { kind: "admin", userId: adminId },
      ] as const) {
        const page = await listA2ATasks(scope, { q: row.id });
        const summary = assertDefined(
          page.items.find((item) => item.taskId === row.id),
        );
        expect(summary.error).toBe("PI_TASK_TOOL_TIMEOUT");
        expect(JSON.stringify(summary)).not.toContain("private-tool-result");
        expect((await getA2ATask(scope, row.id))?.summary.error).toBe(
          "PI_TASK_TOOL_TIMEOUT",
        );
      }
    } finally {
      await db.a2AContext.delete({ where: { id: row.contextId } });
    }
  });

  it("captures one redacted history read per access without capture settings or any new execution", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const input = readTaskRequest();
      const first = await call(input);
      expect(first.response.status).toBe(200);
      expect(first.result.result.status.state).toBe("TASK_STATE_COMPLETED");
      expect(first.event).toMatchObject({
        workspaceId,
        actorId: null,
        outcome: "success",
        rpcMethod: "GetTask",
        attributes: {
          data: {
            a2a: {
              clientId,
              taskId: first.result.result.id,
              rootTaskId: first.result.result.id,
            },
          },
        },
      });
      expect(first.event.traceId).toBeTruthy();
      expect(first.event.detail).not.toBeNull();
      const payload = JSON.stringify(assertDefined(first.event.detail).data);
      expect(payload).toContain(retainedCallerInput);
      expect(payload).toContain("TASK_STATE_COMPLETED");
      expect(payload).not.toContain("fixture-private");
      expect(payload).not.toContain(token);
      expect(
        assertDefined(first.event.detail).expiresAt.getTime(),
      ).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(
        JSON.stringify({ ...first.event, detail: undefined }),
      ).not.toContain(retainedCallerInput);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(
        retainedCallerInput,
      );
      const replay = await call(input);
      expect(replay.result.result.id).toBe(first.result.result.id);
      expect(
        await db.a2ATask.count({ where: { context: { endpointId } } }),
      ).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });
  it("does not collect rejected credentials or scope-denied request bodies", async () => {
    const invalid = await call(readTaskRequest(), "invalid-key");
    expect(invalid.response.status).toBe(401);
    expect(invalid.event).toMatchObject({
      outcome: "denied",
      workspaceId: null,
      detail: null,
    });
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { scopes: ["a2a:send"] },
    });
    try {
      const denied = await call(readTaskRequest());
      expect(denied.response.status).toBe(403);
      expect(denied.event.outcome).toBe("denied");
      expect(denied.event.detail).toBeNull();
    } finally {
      await db.agentApiClient.update({
        where: { id: clientId },
        data: { scopes: ["a2a:send", "a2a:read", "a2a:cancel"] },
      });
    }
  });
  it("captures every real SSE event beyond 100 events and 32 KiB without truncation", async () => {
    const retained = await retainedHistory(TaskState.TASK_STATE_WORKING);
    const response = await POST(
      new Request(`http://localhost/api/v1/agent-endpoints/${publicId}/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "a2a-version": "1.0",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "SubscribeToTask",
          params: { id: retained.id },
        }),
      }),
      { params: Promise.resolve({ endpointId: publicId }) },
    );
    const requestId = assertDefined(response.headers.get("x-request-id"));
    requestIds.push(requestId);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = assertDefined(response.body).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const texts = Array.from(
      { length: 125 },
      (_, index) => `stream-${index}-${"完整".repeat(300)}-end`,
    );
    await db.$transaction(async (tx) => {
      await tx.a2AEvent.createMany({
        data: [
          ...texts.map((text, index) => ({
            taskId: retained.id,
            sequence: index + 2,
            payload: {
              artifactUpdate: {
                taskId: retained.id,
                contextId: retained.contextId,
                artifact: { artifactId: `part-${index}`, parts: [{ text }] },
                append: false,
                lastChunk: true,
              },
            },
          })),
          {
            taskId: retained.id,
            sequence: 127,
            payload: {
              statusUpdate: {
                taskId: retained.id,
                contextId: retained.contextId,
                status: { state: "TASK_STATE_COMPLETED" },
                final: true,
              },
            },
          },
        ],
      });
      const snapshot = Task.fromJSON(retained.snapshot);
      snapshot.status = {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: new Date().toISOString(),
      };
      await tx.a2ATask.update({
        where: { id: retained.id },
        data: {
          state: TaskState.TASK_STATE_COMPLETED,
          phase: "done",
          completedAt: new Date(),
          sequence: 127,
          snapshot: Task.toJSON(snapshot) as Prisma.InputJsonValue,
        },
      });
    });
    let wire = new TextDecoder().decode(first.value);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      wire += new TextDecoder().decode(chunk.value);
    }
    expect(wire).toContain(texts[124]);
    await vi.waitFor(async () => {
      const rows = await db.logEvent.findMany({
        where: { requestId, eventName: "a2a.request" },
        include: { detail: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "success",
        detail: {
          truncated: false,
          data: {
            payload: {
              responseKind: "sse",
              responseComplete: true,
              response: { events: expect.any(Array) },
            },
          },
        },
      });
      const detail = assertDefined(rows[0].detail);
      const payload = detail.data as {
        payload: { response: { events: unknown[] } };
      };
      expect(payload.payload.response.events).toHaveLength(127);
      const serialized = JSON.stringify(payload);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(32_768);
      for (const text of texts) expect(serialized).toContain(text);
      expect(serialized).not.toContain("[TRUNCATED]");
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("fixture-private");
    });
  });

  it("records history stream disconnection once without canceling retained work", async () => {
    const retained = await retainedHistory(TaskState.TASK_STATE_WORKING);
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "SubscribeToTask",
      params: { id: retained.id },
    };
    const response = await POST(
      new Request(`http://localhost/api/v1/agent-endpoints/${publicId}/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "a2a-version": "1.0",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ endpointId: publicId }) },
    );
    const requestId = assertDefined(response.headers.get("x-request-id"));
    requestIds.push(requestId);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = assertDefined(response.body).getReader();
    const chunk = await reader.read();
    const envelope = JSON.parse(
      new TextDecoder().decode(chunk.value).split("data: ")[1].trim(),
    );
    const taskId = envelope.result.task.id;
    await reader.cancel();
    await vi.waitFor(async () => {
      const rows = await db.logEvent.findMany({
        where: { requestId, eventName: "a2a.request" },
        include: { detail: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "cancelled",
        attributes: { data: { a2a: { taskId } } },
        detail: {
          truncated: false,
          data: { payload: { responseKind: "sse", responseComplete: false } },
        },
      });
      expect(JSON.stringify(assertDefined(rows[0].detail).data)).not.toContain(
        "keep-alive",
      );
    });
    expect(
      await db.a2ATask.findUniqueOrThrow({ where: { id: taskId } }),
    ).toMatchObject({
      state: TaskState.TASK_STATE_WORKING,
      cancelRequestedAt: null,
    });
  });
});

describe("A2A query scope and audited disclosure", () => {
  it.each(["workspace", "admin"] as const)(
    "reads complete redacted native ledger content without transport logs for %s",
    async (kind) => {
      const text = `native-input-${"全文".repeat(20_000)}-end`;
      const output = `native-output-${"result".repeat(8_000)}-end`;
      const message = {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
      };
      const history = [
        message,
        ...Array.from({ length: 125 }, (_, index) => ({
          messageId: `history-${index}`,
          role: "ROLE_AGENT",
          parts: [{ text: `reply-${index}` }],
        })),
      ];
      const parts = Array.from({ length: 125 }, (_, index) => ({
        text: index === 124 ? output : `part-${index}`,
      }));
      let deep: Prisma.InputJsonValue = {
        message: {
          messageId: "deep-message",
          role: "ROLE_AGENT",
          parts: [{ text: "deep-visible password=deep-private" }],
        },
        authorization: "Bearer ledger-private",
        grant: { actorId: "nested-grant-private" },
      };
      for (let index = 0; index < 50; index++) deep = { data: deep };
      const row = await nativeLedger({
        request: { message },
        snapshot: {
          history,
          artifacts: [{ artifactId: "result", parts }],
          data: Object.fromEntries(
            Array.from({ length: 125 }, (_, index) => [
              `field-${index}`,
              `value-${index}`,
            ]),
          ),
          metadata: { private: "file-metadata-private" },
        },
        events: [deep],
      });
      const child = await nativeLedger({
        rootTaskId: row.id,
        parentTaskId: row.id,
        request: {
          message: {
            messageId: "child",
            role: "ROLE_USER",
            parts: [{ text: "same-workspace-child" }],
          },
        },
      });
      const foreign = await nativeLedger({
        workspaceId: foreignWorkspaceId,
        rootTaskId: row.id,
        parentTaskId: row.id,
        request: {
          message: {
            messageId: "foreign",
            role: "ROLE_USER",
            parts: [{ text: "foreign-child-private" }],
          },
        },
        events: [
          {
            message: {
              messageId: "foreign-event",
              role: "ROLE_AGENT",
              parts: [{ text: "foreign-event-private" }],
            },
          },
        ],
      });
      const scope: ViewScope =
        kind === "admin"
          ? { kind: "admin", userId: adminId }
          : { kind: "workspace", workspaceId, userId };
      expect(
        await db.logEvent.count({
          where: {
            attributes: { path: ["data", "a2a", "taskId"], equals: row.id },
          },
        }),
      ).toBe(0);
      const credential = await createApiToken(
        scope.userId,
        "Native detail regression",
      );
      const response = await handleLogRequest(
        new Request(`http://localhost/api/observability/a2a/${row.id}`, {
          headers: { authorization: `Bearer ${credential.token}` },
        }),
        kind === "admin" ? { admin: true } : { slug: `a2a-logs-${stamp}` },
        "a2a",
        row.id,
      );
      expect(response.status).toBe(200);
      const detail = (await response.json()) as A2ATaskDetail;
      expect(
        detail.messages.filter((entry) => entry.id === message.messageId),
      ).toHaveLength(1);
      expect(
        detail.messages.find((entry) => entry.id === message.messageId)?.parts,
      ).toEqual([{ text }]);
      expect(
        detail.messages.find((entry) => entry.id === message.messageId)?.role,
      ).toBe("user");
      expect(
        detail.messages.find((entry) => entry.id === "deep-message")?.role,
      ).toBe("agent");
      expect(detail.messages).toHaveLength(128);
      expect(
        detail.messages.find((entry) => entry.id === "deep-message")?.parts,
      ).toEqual([{ text: 'deep-visible password="[REDACTED]"' }]);
      expect(
        detail.artifacts.find((entry) => entry.id === "result")?.parts,
      ).toEqual(parts);
      expect(detail.tree.map((entry) => entry.taskId).sort()).toEqual(
        [row.id, child.id].sort(),
      );
      expect(detail.tree.some((entry) => entry.taskId === foreign.id)).toBe(
        false,
      );
      expect(
        detail.protocol.every(
          (entry) =>
            entry.source === "ledger" && entry.bodyState === "available",
        ),
      ).toBe(true);
      expect(
        detail.protocol.find(
          (entry) => entry.eventId === `ledger:${row.id}:request`,
        )?.request,
      ).toEqual({ message });
      expect(JSON.stringify(detail.protocol)).toContain(
        '"field-124":"value-124"',
      );
      const serialized = JSON.stringify(detail);
      for (const privateValue of [
        "never-disclose-grant",
        "nested-grant-private",
        "deep-private",
        "ledger-private",
        "file-metadata-private",
        "foreign-child-private",
        "foreign-event-private",
      ])
        expect(serialized).not.toContain(privateValue);
      expect(serialized).not.toContain("[TRUNCATED]");
      expect(
        await db.auditEvent.count({
          where: {
            action: "logging.detail.viewed",
            targetType: "a2aTask",
            targetId: row.id,
            actorId: scope.userId,
            workspaceId,
          },
        }),
      ).toBe(1);
      const page = await listA2ATasks(scope, { q: row.id });
      expect(
        page.items.find((entry) => entry.workspace?.id === workspaceId),
      ).toMatchObject({ taskId: row.id, childCount: 1 });
      expect(JSON.stringify(page)).not.toContain("native-input-");
      const live = await pollA2ATasks(
        scope,
        { q: row.id },
        { createdAt: new Date(Date.now() - 60_000).toISOString(), id: "" },
      );
      expect(JSON.stringify(live)).not.toContain("native-input-");
      for (const foreignScope of [
        {
          kind: "workspace",
          workspaceId: foreignWorkspaceId,
          userId: foreignId,
        },
        { kind: "admin", userId: adminId, workspaceId: foreignWorkspaceId },
      ] as const) {
        // An orphan subtree may resolve by root ID, but only its own workspace is readable.
        const foreignDetail = assertDefined(
          await getA2ATask(foreignScope, row.id),
        );
        expect(foreignDetail.tree.map((entry) => entry.taskId)).toEqual([
          foreign.id,
        ]);
        expect(JSON.stringify(foreignDetail)).not.toContain("native-input-");
        expect(JSON.stringify(foreignDetail)).not.toContain("native-output-");
      }
      expect(
        await getA2ATask(
          { kind: "workspace", workspaceId, userId },
          foreign.id,
        ),
      ).toBeNull();
      await expect(
        getA2ATask(
          { kind: "workspace", workspaceId, userId: foreignId },
          row.id,
        ),
      ).rejects.toBeInstanceOf(LogAccessError);
      await expect(
        getA2ATask({ kind: "admin", userId }, row.id),
      ).rejects.toBeInstanceOf(LogAccessError);
    },
  );

  it("replays artifact increments once and lets the final snapshot replace streamed copies", async () => {
    const artifact = (text: string) => ({
      artifactId: "stream",
      parts: [{ text }],
    });
    const row = await nativeLedger({
      events: [
        { artifactUpdate: { artifact: artifact("a"), append: false } },
        { artifactUpdate: { artifact: artifact("b"), append: true } },
        {
          task: {
            artifacts: [
              { artifactId: "stream", parts: [{ text: "a" }, { text: "b" }] },
            ],
          },
        },
        { artifactUpdate: { artifact: artifact("c"), append: true } },
        {
          artifactUpdate: {
            artifact: { artifactId: "event-only", parts: [{ text: "one" }] },
            append: true,
          },
        },
        {
          artifactUpdate: {
            artifact: { artifactId: "event-only", parts: [{ text: "two" }] },
            append: true,
          },
        },
      ],
      snapshot: {
        artifacts: [
          {
            artifactId: "stream",
            parts: [{ text: "a" }, { text: "b" }, { text: "c" }],
          },
        ],
      },
    });
    const captured = await db.logEvent.create({
      data: {
        workspaceId,
        agentId,
        traceId: row.id,
        spanId: randomUUID(),
        domain: "a2a",
        eventName: "a2a.request",
        message: "a2a.request",
        outcome: "success",
        attributes: {
          data: {
            a2a: {
              direction: "internal",
              transport: "jsonrpc",
              taskId: row.id,
              rootTaskId: row.id,
            },
          },
        },
        detail: {
          create: {
            expiresAt: new Date(Date.now() + 86_400_000),
            data: {
              payload: {
                response: {
                  events: [
                    {
                      artifactUpdate: {
                        artifact: {
                          artifactId: "event-only",
                          parts: [{ text: "one" }],
                        },
                        append: true,
                      },
                    },
                    {
                      artifactUpdate: {
                        artifact: {
                          artifactId: "event-only",
                          parts: [{ text: "two" }],
                        },
                        append: true,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    const detail = assertDefined(
      await getA2ATask({ kind: "workspace", workspaceId, userId }, row.id),
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "stream",
          parts: [{ text: "a" }, { text: "b" }, { text: "c" }],
        }),
        expect.objectContaining({
          id: "event-only",
          parts: [{ text: "one" }, { text: "two" }],
        }),
      ]),
    );
    expect(detail.artifacts).toHaveLength(2);
    expect(
      detail.protocol.filter(
        (entry) => entry.eventId === `ledger:${row.id}:snapshot`,
      ),
    ).toHaveLength(1);
    expect(
      detail.protocol.find((entry) => entry.eventId === captured.id),
    ).toMatchObject({ source: "log", bodyState: "available" });
  });

  it("fails closed when native ledger access cannot be audited", async () => {
    const row = await nativeLedger({
      request: {
        message: { role: "ROLE_USER", parts: [{ text: "audited-only" }] },
      },
    });
    for (const scope of [
      { kind: "workspace", workspaceId, userId },
      { kind: "admin", userId: adminId },
    ] as const) {
      const audit = vi
        .spyOn(db.auditEvent, "create")
        .mockRejectedValueOnce(new Error("audit unavailable"));
      try {
        await expect(getA2ATask(scope, row.id)).rejects.toThrow(
          "audit unavailable",
        );
      } finally {
        audit.mockRestore();
      }
    }
    expect(
      await db.auditEvent.count({
        where: { targetType: "a2aTask", targetId: row.id },
      }),
    ).toBe(0);
  });

  it("audits administrator and workspace body views and denies disclosure on audit failure or expiry", async () => {
    const request = await call(readTaskRequest());
    const id = request.event.id;
    const admin = await getLogEvent({ adminId }, id);
    expect(admin).toMatchObject({ detailState: "available" });
    expect(admin?.detail).toBeTruthy();
    expect(
      await db.auditEvent.count({
        where: { action: "logging.detail.viewed", targetId: id },
      }),
    ).toBe(1);
    const member = await getLogEvent({ userId, workspaceId }, id);
    expect(member).toMatchObject({ detailState: "available" });
    expect(JSON.stringify(member?.detail)).toContain(retainedCallerInput);
    expect(JSON.stringify(member?.detail)).not.toContain("fixture-private");
    const stored = assertDefined(request.event.detail).data;
    expect(member?.detail?.data).toEqual({
      payload:
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? stored.payload
          : undefined,
    });
    expect(
      await db.auditEvent.count({
        where: {
          action: "logging.detail.viewed",
          targetId: id,
          actorId: userId,
        },
      }),
    ).toBe(1);
    await expect(
      getLogEvent({ userId: adminId, workspaceId }, id),
    ).rejects.toBeInstanceOf(LogAccessError);
    for (const scope of [{ adminId }, { userId, workspaceId }]) {
      const audit = vi
        .spyOn(db.auditEvent, "create")
        .mockRejectedValueOnce(new Error("audit unavailable"));
      try {
        await expect(getLogEvent(scope, id)).rejects.toThrow(
          "audit unavailable",
        );
      } finally {
        audit.mockRestore();
      }
    }
    expect(
      await db.auditEvent.count({
        where: { action: "logging.detail.viewed", targetId: id },
      }),
    ).toBe(2);
    await db.logDetail.update({
      where: { eventId: id },
      data: { expiresAt: new Date(0) },
    });
    expect(await getLogEvent({ adminId }, id)).toMatchObject({
      detailState: "expired",
      detail: null,
    });
    expect(await getLogEvent({ userId, workspaceId }, id)).toMatchObject({
      detailState: "expired",
    });
    await db.logDetail.delete({ where: { eventId: id } });
    expect(await getLogEvent({ adminId }, id)).toMatchObject({
      detailState: "unavailable",
      detail: null,
    });
  });
  it.each(["admin", "workspace"])(
    "rechecks expiry after the %s access audit and never leaks details through list or foreign scope",
    async (role) => {
      const request = await call({
        jsonrpc: "2.0",
        id: 6,
        method: "GetTask",
        params: { id: randomUUID() },
      });
      const id = request.event.id;
      const now = Date.now();
      await db.logDetail.update({
        where: { eventId: id },
        data: { expiresAt: new Date(now + 1000), truncated: true },
      });
      const scope = role === "admin" ? { adminId } : { userId, workspaceId };
      const list = await listLogEvents(scope, {
        workspaceId,
        requestId: request.event.requestId,
      });
      expect(list.rows[0]).toMatchObject({ detailState: "truncated" });
      expect(list.rows[0]).not.toHaveProperty("detail");
      const original = auditModule.writeAudit;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const audit = vi
        .spyOn(auditModule, "writeAudit")
        .mockImplementationOnce(async (tx, entry) => {
          const row = await original(tx, entry);
          clock.mockReturnValue(now + 2000);
          return row;
        });
      try {
        expect(await getLogEvent(scope, id)).toMatchObject({
          detailState: "expired",
          detail: null,
        });
      } finally {
        audit.mockRestore();
        clock.mockRestore();
      }
      expect(
        await getLogEvent(
          { userId: foreignId, workspaceId: foreignWorkspaceId },
          id,
        ),
      ).toBeNull();
      expect(
        await getLogTrace(
          { userId: foreignId, workspaceId: foreignWorkspaceId },
          request.event.traceId,
        ),
      ).toEqual([]);
    },
  );
  it("keeps diagnostic data and non-protocol A2A details private", async () => {
    const request = await call({
      jsonrpc: "2.0",
      id: 7,
      method: "GetTask",
      params: { id: randomUUID() },
    });
    const id = request.event.id;
    await db.logDetail.update({
      where: { eventId: id },
      data: {
        data: {
          error: "private diagnostic",
          payload: {
            request: "safe input",
            response: "safe output",
            stack: "private stack",
          },
        },
      },
    });
    const event = await getLogEvent({ userId, workspaceId }, id);
    expect(event?.detail?.data).toEqual({
      payload: { request: "safe input", response: "safe output" },
    });
    for (const update of [
      { outcome: "denied" },
      { outcome: "success", eventName: "a2a.diagnostic" },
      { eventName: "a2a.request", domain: "agent" },
    ]) {
      await db.logEvent.update({ where: { id }, data: update });
      const restricted = await getLogEvent({ userId, workspaceId }, id);
      expect(restricted).toMatchObject({ detailState: "restricted" });
      expect(restricted).not.toHaveProperty("detail");
    }
  });
  it("projects root task trees from retained logs after the ledger is gone and rejects foreign readers", async () => {
    const rootTaskId = randomUUID();
    const childTaskId = randomUUID();
    const contextId = randomUUID();
    const after = {
      createdAt: new Date(Date.now() - 1000).toISOString(),
      id: "",
    };
    for (const [index, taskId] of [rootTaskId, childTaskId].entries()) {
      await db.logEvent.create({
        data: {
          workspaceId,
          agentId,
          traceId: rootTaskId,
          spanId: taskId,
          domain: "a2a",
          eventName: "a2a.task.settled",
          message: "a2a.task.settled",
          outcome: "success",
          durationMs: 100,
          attributes: {
            data: {
              a2a: {
                direction: "inbound",
                transport: "jsonrpc",
                endpointId,
                clientId,
                taskId,
                rootTaskId,
                contextId,
                ...(index ? { parentTaskId: rootTaskId } : {}),
                taskState: "TASK_STATE_COMPLETED",
              },
            },
          },
          detail: {
            create: {
              expiresAt: new Date(Date.now() + 86_400_000),
              data: {
                payload: {
                  response: {
                    id: taskId,
                    contextId,
                    status: { state: "TASK_STATE_COMPLETED" },
                    history: [
                      {
                        messageId: taskId,
                        role: "user",
                        parts: [{ text: "Pruned task safe input" }],
                      },
                    ],
                    artifacts: [
                      {
                        artifactId: taskId,
                        name: "Result",
                        parts: [{ text: "Pruned task safe output" }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      });
    }
    const scope = { kind: "workspace", workspaceId, userId } as const;
    const page = await listA2ATasks(scope, { q: rootTaskId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      taskId: rootTaskId,
      rootTaskId,
      childCount: 1,
    });
    const detail = assertDefined(await getA2ATask(scope, rootTaskId));
    expect(detail.tree.map((task) => task.taskId).sort()).toEqual(
      [rootTaskId, childTaskId].sort(),
    );
    expect(JSON.stringify(detail.messages)).toContain("Pruned task safe input");
    expect(JSON.stringify(detail.artifacts)).toContain(
      "Pruned task safe output",
    );
    expect(detail.summary.to.name).not.toBe(agentId);
    expect(
      (await listA2ATasks(scope, { q: rootTaskId, state: "TASK_STATE_FAILED" }))
        .items,
    ).toEqual([]);
    expect(
      (await listA2ATasks(scope, { q: rootTaskId, direction: "outbound" }))
        .items,
    ).toEqual([]);
    expect(
      await getA2ATask(
        {
          kind: "workspace",
          workspaceId: foreignWorkspaceId,
          userId: foreignId,
        },
        rootTaskId,
      ),
    ).toBeNull();
    expect(
      (
        await listA2ATasks(
          {
            kind: "workspace",
            workspaceId: foreignWorkspaceId,
            userId: foreignId,
          },
          { q: rootTaskId },
        )
      ).items,
    ).toEqual([]);
    const live = await pollA2ATasks(scope, { q: rootTaskId }, after);
    expect(live.items.length).toBeGreaterThan(0);
    expect(
      live.items.every(
        (entry) =>
          entry.item.taskId === rootTaskId &&
          entry.item.workspace?.id === workspaceId,
      ),
    ).toBe(true);
    expect(JSON.stringify(live)).not.toContain("Pruned task safe input");
    expect(
      (
        await pollA2ATasks(
          {
            kind: "workspace",
            workspaceId: foreignWorkspaceId,
            userId: foreignId,
          },
          { q: rootTaskId },
          after,
        )
      ).items,
    ).toEqual([]);
  });
});

describe("Agent runs and genuine A2A separation", () => {
  async function runHistory(
    kind: "chat" | "work" | "channel" | "control" | "trigger" = "chat",
  ) {
    const conversation = await db.conversation.create({
      data: { agentId, title: "Run source title" },
    });
    const work =
      kind === "work"
        ? await db.workSession.create({
            data: {
              workspaceId,
              agentId,
              conversationId: conversation.id,
              runtimeKind: "pi-sdk",
              title: "Work source title",
            },
          })
        : null;
    const grant = {
      kind: "local",
      workspaceId,
      agentId,
      actorId: userId,
      ancestorTaskIds: [],
      ancestorAgentIds: [],
      entryPolicy: {
        kind,
        sourceId: work?.id ?? conversation.id,
        conversationId: conversation.id,
        sourceAgentId: agentId,
        binding: "logging-fixture",
      },
    };
    const row = await nativeLedger({
      grant,
      request: {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: "Run private input" }],
        },
      },
    });
    return { row, grant, conversation, work };
  }

  it.each(["chat", "work", "channel", "control", "trigger"] as const)(
    "lists %s entry roots only as runs, including list, detail and stream",
    async (kind) => {
      const { row, conversation, work } = await runHistory(kind);
      // Historical transport events must not resurrect entry roots in the A2A projection.
      await db.logEvent.create({
        data: {
          workspaceId,
          agentId,
          taskId: row.id,
          domain: "a2a",
          eventName: "a2a.task.settled",
          message: "legacy entry event",
          traceId: row.id,
          spanId: row.id,
          attributes: {
            data: {
              a2a: {
                taskId: row.id,
                rootTaskId: row.id,
                direction: "internal",
                taskState: "TASK_STATE_COMPLETED",
              },
            },
          },
        },
      });
      for (const scope of [
        { kind: "workspace", workspaceId, userId },
        { kind: "admin", userId: adminId, workspaceId },
      ] as const) {
        const page = await listAgentRuns(scope, {
          q: row.id,
          agentId,
          entryKind: kind,
          state: "TASK_STATE_COMPLETED",
        });
        expect(page.items).toEqual([
          expect.objectContaining({
            taskId: row.id,
            entryKind: kind,
            actor: expect.objectContaining({ kind: "user", id: userId }),
            source: {
              kind: work ? "work" : "conversation",
              id: work?.id ?? conversation.id,
              title: work ? "Work source title" : "Run source title",
            },
          }),
        ]);
        expect(page.stats).toMatchObject({ total: 1, success: 1, error: 0 });
        expect(JSON.stringify(page)).not.toContain("Run private input");
        expect((await listA2ATasks(scope, { q: row.id })).items).toEqual([]);
        expect(await getA2ATask(scope, row.id)).toBeNull();
        expect(
          (
            await pollA2ATasks(
              scope,
              { q: row.id },
              {
                createdAt: new Date(Date.now() - 60_000).toISOString(),
                id: "",
              },
            )
          ).items,
        ).toEqual([]);
        expect(
          (
            await pollAgentRuns(
              scope,
              { q: row.id },
              {
                createdAt: new Date(Date.now() - 60_000).toISOString(),
                id: "",
              },
            )
          ).items.length,
        ).toBeGreaterThan(0);
        expect(
          JSON.stringify(
            assertDefined(await getAgentRun(scope, row.id)).messages,
          ),
        ).toContain("Run private input");
      }
      await db.conversation.delete({ where: { id: conversation.id } });
      expect(
        (
          await listAgentRuns(
            { kind: "workspace", workspaceId, userId },
            { q: row.id },
          )
        ).items[0].source,
      ).toBeNull();
    },
  );

  it("re-roots each delegation branch below the run and preserves origin at every depth", async () => {
    const { row, grant } = await runHistory();
    const child = await nativeLedger({
      rootTaskId: row.id,
      parentTaskId: row.id,
      grant: {
        ...grant,
        ancestorTaskIds: [row.id],
        ancestorAgentIds: [agentId],
      },
    });
    const descendant = await nativeLedger({
      rootTaskId: row.id,
      parentTaskId: child.id,
      grant: {
        ...grant,
        ancestorTaskIds: [row.id, child.id],
        ancestorAgentIds: [agentId, agentId],
      },
    });
    const other = await nativeLedger({
      rootTaskId: row.id,
      parentTaskId: row.id,
      grant: {
        ...grant,
        ancestorTaskIds: [row.id],
        ancestorAgentIds: [agentId],
      },
    });
    const scope = { kind: "workspace", workspaceId, userId } as const;
    const page = await listA2ATasks(scope, { q: child.id });
    expect(page.items).toEqual([
      expect.objectContaining({
        taskId: child.id,
        rootTaskId: child.id,
        childCount: 1,
        origin: {
          runTaskId: row.id,
          agent: { id: agentId, name: "Logging fixture" },
          entryKind: "chat",
        },
      }),
    ]);
    const detail = assertDefined(await getA2ATask(scope, descendant.id));
    expect(detail.summary.origin?.runTaskId).toBe(row.id);
    expect(detail.tree.map((task) => task.taskId).sort()).toEqual(
      [child.id, descendant.id].sort(),
    );
    expect(
      detail.tree.find((task) => task.taskId === child.id)?.parentTaskId,
    ).toBeNull();
    const live = await pollA2ATasks(
      scope,
      { q: child.id },
      { createdAt: new Date(Date.now() - 60_000).toISOString(), id: "" },
    );
    expect(
      live.items.every(
        (entry) =>
          entry.item.origin?.runTaskId === row.id &&
          entry.item.rootTaskId === child.id,
      ),
    ).toBe(true);
    const run = assertDefined(await getAgentRun(scope, row.id));
    expect(run.summary.delegationCount).toBe(2);
    expect(run.delegations.map((task) => task.taskId).sort()).toEqual(
      [child.id, other.id].sort(),
    );
    expect(
      run.delegations.every((task) => task.origin?.runTaskId === row.id),
    ).toBe(true);
    expect(await getAgentRun(scope, child.id)).toBeNull();
  });

  it("returns 404 across workspaces and requires audited run body disclosure", async () => {
    const { row } = await runHistory();
    const scope = { kind: "workspace", workspaceId, userId } as const;
    const foreign = {
      kind: "workspace",
      workspaceId: foreignWorkspaceId,
      userId: foreignId,
    } as const;
    expect(await getAgentRun(foreign, row.id)).toBeNull();
    expect(
      await getAgentRun(
        { kind: "admin", userId: adminId, workspaceId: foreignWorkspaceId },
        row.id,
      ),
    ).toBeNull();
    const credential = await createApiToken(foreignId, "Foreign run detail");
    const response = await handleLogRequest(
      new Request(`http://localhost/api/logs/agent-runs/${row.id}`, {
        headers: { authorization: `Bearer ${credential.token}` },
      }),
      { slug: `a2a-logs-foreign-${stamp}` },
      "runs",
      row.id,
    );
    expect(response.status).toBe(404);
    await expect(
      getAgentRun({ ...scope, userId: foreignId }, row.id),
    ).rejects.toBeInstanceOf(LogAccessError);
    await expect(
      getAgentRun({ kind: "admin", userId }, row.id),
    ).rejects.toBeInstanceOf(LogAccessError);
    const audit = vi
      .spyOn(db.auditEvent, "create")
      .mockRejectedValueOnce(new Error("audit unavailable"));
    try {
      await expect(getAgentRun(scope, row.id)).rejects.toThrow(
        "audit unavailable",
      );
    } finally {
      audit.mockRestore();
    }
    expect(
      await db.auditEvent.count({
        where: { targetType: "agentRun", targetId: row.id },
      }),
    ).toBe(0);
    expect(assertDefined(await getAgentRun(scope, row.id)).summary.taskId).toBe(
      row.id,
    );
    expect(
      await db.auditEvent.count({
        where: { targetType: "agentRun", targetId: row.id },
      }),
    ).toBe(1);
  });

  it("links tool, MCP and internal call summaries to visible runs and rejects foreign task identities", async () => {
    const { row, grant } = await runHistory();
    const scope = { kind: "workspace", workspaceId, userId } as const;
    await withLogContext({ workspaceId, agentId, taskId: row.id }, async () => {
      await recordEvent({
        domain: "agent",
        eventName: "sandbox.tool",
        toolName: "bash",
        outcome: "success",
      });
      await recordEvent({
        domain: "mcp",
        eventName: "gateway.request",
        rpcMethod: "tools/call",
        toolName: "linked-mcp",
        outcome: "success",
      });
      await recordEvent({
        domain: "mcp",
        eventName: "mcp.internal",
        rpcMethod: "tools/list",
        outcome: "success",
      });
    });
    const detail = assertDefined(await getAgentRun(scope, row.id));
    expect(detail.summary.toolCallCount).toBe(1);
    expect(detail.toolCalls).toEqual([
      expect.objectContaining({
        tool: "bash",
        task: { id: row.id, kind: "run" },
      }),
    ]);
    expect(detail.mcpCalls).toEqual([
      expect.objectContaining({
        tool: "linked-mcp",
        task: { id: row.id, kind: "run" },
      }),
    ]);
    for (const source of ["tools", "calls", "internal"] as const) {
      // Task-linked events remain visible under their existing source predicates.
      const linked = (await listMcpCalls(scope, { source })).items.filter(
        (item) => item.task?.id === row.id,
      );
      expect(linked).toHaveLength(1);
      expect(linked[0].task).toEqual({ id: row.id, kind: "run" });
    }
    const foreignTask = await nativeLedger({ workspaceId: foreignWorkspaceId });
    await withLogContext({ workspaceId, taskId: foreignTask.id }, () =>
      recordEvent({
        domain: "agent",
        eventName: "sandbox.tool",
        toolName: "foreign-task-ref",
      }),
    );
    expect(
      (await listMcpCalls(scope, { source: "tools", tool: "foreign-task-ref" }))
        .items[0].task,
    ).toBeNull();
    const child = await nativeLedger({
      rootTaskId: row.id,
      parentTaskId: row.id,
      grant: {
        ...grant,
        ancestorTaskIds: [row.id],
        ancestorAgentIds: [agentId],
      },
    });
    await withLogContext({ workspaceId, taskId: child.id }, () =>
      recordEvent({
        domain: "agent",
        eventName: "sandbox.tool",
        toolName: "delegated-task-ref",
      }),
    );
    expect(
      (
        await listMcpCalls(scope, {
          source: "tools",
          tool: "delegated-task-ref",
        })
      ).items[0].task,
    ).toEqual({ id: child.id, kind: "a2a" });
    expect(
      assertDefined(await getAgentRun(scope, row.id)).toolCalls,
    ).toHaveLength(1);
  });

  it("serves authenticated run lists and SSE summaries without exposing bodies", async () => {
    const { row } = await runHistory();
    const member = await createApiToken(userId, "Run logs API");
    const admin = await createApiToken(adminId, "Admin run logs API");
    for (const [target, token] of [
      [{ slug: `a2a-logs-${stamp}` }, member.token],
      [{ admin: true }, admin.token],
    ] as const) {
      const url = `http://localhost/api/logs/agent-runs?q=${row.id}`;
      const response = await handleLogRequest(
        new Request(url, { headers: { authorization: `Bearer ${token}` } }),
        target,
        "runs",
      );
      expect(response.status).toBe(200);
      expect((await response.json()).items).toEqual([
        expect.objectContaining({ taskId: row.id }),
      ]);
      const denied = await handleLogRequest(new Request(url), target, "runs");
      expect(denied.status).toBe(401);
      const abort = new AbortController();
      const stream = await handleLogRequest(
        new Request(
          `http://localhost/api/logs/stream?kind=runs&q=${row.id}&since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: abort.signal,
          },
        ),
        target,
        "stream",
      );
      expect(stream.status).toBe(200);
      const reader = assertDefined(stream.body).getReader();
      let wire = "";
      try {
        while (!wire.includes("event: item")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          wire += new TextDecoder().decode(chunk.value);
        }
        expect(wire).toContain("event: item");
        expect(wire).toContain(row.id);
        expect(wire).not.toContain("Run private input");
      } finally {
        abort.abort();
        await reader.cancel();
      }
    }
    const forbidden = await handleLogRequest(
      new Request("http://localhost/api/logs/agent-runs", {
        headers: { authorization: `Bearer ${member.token}` },
      }),
      { admin: true },
      "runs",
    );
    expect(forbidden.status).toBe(403);
  });

  it("bounds each run call section to the newest 200 without truncating its count", async () => {
    const { row } = await runHistory();
    const start = Date.now() - 10_000;
    await db.logEvent.createMany({
      data: Array.from({ length: 202 }, (_, index) => [
        {
          workspaceId,
          taskId: row.id,
          domain: "agent",
          eventName: "sandbox.tool",
          toolName: `tool-${index}`,
          message: "sandbox.tool",
          traceId: row.id,
          spanId: `tool-${index}`,
          createdAt: new Date(start + index),
        },
        {
          workspaceId,
          taskId: row.id,
          domain: "mcp",
          eventName: "gateway.request",
          toolName: `mcp-${index}`,
          message: "gateway.request",
          traceId: row.id,
          spanId: `mcp-${index}`,
          createdAt: new Date(start + index),
        },
      ]).flat(),
    });
    const detail = assertDefined(
      await getAgentRun({ kind: "workspace", workspaceId, userId }, row.id),
    );
    expect(detail.summary.toolCallCount).toBe(202);
    expect(detail.toolCalls).toHaveLength(200);
    expect(detail.mcpCalls).toHaveLength(200);
    expect(detail.toolCalls.map((call) => call.tool)).toEqual(
      Array.from({ length: 200 }, (_, index) => `tool-${201 - index}`),
    );
    expect(detail.mcpCalls.map((call) => call.tool)).toEqual(
      Array.from({ length: 200 }, (_, index) => `mcp-${201 - index}`),
    );
  });
});
