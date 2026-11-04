// @vitest-environment node
import { randomUUID } from "node:crypto";
import { assertDefined } from "../assert-defined";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/observability/events";
import { logRequest } from "@/lib/observability/log";
import { withLogContext } from "@/lib/observability/context";
import { mcpRpc } from "@/lib/process/mcp-client";
import {
  getLogEvent,
  getLogTrace,
  listLogEvents,
  LogAccessError,
} from "@/lib/observability/queries";
import {
  LOG_SETTINGS_KEY,
  invalidateLogSettings,
} from "@/lib/observability/settings";
import { writeAudit } from "@/lib/observability/audit";
import { setUserRole } from "@/lib/admin/users";
import { maintainLogs } from "@/lib/observability/maintenance";
import { createApiToken } from "@/lib/auth/tokens";
import { GET as exportLogs } from "@/app/api/v1/admin/logs/export/route";

const stamp = randomUUID();
let adminId: string;
let userId: string;
let foreignId: string;
let workspaceId: string;
let deploymentId: string;
let previousSetting: string | null;
beforeAll(async () => {
  adminId = (
    await db.user.create({
      data: {
        email: `logs-admin-${stamp}@test.dev`,
        passwordHash: "x",
        role: "admin",
      },
    })
  ).id;
  userId = (
    await db.user.create({
      data: { email: `logs-user-${stamp}@test.dev`, passwordHash: "x" },
    })
  ).id;
  foreignId = (
    await db.user.create({
      data: { email: `logs-other-${stamp}@test.dev`, passwordHash: "x" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `logs-${stamp}`, name: "Log test", ownerId: userId },
    })
  ).id;
  deploymentId = (
    await db.deployment.create({
      data: { workspaceId, name: "Log MCP", source: "config" },
    })
  ).id;
  previousSetting =
    (await db.systemSetting.findUnique({ where: { key: LOG_SETTINGS_KEY } }))
      ?.value ?? null;
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
  await db.logEvent.deleteMany({ where: { workspaceId } });
  await db.auditEvent.deleteMany({
    where: { actorId: { in: [adminId, userId, foreignId] } },
  });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({
    where: { id: { in: [adminId, userId, foreignId] } },
  });
});

