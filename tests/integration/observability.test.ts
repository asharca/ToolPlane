// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  getDeploymentLogs,
  getObservability,
  logRequest,
} from "@/lib/observability/log";
import { withLogContext } from "@/lib/observability/context";
import { recordEvent } from "@/lib/observability/events";
import { LogAccessError } from "@/lib/observability/queries";

const runtime = vi.hoisted(() => ({ port: 0 }));
vi.mock("@/lib/process/supervisor", () => ({
  livePort: () => runtime.port,
  liveMcpRuntimeSnapshot: () => ({
    port: runtime.port,
    redactionValues: ["fixture-upstream-secret"],
  }),
}));
import { mcpRpc } from "@/lib/process/mcp-client";

const stamp = Date.now();
let userId = "";
let workspaceId = "";
let deploymentId = "";
let foreignUserId = "";
let foreignWorkspaceId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `observability-${stamp}@test.dev`, passwordHash: "x" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `observability-${stamp}`,
      name: "Observability test workspace",
      ownerId: userId,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Seed MCP",
      source: "config",
      status: "running",
    },
  });
  deploymentId = deployment.id;

  const now = Date.now();
  await db.logEvent.createMany({
    data: [
      ...Array.from({ length: 55 }, (_, index) => ({
        workspaceId,
        deploymentId,
        method: "POST",
        path: `/mcp/${deploymentId}/rpc#tools/call:echo`,
        httpStatus: index % 10 === 0 ? 500 : 200,
        outcome: index % 10 === 0 ? "error" : "success",
        domain: "mcp",
        eventName: "gateway.request",
        message: "echo",
        traceId: `obs-${stamp}`,
        spanId: `span-${index}`,
        durationMs: 20 + index,
        createdAt: new Date(now - index * 10 * 60 * 1000),
      })),
      {
        workspaceId,
        deploymentId,
        method: "POST",
        path: `/mcp/${deploymentId}/rpc#tools/call:semantic_failure`,
        httpStatus: 200,
        outcome: "error",
        domain: "mcp",
        eventName: "gateway.request",
        message: "tool failed",
        traceId: `obs-${stamp}`,
        spanId: "semantic",
        durationMs: 31,
        createdAt: new Date(now - 56 * 10 * 60 * 1000),
      },
      {
        workspaceId,
        method: "GET",
        path: "/workspaces/test/manifest",
        httpStatus: 200,
        domain: "mcp",
        eventName: "gateway.request",
        message: "manifest",
        traceId: `obs-${stamp}`,
        spanId: "api",
        durationMs: 12,
        createdAt: new Date(now - 60 * 60 * 1000),
      },
    ],
  });

  const foreignUser = await db.user.create({
    data: {
      email: `observability-foreign-${stamp}@test.dev`,
      passwordHash: "x",
    },
  });
  foreignUserId = foreignUser.id;
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `observability-foreign-${stamp}`,
      name: "Foreign observability workspace",
      ownerId: foreignUserId,
      members: { create: { userId: foreignUserId, role: "owner" } },
    },
  });
  foreignWorkspaceId = foreignWorkspace.id;
  // Deployment IDs are snapshots on LogEvent. This row verifies the
  // reader cannot leak a malformed/cross-workspace record by deployment ID.
  await db.logEvent.create({
    data: {
      workspaceId: foreignWorkspaceId,
      deploymentId,
      method: "POST",
      path: "/foreign/rpc#tools/call:should_not_leak",
      httpStatus: 200,
      domain: "mcp",
      eventName: "gateway.request",
      message: "foreign",
      traceId: `obs-${stamp}`,
      spanId: "foreign",
      durationMs: 1,
    },
  });
});

