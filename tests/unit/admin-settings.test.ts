// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    systemSetting: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
    auditEvent: { create: mocks.auditCreate },
  };
  return {
    db: {
      ...tx,
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    },
  };
});

import {
  getAgentConcurrencySettings,
  updateAgentConcurrencySettings,
  resolveRemoteMcpPrivateHostsSettings,
} from "@/lib/admin/settings";

describe("system settings storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads saved concurrency limits and refuses invalid policy instead of widening it", async () => {
    mocks.findUnique.mockResolvedValue({
      value: JSON.stringify({ maxPerAgent: 4, maxTotal: 12 }),
    });
    await expect(getAgentConcurrencySettings()).resolves.toEqual({
      maxPerAgent: 4,
      maxTotal: 12,
      source: "database",
    });
    mocks.findUnique.mockResolvedValue({
      value: JSON.stringify({ maxPerAgent: 4, maxTotal: 2 }),
    });
    await expect(getAgentConcurrencySettings()).rejects.toThrow(
      "Invalid Agent concurrency settings",
    );
    mocks.findUnique.mockRejectedValue(new Error("database unavailable"));
    await expect(getAgentConcurrencySettings()).rejects.toThrow(
      "database unavailable",
    );
  });

  it.each([
    [0, 16],
    [33, 64],
    [4, 3],
    [1, 257],
    [1.5, 16],
  ])(
    "rejects unsafe concurrency bounds %s / %s without persisting",
    async (perAgent, total) => {
      await expect(
        updateAgentConcurrencySettings(perAgent, total, "admin"),
      ).rejects.toThrow("Invalid Agent concurrency settings");
      expect(mocks.upsert).not.toHaveBeenCalled();
    },
  );

  it("uses a normalized administrator Remote MCP allowlist ahead of the environment fallback", async () => {
    vi.stubEnv("TOOLPLANE_REMOTE_MCP_PRIVATE_HOSTS", "*.rhzy.ai,10.0.10.42");
    mocks.findUnique.mockResolvedValue(null);

    await expect(resolveRemoteMcpPrivateHostsSettings()).resolves.toEqual({
      value: "*.rhzy.ai,10.0.10.42",
      source: "environment",
    });

    mocks.findUnique.mockResolvedValue({
      value: "MCP.RHZY.AI.\n*.RHZY.AI,10.0.10.42",
    });
    await expect(resolveRemoteMcpPrivateHostsSettings()).resolves.toEqual({
      value: "mcp.rhzy.ai,*.rhzy.ai,10.0.10.42",
      source: "database",
    });
  });

  it("fails closed for an invalid stored Remote MCP allowlist", async () => {
    vi.stubEnv("TOOLPLANE_REMOTE_MCP_PRIVATE_HOSTS", "*.rhzy.ai");
    mocks.findUnique.mockResolvedValue({ value: "127.0.0.1" });

    await expect(resolveRemoteMcpPrivateHostsSettings()).resolves.toEqual({
      value: "",
      source: "database",
    });
  });

  it("fails closed when the stored Remote MCP allowlist cannot be read", async () => {
    vi.stubEnv("TOOLPLANE_REMOTE_MCP_PRIVATE_HOSTS", "*.rhzy.ai");
    mocks.findUnique.mockRejectedValue(new Error("database unavailable"));

    await expect(resolveRemoteMcpPrivateHostsSettings()).resolves.toEqual({
      value: "",
      source: "default",
    });
  });
});
