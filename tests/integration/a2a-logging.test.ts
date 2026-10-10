// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createAgentApiKey } from "@/lib/agents/public-api/auth";
import { POST } from "@/app/api/v1/agent-endpoints/[endpointId]/a2a/route";
import {
  LOG_SETTINGS_KEY,
  invalidateLogSettings,
} from "@/lib/observability/settings";
import type * as WorkerModule from "@/lib/a2a/worker";
import { executeA2ATask } from "@/lib/a2a/worker";
import { textArtifact } from "@/lib/a2a/model";
import { withLogContext } from "@/lib/observability/context";
import {
  getLogEvent,
  getLogTrace,
  listLogEvents,
  resolveLogFilters,
  aggregateLogs,
  LogAccessError,
} from "@/lib/observability/queries";
import { createApiToken } from "@/lib/auth/tokens";
import { GET as exportLogs } from "@/app/api/v1/admin/logs/export/route";
import * as auditModule from "@/lib/observability/audit";

// Keep admission real; execution is explicitly driven by deterministic fixtures below.
vi.mock("@/lib/a2a/worker", async (original) => ({
  ...(await original<typeof WorkerModule>()),
  wakeA2AWorker: vi.fn(),
}));
const stamp = randomUUID();
let userId: string,
  adminId: string,
  foreignId: string,
  workspaceId: string,
  foreignWorkspaceId: string,
  agentId: string;
let endpointId: string, publicId: string, clientId: string, token: string;
let previousSetting: string | null;
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
        runtimeKind: "hermes",
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
  else
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
const send = () => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: {
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "日志验收-hello password=fixture-private" }],
    },
    configuration: { returnImmediately: true },
  },
});

