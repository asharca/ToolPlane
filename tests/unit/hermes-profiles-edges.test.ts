// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  ready: vi.fn(),
  mutation: vi.fn(),
  projection: vi.fn(),
  sync: vi.fn(),
  release: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  acquireHermesRuntimeWriteLease: mocks.acquire,
  ensureHermesDashboardReady: mocks.ready,
  runHermesDashboardMutation: mocks.mutation,
  syncHermesProfileProjection: mocks.projection,
  syncHermesRuntime: mocks.sync,
}));
vi.mock("@/lib/agents/hermes/token", () => ({
  deriveHermesRuntimeToken: () => "token",
}));
import {
  ensureHermesProfileProjection,
  hasHermesProfileChatCapabilities,
  hasHermesProfileModel,
  listHermesProfileModels,
  listHermesProfiles,
  normalizeHermesProfile,
  setHermesProfileDefaultModel,
  supportsHermesProfileChat,
} from "@/lib/agents/hermes/profiles";
const agent = {
  id: "a",
  workspaceId: "w",
  runtime: { id: "r", kind: "hermes" },
};
describe("Hermes profile trust boundaries and lease ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.acquire.mockReturnValue({ release: mocks.release });
    mocks.ready.mockResolvedValue({ port: 4000 });
    mocks.projection.mockResolvedValue(true);
    mocks.sync.mockResolvedValue({});
    mocks.mutation.mockImplementation(async (_w, _a, _lease, operation) =>
      operation({ port: 4000 }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([null, undefined, "", "../x", "a/b", "_a", "x".repeat(65)])(
    "rejects unsafe profile %s",
    (value) => expect(normalizeHermesProfile(value)).toBeNull(),
  );
  it("normalizes names and rejects malformed capability envelopes", () => {
    expect(normalizeHermesProfile(" Research_2 ")).toBe("research_2");
    for (const payload of [
      null,
      false,
      "x",
      {},
      { features: null },
      { features: true },
      { features: { session_resources: 1 } },
    ])
      expect(hasHermesProfileChatCapabilities(payload)).toBe(false);
    const options = {
      profile: "default",
      provider: null,
      model: null,
      providers: [
        { id: "p", name: "P", models: ["m"] },
        { id: "alias", name: "Alias", aliases: ["other"], models: ["n"] },
      ],
    };
    expect(hasHermesProfileModel(options, "custom:p", "m")).toBe(true);
    expect(hasHermesProfileModel(options, "other", "n")).toBe(true);
    expect(hasHermesProfileModel(options, "p", "n")).toBe(false);
    expect(hasHermesProfileModel(options, "missing", "m")).toBe(false);
  });
  it("filters malformed rows and bounds optional profile fields", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        profiles: [
          null,
          4,
          {},
          {
            name: "DEFAULT",
            provider: 1,
            model: "x".repeat(513),
            description: "x".repeat(501),
          },
          {
            name: "valid",
            is_default: true,
            provider: " p ",
            model: " m ",
            description: " desc ",
          },
          { name: "blank", provider: " ", model: null },
        ],
      }),
    );
    expect(await listHermesProfiles(agent)).toEqual([
      {
        name: "default",
        isDefault: true,
        provider: null,
        model: null,
        description: "",
      },
      {
        name: "valid",
        isDefault: true,
        provider: "p",
        model: "m",
        description: "desc",
      },
      {
        name: "blank",
        isDefault: false,
        provider: null,
        model: null,
        description: "",
      },
    ]);
  });
  it("filters malformed model providers while retaining aliases and object IDs", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        provider: " p ",
        model: " m ",
        providers: [
          null,
          3,
          { id: "p" },
          { id: "disabled", authenticated: false, models: ["x"] },
          { id: "bad\n", models: ["x"] },
          { id: "\u0001bad", models: ["x"] },
          { id: "empty", models: [null, {}, " "] },
          {
            id: "p",
            label: " P ",
            aliases: [null, " other ", ""],
            models: ["m", { id: " n " }, {}, 4, " "],
          },
          { slug: "fallback", name: "", models: ["m"] },
        ],
      }),
    );
    expect(await listHermesProfileModels(agent, "default")).toEqual({
      profile: "default",
      provider: "p",
      model: "m",
      providers: [
        { id: "bad", name: "bad", models: ["x"] },
        { id: "p", name: "P", aliases: ["other"], models: ["m", "n"] },
        { id: "fallback", name: "fallback", models: ["m"] },
      ],
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it.each(["profiles", "providers"])(
    "rejects invalid %s response shape",
    async (field) => {
      mocks.fetch.mockResolvedValue(Response.json({ [field]: {} }));
      await expect(
        field === "profiles"
          ? listHermesProfiles(agent)
          : listHermesProfileModels(agent, "default"),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each([{ detail: "detail", error: "ignored" }, { error: "error" }, null])(
    "reports bounded upstream error detail %j",
    async (payload) => {
      mocks.fetch.mockResolvedValue(Response.json(payload, { status: 429 }));
      await expect(listHermesProfiles(agent)).rejects.toMatchObject({
        status: 429,
        message: payload?.detail ?? payload?.error ?? "Hermes returned 429.",
      });
    },
  );
  it("handles invalid error JSON and invalid runtime kinds", async () => {
    mocks.fetch.mockResolvedValue(new Response("not json", { status: 500 }));
    await expect(listHermesProfiles(agent)).rejects.toMatchObject({
      status: 500,
      message: "Hermes returned 500.",
    });
    await expect(
      listHermesProfiles({ ...agent, runtime: null }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each([{}, { error: "offline" }])(
    "reports unavailable dashboards %j",
    async (ready) => {
      mocks.ready.mockResolvedValue(ready);
      await expect(listHermesProfiles(agent)).rejects.toMatchObject({
        status: 503,
        message: ready.error ?? "Hermes dashboard is unavailable.",
      });
      await expect(supportsHermesProfileChat(agent)).rejects.toMatchObject({
        status: 503,
      });
    },
  );
  it("validates before acquiring and does not project the default profile", async () => {
    await expect(ensureHermesProfileProjection(agent, "../x")).rejects.toThrow(
      "Invalid Hermes profile",
    );
    await expect(listHermesProfileModels(agent, "../x")).rejects.toThrow(
      "Invalid Hermes profile",
    );
    await expect(
      setHermesProfileDefaultModel(agent, "../x", "p", "m"),
    ).rejects.toThrow("Invalid Hermes profile");
    await ensureHermesProfileProjection(agent, "DEFAULT");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("preserves caller-owned leases on failed and successful projection", async () => {
    const lease = { release: vi.fn() };
    await ensureHermesProfileProjection(agent, "named", lease);
    mocks.projection.mockResolvedValue(false);
    await expect(
      ensureHermesProfileProjection(agent, "named", lease),
    ).rejects.toMatchObject({ status: 503 });
    expect(lease.release).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    await expect(
      ensureHermesProfileProjection(agent, "named"),
    ).rejects.toMatchObject({ status: 503 });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects unavailable leases without making changes", async () => {
    mocks.acquire.mockReturnValue(null);
    await expect(
      ensureHermesProfileProjection(agent, "named"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      setHermesProfileDefaultModel(agent, "named", "p", "m"),
    ).rejects.toMatchObject({ status: 503 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "error", "upstream", "false"])(
    "releases mutation lease on %s",
    async (mode) => {
      if (mode === "missing" || mode === "error")
        mocks.mutation.mockImplementation(async (_w, _a, _l, op) =>
          op(mode === "missing" ? {} : { error: "offline" }),
        );
      if (mode === "upstream")
        mocks.fetch.mockResolvedValue(
          Response.json({ detail: "denied" }, { status: 403 }),
        );
      if (mode === "false") mocks.mutation.mockResolvedValue(false);
      await expect(
        setHermesProfileDefaultModel(agent, "named", "p", "m"),
      ).rejects.toMatchObject({ status: mode === "upstream" ? 403 : 503 });
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it.each([404, 500])(
    "distinguishes unsupported and failed capability probes %s",
    async (status) => {
      mocks.fetch.mockResolvedValue(new Response("bad", { status }));
      if (status === 404)
        await expect(supportsHermesProfileChat(agent)).resolves.toBe(false);
      else
        await expect(supportsHermesProfileChat(agent)).rejects.toMatchObject({
          status: 500,
        });
    },
  );
  it("rejects transport failure and malformed capabilities", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("network"));
    await expect(supportsHermesProfileChat(agent)).rejects.toMatchObject({
      status: 502,
    });
    mocks.fetch.mockResolvedValue(new Response("bad"));
    await expect(supportsHermesProfileChat(agent)).resolves.toBe(false);
  });
  it.each(["sync", "ready", "ready-error", "network"])(
    "handles authentication repair failure at %s",
    async (mode) => {
      mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
      if (mode === "sync")
        mocks.sync.mockResolvedValue({ error: "sync failed" });
      if (mode === "ready")
        mocks.ready
          .mockResolvedValueOnce({ port: 4000 })
          .mockResolvedValueOnce({});
      if (mode === "ready-error")
        mocks.ready
          .mockResolvedValueOnce({ port: 4000 })
          .mockResolvedValueOnce({ error: "stopped" });
      if (mode === "network")
        mocks.fetch.mockRejectedValueOnce(new Error("network"));
      await expect(supportsHermesProfileChat(agent)).rejects.toMatchObject({
        status: mode === "network" ? 502 : 503,
      });
      expect(mocks.sync).toHaveBeenCalledOnce();
    },
  );
});
