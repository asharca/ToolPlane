import { beforeEach, describe, it, expect, vi } from "vitest";
import type * as McpCredentials from "@/lib/process/mcp-credentials";
import { sealMcpEnvironment } from "@/lib/process/mcp-credentials";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  start: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { deployment: { findMany: mocks.load } } }));
vi.mock("@/lib/process/supervisor", () => ({ startProcess: mocks.start }));
vi.mock("@/lib/process/mcp-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof McpCredentials>()),
  resolveMcpConnectionSpawnSpec: mocks.resolve,
}));
import {
  reconcileDeployments,
  type ReconcileDeps,
} from "@/lib/process/reconcile";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("reconcileDeployments", () => {
  it("re-spawns each running deployment with its resolved spec", async () => {
    const start = vi.fn<ReconcileDeps["start"]>(async () => {});
    const n = await reconcileDeployments({
      loadRunning: async () => [
        {
          id: "a",
          serverId: "s1",
          server: { name: "Stripe" },
          name: null,
          source: null,
          sourceRef: null,
          installCfg: null,
        },
        {
          id: "b",
          serverId: null,
          server: null,
          name: "Custom",
          source: "npm",
          sourceRef: "pkg",
          installCfg: null,
        },
      ],
      start,
    });
    expect(n).toBe(2);
    expect(start.mock.calls[0]).toEqual([
      "a",
      { kind: "builtin", name: "Stripe" },
      { awaitReady: false, workspaceId: undefined },
    ]);
    expect(start.mock.calls[1][0]).toBe("b");
    expect(start.mock.calls[1][1]).toMatchObject({
      kind: "bridge",
      command: "docker",
    });
    expect(start.mock.calls[1][2]).toEqual({
      awaitReady: false,
      workspaceId: undefined,
    });
  });

  it("keeps going when one deployment fails to start", async () => {
    const start = vi.fn<ReconcileDeps["start"]>(async (id) => {
      if (id === "bad") throw new Error("spawn failed");
    });
    const n = await reconcileDeployments({
      loadRunning: async () => [
        {
          id: "bad",
          serverId: "s",
          server: { name: "X" },
          name: null,
          source: null,
          sourceRef: null,
          installCfg: null,
        },
        {
          id: "ok",
          serverId: "s2",
          server: { name: "Y" },
          name: null,
          source: null,
          sourceRef: null,
          installCfg: null,
        },
      ],
      start,
    });
    expect(n).toBe(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("never resolves or starts a bound retired Hermes runtime during recovery", async () => {
    const start = vi.fn<ReconcileDeps["start"]>(async () => {});
    const n = await reconcileDeployments({
      loadRunning: async () => [
        {
          id: "hermes-deployment",
          serverId: null,
          server: null,
          name: "Hermes",
          source: "sandbox",
          sourceRef: null,
          installCfg: { kind: "hermes" },
          sandbox: { agentRuntime: { kind: "hermes" } },
        },
      ],
      start,
    });
    expect(n).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("returns 0 when nothing is running", async () => {
    const start = vi.fn<ReconcileDeps["start"]>(async () => {});
    expect(
      await reconcileDeployments({ loadRunning: async () => [], start }),
    ).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("resolves persisted running recipes with their workspace scope", async () => {
    const spec = {
      kind: "remote",
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    };
    mocks.load.mockResolvedValue([
      {
        id: "remote",
        workspaceId: "owner",
        source: "remote",
        installCfg: sealMcpEnvironment(
          { authType: "bearer", bearerEnv: "TOKEN" },
          "owner",
          { TOKEN: "private-token" },
        ),
      },
    ]);
    mocks.resolve.mockResolvedValue({
      spec,
      redactionValues: ["private-token"],
    });
    mocks.start.mockResolvedValue(undefined);

    expect(await reconcileDeployments()).toBe(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "owner",
      deploymentId: "remote",
    });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("remote", spec, {
      awaitReady: false,
      workspaceId: "owner",
    });
  });

  it("continues after persisted credential access is revoked", async () => {
    mocks.start.mockClear();
    mocks.resolve.mockReset();
    mocks.load.mockResolvedValue([
      { id: "revoked", workspaceId: "owner", source: "remote" },
      { id: "available", workspaceId: "owner", source: "remote" },
    ]);
    const spec = { kind: "builtin", name: "Available" };
    mocks.resolve
      .mockRejectedValueOnce(new Error("MCP_CREDENTIAL_REQUIRED"))
      .mockResolvedValueOnce({ spec, redactionValues: [] });

    expect(await reconcileDeployments()).toBe(1);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("available", spec, {
      awaitReady: false,
      workspaceId: "owner",
    });
    expect(mocks.resolve).toHaveBeenNthCalledWith(1, {
      workspaceId: "owner",
      deploymentId: "revoked",
    });
    expect(mocks.resolve).toHaveBeenNthCalledWith(2, {
      workspaceId: "owner",
      deploymentId: "available",
    });
  });
});

it("does not route sandbox recovery through the MCP credential resolver", async () => {
  mocks.load.mockResolvedValue([
    {
      id: "sandbox",
      workspaceId: "owner",
      source: "sandbox",
      installCfg: {
        kind: "docker",
        sandboxId: "sandbox-1",
        image: "node:24",
        volumeName: "sandbox-1-files",
      },
    },
  ]);
  mocks.start.mockResolvedValue(undefined);
  expect(await reconcileDeployments()).toBe(1);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.start).toHaveBeenCalledWith(
    "sandbox",
    expect.objectContaining({ kind: "sandbox" }),
    { awaitReady: false, workspaceId: "owner" },
  );
});

it("does not recover an unbound retired Hermes recipe", async () => {
  mocks.load.mockResolvedValue([
    {
      id: "retired",
      workspaceId: "owner",
      source: "sandbox",
      installCfg: { kind: "hermes" },
    },
  ]);
  expect(await reconcileDeployments()).toBe(0);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("never resolves persisted MCP credentials without a workspace owner scope", async () => {
  mocks.load.mockResolvedValue([{ id: "unscoped", source: "remote" }]);
  expect(await reconcileDeployments()).toBe(0);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