describe("real authorized A2A protocol logging", () => {
  it("captures one redacted inbound request per access without capture settings or duplicate task execution", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const input = send();
      const first = await call(input);
      expect(first.response.status).toBe(200);
      expect(first.result.result.task.status.state).toBe(
        "TASK_STATE_SUBMITTED",
      );
      expect(first.event).toMatchObject({
        workspaceId,
        actorId: null,
        outcome: "success",
        rpcMethod: "SendMessage",
        attributes: {
          data: {
            a2a: {
              clientId,
              taskId: first.result.result.task.id,
              rootTaskId: first.result.result.task.id,
            },
          },
        },
      });
      expect(first.event.traceId).toBeTruthy();
      expect(first.event.detail).not.toBeNull();
      const payload = JSON.stringify(assertDefined(first.event.detail).data);
      expect(payload).toContain("日志验收-hello");
      expect(payload).toContain("TASK_STATE_SUBMITTED");
      expect(payload).not.toContain("fixture-private");
      expect(payload).not.toContain(token);
      expect(
        assertDefined(first.event.detail).expiresAt.getTime(),
      ).toBeLessThanOrEqual(Date.now() + 86_400_000);
      expect(
        JSON.stringify({ ...first.event, detail: undefined }),
      ).not.toContain("日志验收-hello");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("日志验收-hello");
      const replay = await call(input);
      expect(replay.result.result.task.id).toBe(first.result.result.task.id);
      expect(
        await db.a2ATask.count({ where: { context: { endpointId } } }),
      ).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });
  it("distinguishes HTTP transport success from RPC business errors and authorized malformed bodies", async () => {
    for (const [input, code] of [
      [
        {
          jsonrpc: "2.0",
          id: 2,
          method: "GetTask",
          params: { id: randomUUID() },
        },
        -32001,
      ],
      ["{bad json password=fixture-private", -32700],
      [{ jsonrpc: "2.0", id: 3, method: "GetTask", params: {} }, -32602],
    ] as const) {
      const result = await call(input);
      expect(result.response.status).toBe(200);
      expect(result.result.error.code).toBe(code);
      expect(result.event).toMatchObject({
        outcome: "error",
        httpStatus: 200,
        attributes: { data: { a2a: { rpcErrorCode: code } } },
      });
      expect(result.event.detail).not.toBeNull();
      expect(
        JSON.stringify(assertDefined(result.event.detail).data),
      ).not.toContain("fixture-private");
    }
  });
  it("does not collect rejected credentials or scope-denied request bodies", async () => {
    const invalid = await call(send(), "invalid-key");
    expect(invalid.response.status).toBe(401);
    expect(invalid.event).toMatchObject({
      outcome: "denied",
      workspaceId: null,
      detail: null,
    });
    await db.agentApiClient.update({
      where: { id: clientId },
      data: { scopes: ["a2a:read"] },
    });
    try {
      const denied = await call(send());
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
  it("records stream disconnection once without canceling accepted work", async () => {
    const input = { ...send(), method: "SendStreamingMessage" };
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
    ).toMatchObject({ state: 1, cancelRequestedAt: null });
  });
  it("keeps asynchronous execution on a new trace and retains only the committed public result", async () => {
    const submitted = await call(send());
    const taskId = submitted.result.result.task.id;
    await withLogContext(
      {
        requestId: "unrelated-wakeup",
        traceId: "unrelated-trace",
        actorId: foreignId,
      },
      () =>
        executeA2ATask(taskId, async () => ({
          state: 3,
          artifact: textArtifact("日志验收-result password=fixture-private"),
        })),
    );
    const rows = await db.logEvent.findMany({
      where: {
        workspaceId,
        domain: "a2a",
        attributes: { path: ["data", "a2a", "taskId"], equals: taskId },
        eventName: { in: ["a2a.task.started", "a2a.task.settled"] },
      },
      include: { detail: true },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventName: "a2a.task.started",
      actorId: null,
      requestId: null,
      durationMs: null,
      detail: null,
    });
    expect(rows[0].traceId).not.toBe("unrelated-trace");
    expect(rows[0].traceId).not.toBe(submitted.event.traceId);
    expect(rows[1]).toMatchObject({
      eventName: "a2a.task.settled",
      outcome: "success",
      requestId: null,
      attributes: {
        data: {
          a2a: { taskState: "TASK_STATE_COMPLETED", rootTaskId: taskId },
        },
      },
    });
    expect(rows[1].traceId).toBe(rows[0].traceId);
    expect(rows[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(assertDefined(rows[1].detail).data)).toContain(
      "日志验收-result",
    );
    expect(JSON.stringify(assertDefined(rows[1].detail).data)).not.toContain(
      "fixture-private",
    );
    expect(JSON.stringify(assertDefined(rows[1].detail).data)).not.toContain(
      "ownerKey",
    );
    expect(JSON.stringify(assertDefined(rows[1].detail).data)).not.toContain(
      "日志验收-hello",
    );
    const fetched = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "GetTask",
      params: { id: taskId },
    });
    expect(JSON.stringify(assertDefined(fetched.event.detail).data)).toContain(
      "日志验收-result",
    );
    expect(
      await db.logEvent.count({
        where: {
          workspaceId,
          eventName: "a2a.request",
          rpcMethod: "SendMessage",
          attributes: { path: ["data", "a2a", "taskId"], equals: taskId },
        },
      }),
    ).toBe(1);
  });
});

