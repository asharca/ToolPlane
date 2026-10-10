// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { db } from "@/lib/db";
import { getSystemOverview } from "@/lib/admin/overview";

const stamp = `overview-${randomUUID()}`;
const now = new Date("2099-01-01T12:00:00Z").getTime();
const ids = { owner: "", caller: "", workspace: "" };
const requestIds: string[] = [];

beforeAll(async () => {
  ids.owner = (
    await db.user.create({
      data: {
        email: `${stamp}-owner@t.dev`,
        name: "Workspace owner",
        passwordHash: "x",
      },
    })
  ).id;
  ids.caller = (
    await db.user.create({
      data: {
        email: `${stamp}-caller@t.dev`,
        name: "Actual caller",
        passwordHash: "x",
      },
    })
  ).id;
  ids.workspace = (
    await db.workspace.create({
      data: {
        slug: stamp,
        name: "OV",
        ownerId: ids.owner,
        members: { create: { userId: ids.owner, role: "owner" } },
      },
    })
  ).id;
  for (let i = 0; i < 10; i++) {
    const event = await db.logEvent.create({
      data: {
        workspaceId: ids.workspace,
        domain: "a2a",
        eventName: "a2a.request",
        message: "request",
        traceId: stamp,
        spanId: `a2a-${i}`,
        createdAt: new Date(now - (i + 1) * 1000),
        rpcMethod: "SendMessage",
        outcome: i === 8 ? "error" : i === 9 ? "denied" : "success",
        httpStatus: 200,
        durationMs: (i + 1) * 10,
        actorId:
          i === 1 ? ids.caller : i === 2 ? `${stamp}-deleted-user` : null,
        attributes: {
          data: {
            a2a: {
              direction: "inbound",
              transport: "jsonrpc",
              ...(i === 0 ? { clientId: "real-service-client" } : {}),
            },
          },
        },
      },
    });
    requestIds.push(event.id);
  }
  const mcp = [];
  for (let i = 0; i < 2; i++) {
    mcp.push(
      await db.logEvent.create({
        data: {
          workspaceId: ids.workspace,
          domain: "mcp",
          eventName: "gateway.request",
          message: "request",
          traceId: stamp,
          spanId: `mcp-${i}`,
          createdAt: new Date(now - 500 - i * 250),
          rpcMethod: "tools/call",
          toolName: "search",
          actorId: ids.caller,
          httpStatus: 200,
          outcome: i === 0 ? "success" : "error",
          durationMs: i === 0 ? 11 : 21,
        },
      }),
    );
  }
  requestIds.unshift(...mcp.map((event) => event.id));
  for (const [index, data] of [
    { domain: "http", eventName: "http.request" },
    { domain: "mcp", eventName: "rpc.request" },
    { domain: "agent", eventName: "agent.run" },
    { domain: "a2a", eventName: "a2a.task.started", direction: "inbound" },
    { domain: "a2a", eventName: "a2a.task.settled", direction: "internal" },
    { domain: "a2a", eventName: "a2a.request", direction: "outbound" },
    { domain: "a2a", eventName: "a2a.request", direction: "internal" },
    { domain: "a2a", eventName: "a2a.request" },
    {
      domain: "a2a",
      eventName: "a2a.request",
      direction: "inbound",
      age: 25 * 60 * 60 * 1000,
    },
    {
      domain: "a2a",
      eventName: "a2a.request",
      direction: "inbound",
      age: -1000,
    },
  ].entries()) {
    await db.logEvent.create({
      data: {
        workspaceId: ids.workspace,
        domain: data.domain,
        eventName: data.eventName,
        message: "excluded",
        traceId: stamp,
        spanId: `excluded-${index}`,
        durationMs: 100000,
        outcome: "success",
        createdAt: new Date(now - (data.age ?? 50)),
        ...(data.direction
          ? {
              attributes: {
                data: {
                  a2a: { direction: data.direction, transport: "jsonrpc" },
                },
              },
            }
          : {}),
      },
    });
  }
});

afterAll(async () => {
  await db.logEvent.deleteMany({ where: { workspaceId: ids.workspace } });
  await db.workspace.deleteMany({ where: { id: ids.workspace } });
  await db.user.deleteMany({
    where: { id: { in: [ids.owner, ids.caller].filter(Boolean) } },
  });
});

describe("getSystemOverview", () => {
  it("counts only inbound A2A requests and MCP gateway requests, with semantic failures and latency", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const o = await getSystemOverview();
      expect(o.counts.users).toBeGreaterThanOrEqual(2);
      expect(o.requests).toEqual({ total: 2, errors: 1, avgMs: 16, p95Ms: 21 });
      expect(o.a2aRequests).toEqual({
        total: 10,
        errors: 2,
        avgMs: 55,
        p95Ms: 100,
      });
      expect(o.recentRequests.map((event) => event.id)).toEqual(
        requestIds.slice(0, 8),
      );
      expect(
        o.recentRequests.find((event) => event.id === requestIds[2]),
      ).toMatchObject({
        actorId: null,
        actorName: null,
        clientId: "real-service-client",
        rpcMethod: "SendMessage",
        outcome: "success",
        durationMs: 10,
      });
      expect(
        o.recentRequests.find((event) => event.id === requestIds[3]),
      ).toMatchObject({
        actorId: ids.caller,
        actorName: "Actual caller",
        clientId: null,
      });
      expect(
        o.recentRequests.find((event) => event.id === requestIds[4]),
      ).toMatchObject({ actorId: `${stamp}-deleted-user`, actorName: null });
      expect(
        o.recentRequests.find((event) => event.id === requestIds[5]),
      ).toMatchObject({ actorId: null, actorName: null, clientId: null });
      expect(o.attention.recentFailures.map((event) => event.id)).toContain(
        requestIds[10],
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("has no recent request rows when neither protocol has requests in the window", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2100-01-01T12:00:00Z").getTime());
    try {
      const o = await getSystemOverview();
      expect(o.requests.total).toBe(0);
      expect(o.a2aRequests.total).toBe(0);
      expect(o.recentRequests).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
});
