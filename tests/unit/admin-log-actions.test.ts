// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  transaction: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  lock: vi.fn(),
  workspace: vi.fn(),
  deployment: vi.fn(),
  agent: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: mocks.audit }));
import { updateLogSettings } from "@/lib/admin/log-actions";

function form(values: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) data.set(key, value);
  return data;
}
const now = new Date("2026-01-01T12:00:00Z").getTime();
const capture = (id: string, expiresAt: string, field = "workspaceId") => ({
  field,
  id,
  expiresAt,
});
function stored() {
  return JSON.parse(mocks.save.mock.calls[0][0].update.value);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.auth.mockResolvedValue({ id: "admin" });
  mocks.read.mockResolvedValue(null);
  mocks.workspace.mockResolvedValue({ id: "w" });
  mocks.deployment.mockResolvedValue({ id: "d" });
  mocks.agent.mockResolvedValue({ id: "a" });
  mocks.transaction.mockImplementation(async (run) =>
    run({
      $queryRaw: mocks.lock,
      systemSetting: { findUnique: mocks.read, upsert: mocks.save },
      workspace: { findUnique: mocks.workspace },
      deployment: { findUnique: mocks.deployment },
      agent: { findUnique: mocks.agent },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging configuration transitions", () => {
  it("saves bounded retention and prunes expired captures in the audited transaction", async () => {
    const active = capture("w", "2026-01-01T12:10:00.000Z");
    mocks.read.mockResolvedValue({
      value: JSON.stringify({
        captures: [capture("expired", "2026-01-01T11:59:59.000Z"), active],
      }),
    });
    expect(
      await updateLogSettings(
        {},
        form({
          intent: "retention",
          eventDays: "90",
          detailDays: "14",
          auditDays: "365",
        }),
      ),
    ).toEqual({ ok: true });
    expect(stored()).toEqual({
      eventDays: 90,
      detailDays: 14,
      auditDays: 365,
      captures: [active],
    });
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "admin",
        action: "logging.retention",
        changes: expect.objectContaining({ after: stored() }),
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/logs");
  });
  it.each(["workspaceId", "deploymentId", "agentId"])(
    "starts a scoped %s capture with explicit content consent",
    async (field) => {
      expect(
        await updateLogSettings(
          {},
          form({
            intent: "capture",
            field,
            id: " resource ",
            includeAgentContent: "confirmed",
          }),
        ),
      ).toEqual({ ok: true });
      expect(stored().captures).toEqual([
        {
          field,
          id: "resource",
          includeAgentContent: true,
          expiresAt: "2026-01-01T12:15:00.000Z",
        },
      ]);
      const lookup =
        field === "workspaceId"
          ? mocks.workspace
          : field === "deploymentId"
            ? mocks.deployment
            : mocks.agent;
      expect(lookup).toHaveBeenCalledWith({
        where: { id: "resource" },
        select: { id: true },
      });
    },
  );
  it("replaces only the matching capture and does not infer content consent", async () => {
    const other = capture("other", "2026-01-01T12:10:00.000Z");
    mocks.read.mockResolvedValue({
      value: JSON.stringify({
        captures: [capture("w", "2026-01-01T12:02:00.000Z"), other],
      }),
    });
    expect(
      await updateLogSettings(
        {},
        form({
          intent: "capture",
          field: "workspaceId",
          id: "w",
          includeAgentContent: "on",
        }),
      ),
    ).toEqual({ ok: true });
    expect(stored().captures).toEqual([
      other,
      {
        field: "workspaceId",
        id: "w",
        includeAgentContent: false,
        expiresAt: "2026-01-01T12:15:00.000Z",
      },
    ]);
  });
  it("stops all active captures", async () => {
    mocks.read.mockResolvedValue({
      value: JSON.stringify({
        captures: [capture("w", "2026-01-01T12:10:00.000Z")],
      }),
    });
    expect(await updateLogSettings({}, form({ intent: "stop" }))).toEqual({
      ok: true,
    });
    expect(stored().captures).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "logging.stop" }),
    );
  });
  it.each([
    { intent: "invalid" },
    { intent: "capture", field: "userId", id: "u" },
    { intent: "retention", eventDays: "0", detailDays: "31", auditDays: "5" },
  ])(
    "rejects invalid settings without persisting or invalidating",
    async (values) => {
      expect(await updateLogSettings({}, form(values))).toEqual({
        error: "logsSettingsError",
      });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );
  it("refuses missing capture targets and malformed stored settings", async () => {
    mocks.workspace.mockResolvedValue(null);
    expect(
      await updateLogSettings(
        {},
        form({ intent: "capture", field: "workspaceId", id: "missing" }),
      ),
    ).toEqual({ error: "logsSettingsError" });
    mocks.read.mockResolvedValue({ value: "not json" });
    expect(await updateLogSettings({}, form({ intent: "stop" }))).toEqual({
      error: "logsSettingsError",
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("denies non-admins before starting a transaction", async () => {
    mocks.auth.mockRejectedValue(new Error("Forbidden"));
    await expect(
      updateLogSettings({}, form({ intent: "stop" })),
    ).rejects.toThrow("Forbidden");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