describe("A2A query scope and audited disclosure", () => {
  it("audits administrator and workspace body views and denies disclosure on audit failure or expiry", async () => {
    const request = await call(send());
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
    expect(JSON.stringify(member?.detail)).toContain("日志验收-hello");
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
  it("keeps metadata-only filters and SQL aggregates equivalent with tied-time pagination and fixed until", async () => {
    const taskId = `page-${stamp}`;
    const at = new Date();
    await db.logEvent.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        workspaceId,
        domain: "a2a",
        eventName: "a2a.request",
        message: "a2a.request",
        rpcMethod: "GetTask",
        traceId: stamp,
        spanId: String(index),
        durationMs: index + 1,
        createdAt: at,
        attributes: {
          data: {
            a2a: {
              direction: "inbound",
              endpointId,
              clientId,
              taskId,
              contextId: taskId,
              rootTaskId: taskId,
              parentTaskId: taskId,
            },
          },
        },
      })),
    });
    const input = {
      tab: "a2a",
      workspaceId,
      taskId,
      direction: "inbound",
      until: new Date(at.getTime() + 1000),
    };
    const first = await listLogEvents({ userId, workspaceId }, input);
    const second = await listLogEvents(
      { userId, workspaceId },
      { ...input, cursor: first.nextCursor, until: first.until },
    );
    expect(first.rows).toHaveLength(50);
    expect(second.rows).toHaveLength(5);
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row.id)).size,
    ).toBe(55);
    expect(second.until).toBe(first.until);
    for (const key of [
      "taskId",
      "contextId",
      "rootTaskId",
      "parentTaskId",
      "endpointId",
      "clientId",
      "rpcMethod",
      "agentId",
    ] as const) {
      const values = {
        tab: "a2a",
        workspaceId,
        direction: "inbound",
        [key]:
          key === "agentId"
            ? agentId
            : key === "endpointId"
              ? endpointId
              : key === "clientId"
                ? clientId
                : key === "rpcMethod"
                  ? "GetTask"
                  : taskId,
        q: taskId,
        until: first.until,
      };
      const filtered = await listLogEvents({ userId, workspaceId }, values);
      const stats = await aggregateLogs(resolveLogFilters(values));
      expect(stats.total).toBe(55);
      expect(filtered.rows).toHaveLength(50);
    }
    expect(
      (
        await listLogEvents(
          { userId, workspaceId },
          { ...input, agentId: "unrelated-agent" },
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await aggregateLogs(
          resolveLogFilters({ ...input, agentId: "unrelated-agent" }),
        )
      ).total,
    ).toBe(0);
    await db.logEvent.create({
      data: {
        workspaceId,
        agentId,
        domain: "a2a",
        eventName: "a2a.request",
        message: "local",
        traceId: stamp,
        spanId: "local-filter",
        attributes: {
          data: { a2a: { direction: "internal", transport: "mcp", taskId } },
        },
      },
    });
    const combined = { tab: "a2a", workspaceId, agentId, taskId };
    expect((await aggregateLogs(resolveLogFilters(combined))).total).toBe(56);
    const local = await listLogEvents(
      { userId, workspaceId },
      { ...combined, direction: "internal" },
    );
    expect(local.rows.map((row) => row.agentId)).toEqual([agentId]);
    expect(
      (
        await listLogEvents(
          { userId: foreignId, workspaceId: foreignWorkspaceId },
          input,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await listLogEvents(
          { userId, workspaceId },
          { ...input, q: "日志验收-hello" },
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await aggregateLogs(
          resolveLogFilters({ ...input, taskId: "' OR 1=1 --" }),
        )
      ).total,
    ).toBe(0);
  });
  it("counts requests separately from HTTP, lifecycle and outbound polls and exports no bodies", async () => {
    const taskId = `mixed-${stamp}`;
    await db.logEvent.createMany({
      data: [
        ["a2a", "a2a.request", "inbound"],
        ["http", "http.request", "inbound"],
        ["a2a", "a2a.task.started", "internal"],
        ["a2a", "a2a.task.settled", "internal"],
        ["a2a", "a2a.request", "outbound"],
        ["a2a", "a2a.request", "outbound"],
        ["mcp", "gateway.request", "inbound"],
      ].map(([domain, eventName, direction]) => ({
        workspaceId,
        domain,
        eventName,
        message: eventName,
        traceId: taskId,
        spanId: randomUUID(),
        attributes: {
          data: { a2a: { direction, taskId, rootTaskId: taskId } },
        },
      })),
    });
    expect(
      (
        await aggregateLogs(
          resolveLogFilters({
            tab: "a2a",
            workspaceId,
            direction: "inbound",
            q: taskId,
          }),
        )
      ).total,
    ).toBe(1);
    expect(
      (
        await aggregateLogs(
          resolveLogFilters({
            domain: "mcp",
            eventName: "gateway.request",
            workspaceId,
            q: taskId,
          }),
        )
      ).total,
    ).toBe(1);
    expect(
      (await listLogEvents({ userId, workspaceId }, { tab: "a2a", taskId }))
        .rows,
    ).toHaveLength(5);
    expect(
      (
        await listLogEvents(
          { userId, workspaceId },
          { tab: "a2a", domain: "mcp", q: taskId },
        )
      ).rows,
    ).toHaveLength(3);
    const credential = await createApiToken(adminId, "A2A metadata export");
    const result = await exportLogs(
      new Request(
        `http://localhost/api/v1/admin/logs/export?tab=a2a&domain=mcp&workspaceId=${workspaceId}&taskId=${taskId}`,
        { headers: { authorization: `Bearer ${credential.token}` } },
      ),
    );
    expect(result.status).toBe(200);
    const rows = (await result.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(5);
    expect(
      rows.every(
        (row) =>
          row.domain === "a2a" &&
          !("detail" in row) &&
          !("request" in row) &&
          !("response" in row),
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("日志验收-hello");
  });
});
