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

describe("real authorized retained A2A protocol logging", () => {
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
      ).toBeLessThanOrEqual(Date.now() + 86_400_000);
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
});
