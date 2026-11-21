// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { sessionHttp, closeSessions } from "../../scripts/mcp-session-http.mjs";
import { callWithCallbacks } from "@/lib/process/mcp-session-client";
import { sample, elicit, sessionRoots } from "@/lib/process/mcp-callbacks";
import { agentSessionWorkingDirectory } from "@/lib/agents/session-paths";

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  model: vi.fn(),
  ui: vi.fn(),
  event: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    deployment: { findFirst: mocks.deployment },
    modelProvider: { findFirst: mocks.model },
  },
}));
vi.mock("@/lib/observability/events", () => ({ recordEvent: mocks.event }));
vi.mock("@/lib/agents/execution/task-ui", () => ({ updateTaskUi: mocks.ui }));
vi.mock("@/lib/agents/runtime-grant", () => ({
  resolveAgentRuntimeGrant: vi.fn(),
}));
const context = { workspaceId: "scope", deploymentId: "deployment" };
const input = {
  messages: [
    { role: "user" as const, content: { type: "text" as const, text: "test" } },
  ],
  maxTokens: 10,
};

describe("MCP client callback authority", () => {
  it("rejects sampling before accessing model credentials when opt-in is disabled", async () => {
    mocks.deployment.mockResolvedValue({ samplingEnabled: false });
    await expect(
      sample(context, input, AbortSignal.timeout(3000)),
    ).rejects.toThrow("MCP_SAMPLING_DISABLED");
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it("returns only the authorized session directory, never a host path or shared sandbox root", async () => {
    const session = { conversationId: "a" };
    expect(await sessionRoots({ ...context, session })).toEqual({
      roots: [{ uri: `file://${agentSessionWorkingDirectory(session)}` }],
    });
    expect(await sessionRoots(context)).toEqual({ roots: [] });
  });
  it("declines elicitation without a task lease or an applicable approval", async () => {
    const params = {
      message: "details?",
      requestedSchema: { type: "object" as const, properties: {} },
    };
    expect(await elicit(context, params, AbortSignal.timeout(3000))).toEqual({
      action: "decline",
    });
    expect(mocks.ui).not.toHaveBeenCalled();
  });
  it("returns only form values supplied by the lease-bound human", async () => {
    const token = {
      ...context,
      agentId: "agent",
      agentRevisionId: "revision",
      sandboxId: "sandbox",
      providerId: "provider",
      a2aTaskId: "task",
      a2aLeaseToken: "lease",
      deploymentIds: ["deployment"],
      exp: Date.now(),
    };
    const params = {
      message: "Which project?",
      requestedSchema: {
        type: "object" as const,
        properties: { project: { type: "string" as const } },
        required: ["project"],
      },
    };
    mocks.ui
      .mockResolvedValueOnce({
        response: { value: '{"project":"human choice"}' },
      })
      .mockResolvedValue({});
    expect(
      await elicit({ ...context, token }, params, AbortSignal.timeout(3000)),
    ).toEqual({ action: "accept", content: { project: "human choice" } });
  });
  it("does not run model/UI callbacks during catalog discovery even with colliding request ids", async () => {
    vi.clearAllMocks();
    const replies: JSONRPCMessage[] = [];
    const server = createServer(
      (req, res) =>
        void sessionHttp(
          req,
          res,
          async ({ onmessage }: { onmessage: (m: JSONRPCMessage) => void }) => {
            let listId: string | number = 0;
            return {
              close: async () => {},
              send: async (m: JSONRPCMessage) => {
                if ("method" in m && "id" in m && m.method === "initialize") {
                  onmessage({
                    jsonrpc: "2.0",
                    id: m.id,
                    result: {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "test", version: "1" },
                    },
                  });
                } else if (
                  "method" in m &&
                  "id" in m &&
                  m.method === "tools/list"
                ) {
                  listId = m.id;
                  onmessage({
                    jsonrpc: "2.0",
                    id: listId,
                    method: "sampling/createMessage",
                    params: input,
                  });
                } else if ("error" in m) {
                  replies.push(m);
                  if (replies.length === 1)
                    onmessage({
                      jsonrpc: "2.0",
                      id: listId,
                      method: "elicitation/create",
                      params: {
                        message: "Please confirm",
                        requestedSchema: { type: "object", properties: {} },
                      },
                    });
                  else
                    onmessage({
                      jsonrpc: "2.0",
                      id: listId,
                      result: { tools: [] },
                    });
                }
              },
            };
          },
        ),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const result = await callWithCallbacks(
        (server.address() as AddressInfo).port,
        context,
        "tools/list",
        {},
        5000,
        AbortSignal.timeout(5000),
        100_000,
        () => new Error("limit"),
      );
      expect(result.result).toEqual({ tools: [] });
      expect(replies).toHaveLength(2);
      expect(
        replies.every(
          (m) =>
            "error" in m &&
            m.error.message.includes("MCP_DISCOVERY_CALLBACK_DENIED"),
        ),
      ).toBe(true);
      expect(mocks.deployment).not.toHaveBeenCalled();
      expect(mocks.ui).not.toHaveBeenCalled();
    } finally {
      await closeSessions();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });
});
