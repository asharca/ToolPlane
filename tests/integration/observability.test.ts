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
import { listMcpCalls, getMcpCall } from "@/lib/observability/views/mcp-calls";
import { GET as streamLogs } from "@/app/api/v1/workspaces/[slug]/logs/stream/route";
import { createApiToken } from "@/lib/auth/tokens";
import {
  appendAgentChannelLog,
  clearAgentChannelLogs,
  getAgentChannelLogs,
  getPersistedAgentChannelLogs,
} from "@/lib/agents/channel-runtime-logs";

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
  it("returns complete long channel messages and history beyond 200 entries without crossing workspace boundaries", async () => {
    const channelId = `channel-log-${stamp}`;
    const traceId = `complete-channel-${stamp}`;
    const baseTime = Date.now() - 10_000;
    const history = Array.from({ length: 201 }, (_, index) => ({
      workspaceId,
      channelId,
      traceId,
      spanId: `channel-${index}`,
      domain: "channel",
      eventName: "channel.log",
      message: `channel history ${index}`,
      createdAt: new Date(baseTime + index),
      occurredAt: new Date(baseTime + index),
    }));
    await db.logEvent.createMany({
      data: [
        ...history,
        {
          workspaceId: foreignWorkspaceId,
          channelId,
          traceId,
          spanId: "foreign-channel",
          domain: "channel",
          eventName: "channel.log",
          message: "foreign channel private content",
        },
        {
          workspaceId,
          channelId: `${channelId}-other`,
          traceId,
          spanId: "other-channel",
          domain: "channel",
          eventName: "channel.log",
          message: "other channel private content",
        },
      ],
    });
    const secret = "channel-tail-configured-secret";
    const body = `channel head\n${"中🙂".repeat(80_000)}\nchannel tail `;
    const expected = `${body}[REDACTED]\n`;
    try {
      const immediate = withLogContext({ workspaceId, traceId }, () =>
        appendAgentChannelLog(channelId, "info", `${body}${secret}\n`, [
          secret,
        ]),
      );
      expect(immediate).toBe(expected);
      expect(getAgentChannelLogs(channelId)).toEqual([
        { timestamp: expect.any(Number), level: "info", message: expected },
      ]);
      // appendAgentChannelLog deliberately does not block the runtime on the
      // database writer. Observe its real persisted result before consuming it.
      await vi.waitFor(
        async () => {
          expect(
            await db.logEvent.count({ where: { workspaceId, channelId } }),
          ).toBe(202);
        },
        { timeout: 10_000 },
      );
      const logs = await getPersistedAgentChannelLogs(workspaceId, channelId);
      expect(logs).toHaveLength(202);
      expect(logs.slice(0, 201).map((log) => log.message)).toEqual(
        history.map((row) => row.message),
      );
      expect(logs[201]).toMatchObject({ level: "info", message: expected });
      expect(
        Buffer.byteLength(assertDefined(logs[201]).message),
      ).toBeGreaterThan(512 * 1024);
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain("private content");
      expect(
        await getPersistedAgentChannelLogs(foreignWorkspaceId, channelId),
      ).toEqual([
        {
          timestamp: expect.any(Number),
          level: "info",
          message: "foreign channel private content",
        },
      ]);
    } finally {
      clearAgentChannelLogs(channelId);
    }
  }, 20_000);

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
  it("pairs repeated calls by callId and filters the complete scoped result server-side", async () => {
    const traceId = `explicit-pair-${stamp}`;
    for (const [suffix, outcome, durationMs] of [
      ["first", "success", 25],
      ["second", "error", 2500],
    ] as const) {
      const callId = `${traceId}-${suffix}`;
      await withLogContext(
        { workspaceId, deploymentId, traceId, callId, actorId: userId },
        async () => {
          await recordEvent({
            domain: "mcp",
            eventName: "mcp.rpc",
            rpcMethod: "tools/call",
            toolName: traceId,
            outcome,
            durationMs,
            detail: {
              request: { marker: suffix },
              response: { marker: suffix },
            },
          });
          await recordEvent({
            domain: "mcp",
            eventName: "gateway.request",
            rpcMethod: "tools/call",
            toolName: traceId,
            outcome,
            durationMs,
          });
        },
      );
    }
    const scope = { kind: "workspace", workspaceId, userId } as const;
    const all = await listMcpCalls(scope, { q: traceId });
    expect(all.items).toHaveLength(2);
    expect(all.stats.total).toBe(2);
    for (const item of all.items) {
      expect(item.task).toBeNull();
      const detail = assertDefined(await getMcpCall(scope, item.id));
      const suffix = item.callId?.endsWith("first") ? "first" : "second";
      expect(JSON.stringify(detail)).toContain(`"marker":"${suffix}"`);
      expect(JSON.stringify(detail)).not.toContain(
        `"marker":"${suffix === "first" ? "second" : "first"}"`,
      );
      expect(item.deployment?.name).toBe("Seed MCP");
      expect(
        await getMcpCall(
          {
            kind: "workspace",
            workspaceId: foreignWorkspaceId,
            userId: foreignUserId,
          },
          item.id,
        ),
      ).toBeNull();
    }
    const failed = await listMcpCalls(scope, {
      q: traceId,
      outcome: "error",
      slow: true,
      callerKind: "user",
      method: "tools/call",
      deploymentId,
      tool: traceId,
    });
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0].callId).toBe(`${traceId}-second`);
    expect(
      (
        await listMcpCalls(scope, {
          q: traceId,
          outcome: "success",
          slow: true,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await listMcpCalls(scope, {
          q: traceId,
          workspaceId: foreignWorkspaceId,
        })
      ).items,
    ).toHaveLength(2);
    await expect(
      listMcpCalls(
        { kind: "workspace", workspaceId, userId: foreignUserId },
        {},
      ),
    ).rejects.toBeInstanceOf(LogAccessError);
  });

  it("filters before the fifty-row page limit and preserves keyset pagination", async () => {
    const marker = `server-filter-${stamp}`;
    const at = new Date();
    await db.logEvent.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        workspaceId,
        deploymentId,
        traceId: marker,
        spanId: String(index),
        callId: `${marker}-${index}`,
        domain: "mcp",
        eventName: "gateway.request",
        message: marker,
        toolName: marker,
        rpcMethod: "tools/call",
        createdAt: new Date(at.getTime() - index * 1000),
        outcome: index >= 50 ? "error" : "success",
        durationMs: index >= 50 ? 2500 : 10,
      })),
    });
    const scope = { kind: "workspace", workspaceId, userId } as const;
    const first = await listMcpCalls(scope, { q: marker });
    expect(first.items).toHaveLength(50);
    expect(first.stats.total).toBe(55);
    expect(first.nextCursor).toBeTruthy();
    const second = await listMcpCalls(
      scope,
      { q: marker },
      assertDefined(first.nextCursor),
    );
    expect(second.items).toHaveLength(5);
    expect(
      second.items.every(
        (item) => !first.items.some((previous) => previous.id === item.id),
      ),
    ).toBe(true);
    const filtered = await listMcpCalls(scope, {
      q: marker,
      outcome: "error",
      slow: true,
    });
    expect(filtered.items).toHaveLength(5);
    expect(filtered.stats.total).toBe(5);
  });

  it("streams only matching workspace summaries and never includes protocol bodies", async () => {
    const marker = `stream-${stamp}`;
    const since = new Date(Date.now() - 1000).toISOString();
    for (const workspace of [workspaceId, foreignWorkspaceId]) {
      await recordEvent({
        workspaceId: workspace,
        deploymentId,
        callId: `${marker}-${workspace}`,
        domain: "mcp",
        eventName: "gateway.request",
        rpcMethod: "tools/call",
        toolName: marker,
        detail: {
          request: "stream-private-input",
          response: "stream-private-output",
        },
      });
    }
    const token = await createApiToken(userId, "log stream test");
    const abort = new AbortController();
    const response = await streamLogs(
      new Request(
        `http://localhost/api/v1/workspaces/observability-${stamp}/logs/stream?kind=mcp&q=${marker}&since=${encodeURIComponent(since)}`,
        {
          headers: { authorization: `Bearer ${token.token}` },
          signal: abort.signal,
        },
      ),
      { params: Promise.resolve({ slug: `observability-${stamp}` }) },
    );
    expect(response.status).toBe(200);
    const reader = assertDefined(response.body).getReader();
    let wire = "";
    try {
      while (!wire.includes("event: item")) {
        const value = await reader.read();
        if (value.done) break;
        wire += new TextDecoder().decode(value.value);
      }
      expect(wire).toContain("event: item");
      const items = wire
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.workspace?.id === workspaceId)).toBe(
        true,
      );
      expect(wire).not.toContain("stream-private");
      expect(wire).not.toContain(foreignWorkspaceId);
    } finally {
      abort.abort();
      await reader.cancel();
    }
  }, 10_000);
});
