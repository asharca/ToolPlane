// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorized: true,
  running: true,
  catalogFails: false,
  deployments: [] as Array<Record<string, unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: {
      findFirst: vi.fn(async () =>
        state.authorized ? { id: "workspace" } : null,
      ),
    },
    deployment: { findMany: vi.fn(async () => state.deployments) },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({
  liveStatus: vi.fn(() => (state.running ? "running" : "stopped")),
}));
vi.mock("@/lib/remote-mcp/pinned-connection", () => ({
  listPinnedRemoteMcpTools: vi.fn(async () => {
    if (state.catalogFails) throw new Error("Remote offline");
    return [
      { name: "read", description: "Read data" },
      { name: "private", description: "Hidden" },
    ];
  }),
}));
vi.mock("@/lib/workspace/mcp-tool-exposure", () => ({
  loadMcpToolPolicies: vi.fn(
    async () => new Map([["remote", { deploymentId: "remote" }]]),
  ),
  filterMcpToolsForAi: vi.fn((tools: Array<{ name: string }>) =>
    tools.filter((tool) => tool.name === "read"),
  ),
}));
vi.mock("@/lib/chat/service", () => ({
  ChatServiceError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { db } from "@/lib/db";
import { listPinnedRemoteMcpTools } from "@/lib/remote-mcp/pinned-connection";
import { listChatDeploymentOptions } from "@/lib/chat/resources";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    authorized: true,
    running: true,
    catalogFails: false,
    deployments: [
      {
        id: "remote",
        name: "Remote",
        serverId: null,
        source: "remote",
        sourceRef: "https://example.com/mcp",
        installCfg: { headers: { Authorization: "private-secret" } },
        sandbox: null,
      },
      {
        id: "stdio",
        name: "Stdio",
        serverId: null,
        source: "npm",
        sourceRef: "stdio-package",
        installCfg: {},
        sandbox: null,
      },
      {
        id: "gateway",
        name: "Gateway",
        serverId: null,
        source: "remote",
        sourceRef: "https://example.com/mcp/hidden/rpc",
        installCfg: {},
        sandbox: null,
      },
    ],
  });
});

describe("Assistant remote resource options", () => {
  it("exposes only actual remote connections and policy-filtered tool names without recipes or credentials", async () => {
    const result = await listChatDeploymentOptions("user", "workspace");
    expect(result).toEqual([
      {
        id: "remote",
        name: "Remote",
        status: "running",
        tools: [{ name: "read", description: "Read data" }],
        available: true,
        definitionChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(listPinnedRemoteMcpTools).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace",
      deploymentId: "remote",
      definitionChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(db.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "workspace", status: "active" }),
      }),
    );
  });

  it("denies another workspace before querying deployments or invoking remote catalogs", async () => {
    state.authorized = false;
    await expect(
      listChatDeploymentOptions("other", "workspace"),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.deployment.findMany).not.toHaveBeenCalled();
    expect(listPinnedRemoteMcpTools).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable catalogs from a known empty grant list", async () => {
    state.catalogFails = true;
    expect(await listChatDeploymentOptions("user", "workspace")).toEqual([
      {
        id: "remote",
        name: "Remote",
        status: "running",
        tools: [],
        available: false,
        definitionChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    state.running = false;
    vi.mocked(listPinnedRemoteMcpTools).mockClear();
    expect(await listChatDeploymentOptions("user", "workspace")).toEqual([
      {
        id: "remote",
        name: "Remote",
        status: "stopped",
        tools: [],
        available: false,
        definitionChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(listPinnedRemoteMcpTools).not.toHaveBeenCalled();
  });
});
