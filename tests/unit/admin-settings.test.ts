// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SKILL_IMPORT_SKILLS,
  MAX_SKILL_IMPORT_SKILLS,
} from "@/lib/skills/limits";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    systemSetting: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
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
  MCP_STARTUP_TIMEOUTS_SETTING_KEY,
  REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY,
  getSkillImportSettings,
  resolveMcpStartupTimeoutSettings,
  resolveRemoteMcpPrivateHostsSettings,
  resetMcpStartupTimeoutSettings,
  resetRemoteMcpPrivateHostsSettings,
  SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
  updateMcpStartupTimeoutSettings,
  updateRemoteMcpPrivateHostsSettings,
  updateSkillImportSettings,
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
  it("uses the default skill import limit until a valid administrator override exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(getSkillImportSettings()).resolves.toEqual({
      maxSkills: DEFAULT_SKILL_IMPORT_SKILLS,
    });

    mocks.findUnique.mockResolvedValue({ value: "80" });
    await expect(getSkillImportSettings()).resolves.toEqual({ maxSkills: 80 });

    mocks.findUnique.mockResolvedValue({
      value: String(MAX_SKILL_IMPORT_SKILLS + 1),
    });
    await expect(getSkillImportSettings()).resolves.toEqual({
      maxSkills: DEFAULT_SKILL_IMPORT_SKILLS,
    });
  });

  it("writes a bounded skill import limit", async () => {
    mocks.upsert.mockResolvedValue(undefined);

    await expect(updateSkillImportSettings(80)).resolves.toEqual({
      maxSkills: 80,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY },
      create: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY, value: "80" },
      update: { value: "80" },
    });

    await expect(
      updateSkillImportSettings(MAX_SKILL_IMPORT_SKILLS + 1),
    ).rejects.toThrow("Invalid skill import maximum.");
  });

  it("uses the Compose environment values until an administrator saves an MCP timeout override", async () => {
    vi.stubEnv("TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS", "300000");
    vi.stubEnv("TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS", "900000");
    mocks.findUnique.mockResolvedValue(null);

    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 300_000,
      maxTimeoutMs: 900_000,
      source: "environment",
    });

    mocks.findUnique.mockResolvedValue({
      value: JSON.stringify({ idleTimeoutMs: 120_000, maxTimeoutMs: 600_000 }),
    });
    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      source: "database",
    });
  });

  it("rejects malformed persisted MCP timeouts and falls back to the compatible environment alias", async () => {
    vi.stubEnv("TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS", "");
    vi.stubEnv("TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS", "");
    vi.stubEnv("MCP_STARTUP_IDLE_TIMEOUT_MS", "180000");
    vi.stubEnv("MCP_STARTUP_MAX_TIMEOUT_MS", "540000");
    mocks.findUnique.mockResolvedValue({ value: "{not-json" });

    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 180_000,
      maxTimeoutMs: 540_000,
      source: "environment",
    });
  });

  it("writes and resets the paired MCP timeout override atomically", async () => {
    mocks.upsert.mockResolvedValue(undefined);
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      updateMcpStartupTimeoutSettings(300_000, 900_000),
    ).resolves.toEqual({
      idleTimeoutMs: 300_000,
      maxTimeoutMs: 900_000,
      source: "database",
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
      create: {
        key: MCP_STARTUP_TIMEOUTS_SETTING_KEY,
        value: JSON.stringify({
          idleTimeoutMs: 300_000,
          maxTimeoutMs: 900_000,
        }),
      },
      update: {
        value: JSON.stringify({
          idleTimeoutMs: 300_000,
          maxTimeoutMs: 900_000,
        }),
      },
    });

    await resetMcpStartupTimeoutSettings();
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
    });
  });

  it("refuses an unsafe MCP timeout pair before writing a setting row", async () => {
    await expect(
      updateMcpStartupTimeoutSettings(900_000, 300_000),
    ).rejects.toThrow("Invalid MCP startup timeouts.");

    expect(mocks.upsert).not.toHaveBeenCalled();
  });

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

  it("writes, normalizes, and resets the Remote MCP private host allowlist", async () => {
    mocks.upsert.mockResolvedValue(undefined);
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      updateRemoteMcpPrivateHostsSettings("*.RHZY.AI\n10.0.10.42"),
    ).resolves.toEqual({
      value: "*.rhzy.ai,10.0.10.42",
      source: "database",
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY },
      create: {
        key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY,
        value: "*.rhzy.ai,10.0.10.42",
      },
      update: { value: "*.rhzy.ai,10.0.10.42" },
    });

    await expect(
      updateRemoteMcpPrivateHostsSettings("127.0.0.1"),
    ).rejects.toThrow("Invalid Remote MCP private host allowlist.");
    await resetRemoteMcpPrivateHostsSettings();
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY },
    });
  });
});