afterAll(async () => {
  await db.logEvent.deleteMany({
    where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.workspace.delete({ where: { id: foreignWorkspaceId } });
  await db.user.delete({ where: { id: foreignUserId } });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("getObservability", () => {
  it("returns bounded recent details, hourly buckets, and deployment rollups", async () => {
    const result = await getObservability(
      workspaceId,
      "Asia/Shanghai",
      24,
      undefined,
      { userId },
    );

    expect(result.total).toBe(57);
    expect(result.errors).toBe(7);
    expect(result.series).toHaveLength(24);
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]).toMatchObject({
      deploymentId,
      deploymentName: "Seed MCP",
      requestBody: null,
      responseBody: null,
    });
    expect(result.deploymentUsage).toContainEqual(
      expect.objectContaining({
        id: deploymentId,
        name: "Seed MCP",
        total: 56,
        errors: 7,
      }),
    );
    expect(result.deploymentUsage).toContainEqual(
      expect.objectContaining({
        id: null,
        name: "Workspace API",
        total: 1,
      }),
    );
  });

  it("scopes deployment filters to the workspace", async () => {
    const result = await getObservability(
      workspaceId,
      "UTC",
      24,
      deploymentId,
      { userId },
    );

    expect(result.selectedDeployment).toBe("Seed MCP");
    expect(result.total).toBe(56);
    expect(result.deploymentUsage).toHaveLength(1);
    expect(result.deploymentUsage[0]?.id).toBe(deploymentId);
  });

  it("keeps deployment request logs within the requested workspace", async () => {
    const traceId = `deployment-activity-${stamp}`;
    await db.logEvent.create({
      data: {
        workspaceId,
        deploymentId,
        domain: "mcp",
        eventName: "gateway.request",
        message: "echo",
        traceId,
        spanId: "gateway-tool",
        rpcMethod: "tools/call",
        toolName: "echo",
        durationMs: 12,
        detail: {
          create: {
            data: {
              workspaceMcpPayload: true,
              payload: {
                request: { name: "echo", arguments: { text: "hello" } },
                response: { content: [{ type: "text", text: "hello" }] },
              },
            },
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });
    await db.logEvent.createMany({
      data: [
        {
          workspaceId,
          deploymentId,
          domain: "mcp",
          eventName: "mcp.rpc",
          message: "mcp.rpc",
          traceId,
          spanId: "rpc-tool",
          rpcMethod: "tools/call",
          toolName: "echo",
          durationMs: 10,
        },
        {
          workspaceId,
          deploymentId,
          domain: "mcp",
          eventName: "mcp.rpc",
          message: "mcp.rpc",
          traceId: `${traceId}-list`,
          spanId: "rpc-list",
          rpcMethod: "tools/list",
          durationMs: 8,
        },
      ],
    });

    const logs = await getDeploymentLogs(
      workspaceId,
      deploymentId,
      100,
      userId,
    );

    expect(logs).toHaveLength(58);
    expect(logs.filter((log) => log.traceId === traceId)).toHaveLength(1);
    const toolLog = assertDefined(logs.find((log) => log.traceId === traceId));
    expect(JSON.parse(assertDefined(toolLog.requestBody))).toEqual({
      name: "echo",
      arguments: { text: "hello" },
    });
    expect(JSON.parse(assertDefined(toolLog.responseBody))).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
    expect(toolLog).not.toHaveProperty("detail");
    expect(
      logs.some(
        (log) => log.eventName === "mcp.rpc" && log.rpcMethod === "tools/list",
      ),
    ).toBe(true);
    expect(logs.some((log) => log.path.includes("should_not_leak"))).toBe(
      false,
    );
  });

  it("persists real wire envelopes and upstream errors without inventing transport responses", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      received.push(rpc);
      if (rpc.params?.name === "disconnect") {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          ...(rpc.method === "tools/list"
            ? { result: { tools: [] } }
            : {
                error: {
                  code: -32601,
                  message: "Unknown tool fixture-upstream-secret",
                  data: { reason: "missing" },
                },
              }),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    runtime.port = (server.address() as AddressInfo).port;
    const traceId = `wire-${stamp}`;
    try {
      await withLogContext({ workspaceId, traceId }, async () => {
        await expect(mcpRpc(deploymentId, "tools/list")).resolves.toEqual({
          tools: [],
        });
        await expect(
          mcpRpc(deploymentId, "tools/call", {
            name: "missing",
            arguments: { text: "fixture-upstream-secret" },
          }),
        ).resolves.toBeNull();
        await logRequest({
          workspaceId,
          deploymentId,
          method: "POST",
          path: `/mcp/${deploymentId}/rpc#tools/call:missing`,
          statusCode: 502,
          durationMs: 1,
          requestBody: JSON.stringify({
            method: "tools/call",
            params: { name: "missing", arguments: {} },
          }),
        });
        await expect(
          mcpRpc(deploymentId, "tools/call", {
            name: "disconnect",
            arguments: {},
          }),
        ).resolves.toBeNull();
      });
      const logs = (
        await getDeploymentLogs(workspaceId, deploymentId, 100, userId)
      ).filter((log) => log.traceId === traceId);
      const listed = assertDefined(
        logs.find((log) => log.rpcMethod === "tools/list"),
      );
      expect(JSON.parse(assertDefined(listed.requestBody))).toEqual(
        received[0],
      );
      expect(JSON.parse(assertDefined(listed.requestBody))).toEqual({
        jsonrpc: "2.0",
        id: expect.any(Number),
        method: "tools/list",
      });
      expect(JSON.parse(assertDefined(listed.responseBody))).toEqual({
        jsonrpc: "2.0",
        id: received[0].id,
        result: { tools: [] },
      });
      const failed = logs.filter((log) => log.toolName === "missing");
      expect(failed).toHaveLength(1);
      expect(failed[0].eventName).toBe("gateway.request");
      expect(JSON.parse(assertDefined(failed[0].requestBody))).toEqual({
        ...received[1],
        params: { name: "missing", arguments: { text: "[REDACTED]" } },
      });
      expect(JSON.parse(assertDefined(failed[0].responseBody))).toEqual({
        jsonrpc: "2.0",
        id: received[1].id,
        error: {
          code: -32601,
          message: "Unknown tool [REDACTED]",
          data: { reason: "missing" },
        },
      });
      expect(logs.find((log) => log.toolName === "disconnect")).toMatchObject({
        outcome: "error",
        responseBody: null,
      });
      expect(JSON.stringify(logs)).not.toContain("fixture-upstream-secret");
      const overview = await getObservability(
        workspaceId,
        "UTC",
        24,
        deploymentId,
        { userId, q: traceId },
      );
      expect(overview.total).toBe(1);
      expect(overview.recent).toMatchObject([
        {
          requestBody: failed[0].requestBody,
          responseBody: failed[0].responseBody,
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      runtime.port = 0;
    }
  });

  it("rejects unauthorized readers and never joins another workspace payload", async () => {
    await expect(
      getObservability(workspaceId, "UTC", 24, undefined, {
        userId: foreignUserId,
      }),
    ).rejects.toBeInstanceOf(LogAccessError);
    await expect(
      getDeploymentLogs(workspaceId, deploymentId, 100, foreignUserId),
    ).rejects.toBeInstanceOf(LogAccessError);
    const traceId = `cross-workspace-${stamp}`;
    await recordEvent({
      workspaceId,
      deploymentId,
      traceId,
      domain: "mcp",
      eventName: "gateway.request",
      rpcMethod: "tools/call",
      toolName: "scope",
      detail: {
        request: { method: "tools/call", params: { name: "scope" } },
        response: { safe: true },
      },
    });
    await recordEvent({
      workspaceId: foreignWorkspaceId,
      deploymentId,
      traceId,
      domain: "mcp",
      eventName: "mcp.rpc",
      rpcMethod: "tools/call",
      toolName: "scope",
      detail: {
        request: { text: "foreign-private-input" },
        response: { text: "foreign-private-output" },
      },
    });
    const result = await getObservability(
      workspaceId,
      "UTC",
      24,
      deploymentId,
      { userId, q: traceId },
    );
    expect(result.recent).toHaveLength(1);
    expect(JSON.parse(assertDefined(result.recent[0].responseBody))).toEqual({
      safe: true,
    });
    expect(JSON.stringify(result)).not.toContain("foreign-private");
    expect(
      JSON.stringify(
        await getDeploymentLogs(workspaceId, deploymentId, 100, userId),
      ),
    ).not.toContain("foreign-private");
  });

  it("withholds expired, legacy, agent, and non-deployment payloads from workspace readers", async () => {
    const traceId = `payload-policy-${stamp}`;
    const cases = [
      {
        spanId: "expired",
        deploymentId,
        workspaceMcpPayload: true,
        expiresAt: new Date(0),
      },
      { spanId: "legacy", deploymentId, workspaceMcpPayload: undefined },
      {
        spanId: "agent",
        deploymentId,
        workspaceMcpPayload: false,
        agentId: "agent-fixture",
      },
      {
        spanId: "agent-control",
        deploymentId: null,
        workspaceMcpPayload: false,
        path: "/workspaces/test/agents/mcp",
      },
      {
        spanId: "workspace-api",
        deploymentId: null,
        workspaceMcpPayload: false,
      },
    ];
    for (const { workspaceMcpPayload, expiresAt, ...fields } of cases) {
      await db.logEvent.create({
        data: {
          workspaceId,
          traceId,
          domain: "mcp",
          eventName: "gateway.request",
          message: "policy fixture",
          ...fields,
          detail: {
            create: {
              expiresAt: expiresAt ?? new Date(Date.now() + 60_000),
              data: {
                ...(workspaceMcpPayload === undefined
                  ? {}
                  : { workspaceMcpPayload }),
                payload: {
                  request: "sensitive input",
                  response: "sensitive output",
                },
              },
            },
          },
        },
      });
    }
    await withLogContext({ workspaceId, traceId, suppressPayload: true }, () =>
      recordEvent({
        deploymentId,
        domain: "mcp",
        eventName: "gateway.request",
        toolName: "suppressed",
        detail: { request: "suppressed input", response: "suppressed output" },
      }),
    );
    const overview = await getObservability(workspaceId, "UTC", 24, undefined, {
      userId,
      q: traceId,
    });
    expect(overview.recent).toHaveLength(6);
    expect(
      overview.recent.every(
        (log) =>
          log.requestBody === null &&
          log.responseBody === null &&
          !("detail" in log),
      ),
    ).toBe(true);
    const logs = (
      await getDeploymentLogs(workspaceId, deploymentId, 100, userId)
    ).filter((log) => log.traceId === traceId);
    expect(logs).toHaveLength(4);
    expect(
      logs.every(
        (log) =>
          log.requestBody === null &&
          log.responseBody === null &&
          !("detail" in log),
      ),
    ).toBe(true);
  });

  it("preserves filtered gateway pagination and its fixed time window when details are included", async () => {
    const traceId = `payload-page-${stamp}`;
    const createdAt = new Date();
    await db.logEvent.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        workspaceId,
        deploymentId,
        traceId,
        spanId: `page-${index}`,
        createdAt,
        domain: "mcp",
        eventName: "gateway.request",
        message: "paged request",
      })),
    });
    const first = await getObservability(workspaceId, "UTC", 24, deploymentId, {
      userId,
      q: traceId,
    });
    expect(first.total).toBe(55);
    expect(first.recent).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await getObservability(
      workspaceId,
      "UTC",
      24,
      deploymentId,
      {
        userId,
        q: traceId,
        cursor: assertDefined(first.nextCursor),
        until: first.until,
      },
    );
    expect(second.recent).toHaveLength(5);
    expect(second.total).toBe(55);
    expect(second.until).toBe(first.until);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.recent, ...second.recent].map((log) => log.id)).size,
    ).toBe(55);
    expect(
      [...first.recent, ...second.recent].every(
        (log) => log.traceId === traceId && log.deploymentId === deploymentId,
      ),
    ).toBe(true);
  });
});