describe("durable scoped logging", () => {
  it("captures redacted details only during an enabled diagnostic window and denies cross-workspace reads", async () => {
    const value = JSON.stringify({
      captures: [
        {
          field: "workspaceId",
          id: workspaceId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    await db.systemSetting.upsert({
      where: { key: LOG_SETTINGS_KEY },
      create: { key: LOG_SETTINGS_KEY, value },
      update: { value },
    });
    invalidateLogSettings();
    await withLogContext(
      { workspaceId, actorId: userId, secrets: ["fixture-private-key"] },
      () =>
        recordEvent({
          domain: "mcp",
          eventName: "test.failure",
          payloadPolicy: "diagnostic",
          error: new Error("upstream failed: fixture-private-key", {
            cause: new Error("timeout"),
          }),
          detail: { apiKey: "never-store", query: "safe" },
        }),
    );
    const result = await listLogEvents({ adminId }, { workspaceId });
    expect(result.rows).toHaveLength(1);
    const event = await getLogEvent({ adminId }, result.rows[0].id);
    expect(event?.detail).toBeTruthy();
    expect(JSON.stringify(event)).not.toContain("fixture-private-key");
    expect(JSON.stringify(event)).not.toContain("never-store");
    expect(JSON.stringify(event?.detail)).toContain("timeout");
    await expect(listLogEvents({ adminId: userId }, {})).rejects.toBeInstanceOf(
      LogAccessError,
    );
    await expect(
      getLogEvent({ userId: foreignId, workspaceId }, result.rows[0].id),
    ).rejects.toBeInstanceOf(LogAccessError);
    await expect(
      getLogTrace({ userId: foreignId, workspaceId }, result.rows[0].traceId),
    ).rejects.toBeInstanceOf(LogAccessError);
    const own = await getLogEvent({ userId, workspaceId }, result.rows[0].id);
    expect(own).not.toHaveProperty("detail");
  });

  it("expires diagnostic capture without restarting", async () => {
    await db.systemSetting.update({
      where: { key: LOG_SETTINGS_KEY },
      data: {
        value: JSON.stringify({
          captures: [
            {
              field: "workspaceId",
              id: workspaceId,
              expiresAt: new Date(Date.now() - 1).toISOString(),
            },
          ],
        }),
      },
    });
    invalidateLogSettings();
    await recordEvent({
      domain: "mcp",
      workspaceId,
      eventName: "test.no-payload",
      detail: { request: "not captured" },
    });
    const noPayload = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, eventName: "test.no-payload" },
      include: { detail: true },
    });
    expect(noPayload.detail).toBeNull();
  });

  it("stores sanitized workspace MCP payloads, including calls inside Agent sessions", async () => {
    await db.systemSetting.update({
      where: { key: LOG_SETTINGS_KEY },
      data: { value: JSON.stringify({ captures: [] }) },
    });
    invalidateLogSettings();
    const response = {
      ok: true,
      content: Array.from({ length: 150 }, (_, index) => ({
        index,
        text: `${"字".repeat(1000)} ${index === 149 ? "fixture-private-key" : "safe"} tail`,
      })),
    };
    await withLogContext(
      { workspaceId, secrets: ["fixture-private-key"] },
      () =>
        logRequest({
          workspaceId,
          deploymentId,
          method: "POST",
          path: `/mcp/${deploymentId}/rpc#tools/call:workspace-payload`,
          statusCode: 200,
          durationMs: 1,
          requestBody: JSON.stringify({
            value: "fixture-private-key",
            safe: "yes",
          }),
          responseBody: JSON.stringify(response),
        }),
    );
    const captured = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, toolName: "workspace-payload" },
      include: { detail: true },
    });
    expect(captured.detail?.data).toMatchObject({
      payload: {
        request: { value: "[REDACTED]", safe: "yes" },
        response: {
          ...response,
          content: response.content.map((item) => ({
            ...item,
            text: item.text.replace("fixture-private-key", "[REDACTED]"),
          })),
        },
      },
    });
    expect(captured.detail?.truncated).toBe(false);
    const readable = await getLogEvent({ userId, workspaceId }, captured.id);
    expect(readable?.detailState).toBe("available");
    expect(readable?.detail?.data).toEqual({
      payload: {
        request: { value: "[REDACTED]", safe: "yes" },
        response: {
          ...response,
          content: response.content.map((item) => ({
            ...item,
            text: item.text.replace("fixture-private-key", "[REDACTED]"),
          })),
        },
      },
    });
    expect(assertDefined(captured.detail).expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );

    await withLogContext(
      {
        workspaceId,
        agentId: "agent-fixture",
        secrets: ["fixture-private-key"],
      },
      () =>
        recordEvent({
          domain: "mcp",
          eventName: "mcp.rpc",
          deploymentId,
          toolName: "agent-payload",
          detail: {
            request: { value: "fixture-private-key", text: "agent-visible" },
          },
        }),
    );
    const agentCall = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, toolName: "agent-payload" },
      include: { detail: true },
    });
    expect(agentCall.detail?.data).toMatchObject({
      workspaceMcpPayload: true,
      payload: { request: { value: "[REDACTED]", text: "agent-visible" } },
    });
    expect(assertDefined(agentCall.detail).expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
  });

  it("lets workspace members read failed MCP calls made inside Agent sessions", async () => {
    await withLogContext({ workspaceId, agentId: "agent-fixture" }, () =>
      mcpRpc(deploymentId, "tools/call", {
        name: "agent-failure",
        arguments: { path: "." },
      }),
    );
    const failed = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, toolName: "agent-failure" },
    });
    expect(failed).toMatchObject({
      outcome: "error",
      errorCode: "deployment_unavailable",
    });
    const visible = await getLogEvent({ userId, workspaceId }, failed.id);
    expect(visible?.detailState).toBe("available");
    expect(visible?.message).toBe("MCP deployment is not running");
    expect(JSON.stringify(visible?.detail)).toContain("agent-failure");
  });

  it("lets workspace members read Agent tool input and output, but not other Agent content", async () => {
    await withLogContext(
      { workspaceId, agentId: "agent-fixture" },
      async () => {
        await recordEvent({
          domain: "agent",
          eventName: "sandbox.tool",
          toolName: "bash",
          detail: { request: { command: "echo visible" }, response: "visible" },
        });
        await recordEvent({
          domain: "agent",
          eventName: "model.call",
          payloadPolicy: "agent-content",
          detail: { prompt: "private-prompt" },
        });
      },
    );
    const tool = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, eventName: "sandbox.tool" },
    });
    const visible = await getLogEvent({ userId, workspaceId }, tool.id);
    expect(visible?.detailState).toBe("available");
    expect(JSON.stringify(visible?.detail)).toContain("echo visible");
    const model = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, eventName: "model.call" },
      include: { detail: true },
    });
    expect(model.detail).toBeNull();
  });

  it("bounds protocol retention by event retention without changing Agent content limits", async () => {
    await db.systemSetting.update({
      where: { key: LOG_SETTINGS_KEY },
      data: {
        value: JSON.stringify({
          eventDays: 2,
          detailDays: 30,
          captures: [
            {
              field: "workspaceId",
              id: workspaceId,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              includeAgentContent: true,
            },
          ],
        }),
      },
    });
    invalidateLogSettings();
    try {
      for (const policy of ["request-response", "agent-content"] as const) {
        await recordEvent({
          workspaceId,
          domain: "a2a",
          eventName: `retention.${policy}`,
          payloadPolicy: policy,
          detail: { request: "safe" },
        });
        const row = await db.logEvent.findFirstOrThrow({
          where: { workspaceId, eventName: `retention.${policy}` },
          include: { detail: true },
        });
        const expires = assertDefined(row.detail).expiresAt.getTime();
        const days = policy === "agent-content" ? 1 : 2;
        expect(expires).toBeGreaterThan(Date.now() + (days - 0.1) * 86_400_000);
        expect(expires).toBeLessThanOrEqual(Date.now() + days * 86_400_000);
      }
    } finally {
      await db.systemSetting.update({
        where: { key: LOG_SETTINGS_KEY },
        data: { value: JSON.stringify({ captures: [] }) },
      });
      invalidateLogSettings();
    }
  });

  it("never captures public run payloads and never serves expired details", async () => {
    await db.systemSetting.update({
      where: { key: LOG_SETTINGS_KEY },
      data: {
        value: JSON.stringify({
          captures: [
            {
              field: "workspaceId",
              id: workspaceId,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      },
    });
    invalidateLogSettings();
    await withLogContext({ workspaceId, suppressPayload: true }, () =>
      recordEvent({
        domain: "agent",
        eventName: "test.public",
        detail: { text: "private-transcript" },
      }),
    );
    const publicEvent = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, eventName: "test.public" },
      include: { detail: true },
    });
    expect(publicEvent.detail).toBeNull();
    const previous = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, eventName: "test.failure" },
    });
    await db.logDetail.update({
      where: { eventId: previous.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect((await getLogEvent({ adminId }, previous.id))?.detail).toBeNull();
  });
  it("returns complete traces beyond 500 events without crossing workspace boundaries", async () => {
    const traceId = randomUUID();
    const createdAt = new Date();
    const rows = Array.from({ length: 550 }, (_, index) => ({
      id: `trace-${stamp}-${String(index).padStart(4, "0")}`,
      domain: "system",
      eventName: "test.large-trace",
      message: "trace fixture",
      workspaceId,
      traceId,
      spanId: `span-${index}`,
      createdAt,
    }));
    await db.logEvent.createMany({ data: rows });
    const foreign = await db.workspace.create({
      data: {
        slug: `foreign-trace-${stamp}`,
        name: "Foreign trace",
        ownerId: foreignId,
      },
    });
    try {
      await db.logEvent.create({
        data: {
          domain: "system",
          eventName: "test.foreign-trace",
          message: "foreign",
          workspaceId: foreign.id,
          traceId,
          spanId: "foreign",
          createdAt,
        },
      });
      const trace = await getLogTrace({ userId, workspaceId }, traceId);
      expect(trace.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(trace.every((row) => row.workspaceId === workspaceId)).toBe(true);
      await expect(
        getLogTrace({ userId: foreignId, workspaceId }, traceId),
      ).rejects.toBeInstanceOf(LogAccessError);
    } finally {
      await db.logEvent.deleteMany({ where: { workspaceId: foreign.id } });
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it("persists complete audit changes with credentials redacted at the payload tail", async () => {
    const tail = `${"字".repeat(50_000)} fixture-private-key tail`;
    const changes = {
      values: Array.from({ length: 150 }, (_, index) => index),
      fields: Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [`field${index}`, index]),
      ),
      tail,
      password: "never-store",
    };
    const audit = await withLogContext(
      { secrets: ["fixture-private-key"] },
      () =>
        writeAudit(db, {
          actorId: adminId,
          workspaceId,
          action: "test.full-audit",
          targetType: "workspace",
          targetId: workspaceId,
          changes,
        }),
    );
    const persisted = await db.auditEvent.findUniqueOrThrow({
      where: { id: audit.id },
    });
    expect(persisted.changes).toEqual({
      ...changes,
      tail: tail.replace("fixture-private-key", "[REDACTED]"),
      password: "[REDACTED]",
    });
  });

  it("authorizes exports with persisted roles and excludes payloads", async () => {
    const exportable = await db.logEvent.create({
      data: {
        domain: "system",
        eventName: "test.export",
        message: "export fixture",
        workspaceId,
        traceId: randomUUID(),
        spanId: "export",
        detail: {
          create: {
            data: { payload: "private-export-payload" },
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });
    const createdAt = new Date(Date.now() - 1000);
    const fixtures = Array.from({ length: 1050 }, (_, index) => ({
      id: `export-${stamp}-${String(index).padStart(4, "0")}`,
      domain: "system",
      eventName: "test.export",
      message: "paged export fixture",
      workspaceId,
      traceId: stamp,
      spanId: `export-${index}`,
      createdAt,
    }));
    await db.logEvent.createMany({ data: fixtures });
    const foreign = await db.workspace.create({
      data: {
        slug: `foreign-export-${stamp}`,
        name: "Foreign export",
        ownerId: foreignId,
      },
    });
    try {
      await db.logEvent.create({
        data: {
          domain: "system",
          eventName: "test.export",
          message: "foreign export fixture",
          workspaceId: foreign.id,
          traceId: stamp,
          spanId: "foreign-export",
          createdAt,
        },
      });
      const regular = await createApiToken(userId, "test");
      const admin = await createApiToken(adminId, "test");
      const toolkit = await db.toolkit.create({
        data: { workspaceId, name: "test", slug: `logs-${stamp}` },
      });
      const scoped = await createApiToken(adminId, "test", {
        toolkitId: toolkit.id,
      });
      const request = (token: string) =>
        new Request(
          `http://localhost/api/v1/admin/logs/export?domain=system&eventName=test.export&workspaceId=${workspaceId}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
      expect((await exportLogs(request(regular.token))).status).toBe(403);
      expect((await exportLogs(request(scoped.token))).status).toBe(401);
      const response = await exportLogs(request(admin.token));
      expect(response.status).toBe(200);
      const rows = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: exportable.id, workspaceId }),
        ]),
      );
      expect(rows).toHaveLength(fixtures.length + 1);
      expect(
        rows.filter((row) => row.id !== exportable.id).map((row) => row.id),
      ).toEqual(fixtures.map((row) => row.id).reverse());
      expect(
        rows.every(
          (row) => row.workspaceId === workspaceId && !("detail" in row),
        ),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("private-export-payload");
      expect(
        await db.auditEvent.count({
          where: { actorId: adminId, action: "logging.exported" },
        }),
      ).toBe(1);
    } finally {
      await db.logEvent.deleteMany({ where: { workspaceId: foreign.id } });
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it("cleans expired records in bounded batches without cascading business deletion into audit history", async () => {
    const ancient = new Date("1970-01-01T00:00:00Z");
    const row = await db.logEvent.create({
      data: {
        domain: "system",
        eventName: "test.retention",
        message: "old",
        workspaceId,
        traceId: stamp,
        spanId: "retention",
        createdAt: ancient,
        detail: { create: { data: {}, expiresAt: ancient } },
      },
    });
    await db.auditEvent.create({
      data: {
        actorId: adminId,
        action: "test.retention",
        targetType: "workspace",
        targetId: workspaceId,
        traceId: stamp,
        createdAt: ancient,
      },
    });
    await maintainLogs(new Date("1971-01-01T00:00:00Z"));
    expect(await db.logEvent.findUnique({ where: { id: row.id } })).toBeNull();
    expect(
      await db.auditEvent.count({
        where: { actorId: adminId, action: "test.retention" },
      }),
    ).toBe(0);
    const deleted = await db.workspace.create({
      data: { name: "deleted", slug: `deleted-${stamp}`, ownerId: userId },
    });
    const audit = await writeAudit(db, {
      actorId: adminId,
      workspaceId: deleted.id,
      action: "test.survives",
      targetType: "workspace",
      targetId: deleted.id,
    });
    await db.workspace.delete({ where: { id: deleted.id } });
    expect(
      await db.auditEvent.findUnique({ where: { id: audit.id } }),
    ).not.toBeNull();
  });

  it("commits role changes with their audit and rolls back mutations when audit persistence fails", async () => {
    await setUserRole(adminId, userId, "admin");
    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        actorId: adminId,
        targetId: userId,
        action: "user.role.changed",
      },
    });
    expect(audit.changes).toMatchObject({
      before: { role: "user" },
      after: { role: "admin" },
    });
    await expect(
      db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { role: "user" } });
        await writeAudit(tx, {
          actorId: null as unknown as string,
          action: "test.invalid",
          targetType: "user",
          targetId: userId,
        });
      }),
    ).rejects.toThrow();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: userId } })).role,
    ).toBe("admin");
  });
});
