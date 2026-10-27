// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/observability/events";
import { logRequest } from "@/lib/observability/log";
import { withLogContext } from "@/lib/observability/context";
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

  it("stores sanitized workspace MCP payloads without exposing Agent content", async () => {
    await db.systemSetting.update({
      where: { key: LOG_SETTINGS_KEY },
      data: { value: JSON.stringify({ captures: [] }) },
    });
    invalidateLogSettings();
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
          responseBody: JSON.stringify({ ok: true }),
        }),
    );
    const captured = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, toolName: "workspace-payload" },
      include: { detail: true },
    });
    expect(captured.detail?.data).toMatchObject({
      payload: {
        request: { value: "[REDACTED]", safe: "yes" },
        response: { ok: true },
      },
    });

    await withLogContext({ workspaceId, agentId: "agent-fixture" }, () =>
      recordEvent({
        domain: "mcp",
        eventName: "mcp.rpc",
        deploymentId,
        toolName: "agent-payload",
        detail: { request: "private-agent-content" },
      }),
    );
    const suppressed = await db.logEvent.findFirstOrThrow({
      where: { workspaceId, toolName: "agent-payload" },
      include: { detail: true },
    });
    expect(suppressed.detail).toBeNull();
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
        `http://localhost/api/v1/admin/logs/export?domain=system&workspaceId=${workspaceId}`,
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
