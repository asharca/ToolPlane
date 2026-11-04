// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  currentUser: vi.fn(),
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

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.currentUser,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  refreshAgentExecutionLimits: vi.fn(),
}));

import {
  AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
  getAgentSandboxAutoStopSettings,
  updateAgentSandboxAutoStopSettings,
  getAgentConcurrencySettings,
  updateAgentConcurrencySettings,
  resolveRemoteMcpPrivateHostsSettings,
} from "@/lib/admin/settings";
import { updateAgentSandboxAutoStopSettingsAction } from "@/lib/admin/settings-actions";

describe("system settings storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.currentUser.mockResolvedValue({ id: "admin", role: "admin" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to auto-stop and persists audited disable, re-enable and reset actions", async () => {
    let stored: { value: string } | null = null;
    mocks.findUnique.mockImplementation(async () => stored);
    mocks.upsert.mockImplementation(async ({ update }) => {
      stored = { value: update.value };
      return stored;
    });
    mocks.deleteMany.mockImplementation(async () => {
      stored = null;
      return { count: 1 };
    });
    await expect(getAgentSandboxAutoStopSettings()).resolves.toEqual({
      enabled: true,
      source: "default",
    });
    for (const enabled of [false, true]) {
      const form = new FormData();
      form.set("agentSandboxAutoStopEnabled", String(enabled));
      await expect(
        updateAgentSandboxAutoStopSettingsAction({}, form),
      ).resolves.toEqual({ ok: true });
      await expect(getAgentSandboxAutoStopSettings()).resolves.toEqual({
        enabled,
        source: "database",
      });
    }
    const form = new FormData();
    form.set("intent", "reset");
    await expect(
      updateAgentSandboxAutoStopSettingsAction({}, form),
    ).resolves.toEqual({ ok: true });
    await expect(getAgentSandboxAutoStopSettings()).resolves.toEqual({
      enabled: true,
      source: "default",
    });
    expect(
      mocks.auditCreate.mock.calls.map(([{ data }]) => ({
        actorId: data.actorId,
        action: data.action,
        targetId: data.targetId,
        changes: data.changes,
      })),
    ).toEqual([
      {
        actorId: "admin",
        action: "setting.changed",
        targetId: AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
        changes: { before: null, after: '{"enabled":false}' },
      },
      {
        actorId: "admin",
        action: "setting.changed",
        targetId: AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
        changes: { before: '{"enabled":false}', after: '{"enabled":true}' },
      },
      {
        actorId: "admin",
        action: "setting.reset",
        targetId: AGENT_SANDBOX_AUTO_STOP_SETTING_KEY,
        changes: { before: '{"enabled":true}', after: null },
      },
    ]);
  });

  it.each([null, "", "TRUE", "1", " false ", "on"])(
    "rejects malformed auto-stop form value %s without writes or audit",
    async (value) => {
      const form = new FormData();
      if (value !== null) form.set("agentSandboxAutoStopEnabled", value);
      await expect(
        updateAgentSandboxAutoStopSettingsAction({}, form),
      ).resolves.toEqual({ error: "errorActionFailed" });
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.deleteMany).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

  it.each([null, { id: "member", role: "user" }])(
    "denies unauthenticated and non-admin auto-stop changes and resets (%s)",
    async (user) => {
      mocks.currentUser.mockResolvedValue(user);
      for (const intent of ["save", "reset"]) {
        const form = new FormData();
        form.set("intent", intent);
        form.set("agentSandboxAutoStopEnabled", "false");
        await expect(
          updateAgentSandboxAutoStopSettingsAction({}, form),
        ).rejects.toThrow(
          user ? "redirect:/" : "redirect:/app/login?next=/admin",
        );
      }
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.deleteMany).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

  it.each(["false", 0, null, undefined])(
    "rejects non-boolean policy values %s rather than coercing them",
    async (enabled) => {
      await expect(
        updateAgentSandboxAutoStopSettings(enabled as boolean, "admin"),
      ).rejects.toThrow("Invalid Agent sandbox auto-stop settings");
      mocks.findUnique.mockResolvedValue({
        value: JSON.stringify({ enabled }),
      });
      await expect(getAgentSandboxAutoStopSettings()).rejects.toThrow(
        "Invalid Agent sandbox auto-stop settings",
      );
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

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
