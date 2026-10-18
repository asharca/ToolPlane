// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAssistantTemplateInput } from "@/lib/admin/market-catalog";
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
  reject: vi.fn(),
  categories: vi.fn(),
  servers: vi.fn(),
  serverUpdate: vi.fn(),
  toolkit: vi.fn(),
  toolkitUpdate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const db = {
    marketListing: {
      findFirst: m.find,
      findUnique: m.find,
      create: m.create,
      update: m.update,
      deleteMany: m.remove,
    },
    marketRelease: { create: m.release, updateMany: m.reject },
    category: { count: m.categories },
    server: { findMany: m.servers, update: m.serverUpdate },
    toolkit: { findFirst: m.toolkit, update: m.toolkitUpdate },
  };
  return { db: { ...db, $transaction: m.transaction } };
});
vi.mock("@/lib/observability/audit", () => ({ writeAudit: m.audit }));
import {
  createAdminAssistantTemplate,
  updateAdminAssistantTemplate,
  getAdminAssistantTemplate,
  deleteAdminAssistantTemplate,
  updateAdminMarketListing,
  updateAdminPublicToolkit,
} from "@/lib/admin/market-catalog";
const input: AdminAssistantTemplateInput = {
  slug: "helper",
  name: "Helper",
  author: "Toolplane",
  summary: null,
  iconUrl: null,
  tags: [" Tag ", "tag", ""],
  categoryIds: ["c"],
  status: "published",
  isFeatured: true,
  systemPrompt: "Help the user",
  maxSteps: 10,
  modelFormat: null,
  model: null,
  serverIds: [],
};
const listing = {
  id: "l",
  slug: "helper",
  latestVersion: 2,
  pendingReleaseId: null,
  publishedAt: null,
  kind: "assistant",
  status: "draft",
  curated: false,
  isFeatured: false,
  categories: [{ id: "old" }],
  latestRelease: { reviewStatus: "approved" },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.transaction.mockImplementation(async (run) =>
    run({
      marketListing: {
        findFirst: m.find,
        findUnique: m.find,
        create: m.create,
        update: m.update,
        deleteMany: m.remove,
      },
      marketRelease: { create: m.release, updateMany: m.reject },
      category: { count: m.categories },
      server: { findMany: m.servers, update: m.serverUpdate },
      toolkit: { findFirst: m.toolkit, update: m.toolkitUpdate },
    }),
  );
  m.find.mockResolvedValue(listing);
  m.categories.mockResolvedValue(1);
  m.servers.mockResolvedValue([]);
  m.create.mockResolvedValue({ id: "l" });
  m.release.mockImplementation(async ({ data }) => ({ id: "r", ...data }));
  m.update.mockImplementation(async ({ data }) => ({ id: "l", ...data }));
  m.remove.mockResolvedValue({ count: 1 });
});
describe("administrator assistant immutable releases", () => {
  it.each([
    { status: "unknown" },
    { categoryIds: [] },
    { maxSteps: 0 },
    { maxSteps: 1001 },
    { model: "model" },
    { modelFormat: "openai" },
  ])("rejects invalid configuration before writes", async (override) => {
    const value = { ...input, ...override } as AdminAssistantTemplateInput;
    await expect(
      createAdminAssistantTemplate(value, "admin"),
    ).rejects.toThrow();
    await expect(
      updateAdminAssistantTemplate("l", value, "admin"),
    ).rejects.toThrow();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });
  it.each(["create", "update"])(
    "checks categories and verified MCP identities during %s",
    async (operation) => {
      const run =
        operation === "create"
          ? (value: AdminAssistantTemplateInput) =>
              createAdminAssistantTemplate(value, "admin")
          : (value: AdminAssistantTemplateInput) =>
              updateAdminAssistantTemplate("l", value, "admin");
      await expect(
        run({ ...input, categoryIds: ["c", "c"] }),
      ).rejects.toMatchObject({ code: "invalid_categories" });
      m.categories.mockResolvedValueOnce(0);
      await expect(run(input)).rejects.toMatchObject({
        code: "invalid_categories",
      });
      await expect(
        run({ ...input, serverIds: ["s", "s"] }),
      ).rejects.toMatchObject({ code: "invalid_config" });
      await expect(
        run({ ...input, serverIds: ["missing"] }),
      ).rejects.toMatchObject({ code: "invalid_config" });
      expect(m.release).not.toHaveBeenCalled();
    },
  );
  it.each(["published", "draft", "disabled"] as const)(
    "creates a %s template with a checksummed approved snapshot",
    async (status) => {
      await createAdminAssistantTemplate({ ...input, status }, "admin");
      const data = m.release.mock.calls[0][0].data;
      expect(data).toMatchObject({
        listingId: "l",
        version: 1,
        reviewStatus: "approved",
        reviewedById: "admin",
        categoryIds: ["c"],
      });
      expect(data.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(data.manifest.listing.tags).toEqual(["tag"]);
      expect(m.create.mock.calls[0][0].data.publishedAt).toEqual(
        status === "published" ? expect.any(Date) : null,
      );
      expect(m.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "market.assistant.created" }),
      );
    },
  );
  it("captures selected MCP and model requirements without runtime secrets", async () => {
    m.servers.mockResolvedValue([{ id: "s", slug: "search", name: "Search" }]);
    await createAdminAssistantTemplate(
      { ...input, modelFormat: "openai", model: "gpt", serverIds: ["s"] },
      "admin",
    );
    expect(m.release.mock.calls[0][0].data.manifest.assistant).toMatchObject({
      modelRequirement: { providerFormat: "openai", model: "gpt" },
      mcpRequirements: [{ catalogSlug: "search", name: "Search" }],
    });
  });
  it("translates only unique conflicts while preserving unknown failures", async () => {
    m.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      createAdminAssistantTemplate(input, "admin"),
    ).rejects.toMatchObject({ code: "slug_conflict" });
    await expect(createAdminAssistantTemplate(input, "admin")).rejects.toThrow(
      "offline",
    );
  });
  it("rejects credential-containing assistant prompts", async () => {
    await expect(
      createAdminAssistantTemplate(
        {
          ...input,
          systemPrompt:
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890",
        },
        "admin",
      ),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    await expect(
      updateAdminAssistantTemplate(
        "l",
        {
          ...input,
          systemPrompt:
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890",
        },
        "admin",
      ),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(m.release).not.toHaveBeenCalled();
  });
  it("requires the original slug and an existing platform assistant", async () => {
    m.find.mockResolvedValueOnce(null);
    await expect(
      updateAdminAssistantTemplate("l", input, "admin"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateAdminAssistantTemplate("l", { ...input, slug: "other" }, "admin"),
    ).rejects.toMatchObject({ code: "slug_conflict" });
  });
  it.each([null, new Date("2026-01-01")])(
    "supersedes pending review and retains original publication time",
    async (publishedAt) => {
      m.find.mockResolvedValue({
        ...listing,
        pendingReleaseId: "pending",
        publishedAt,
      });
      const updated = await updateAdminAssistantTemplate("l", input, "admin");
      expect(m.reject).toHaveBeenCalledWith({
        where: { id: "pending", reviewStatus: "pending" },
        data: expect.objectContaining({
          reviewStatus: "rejected",
          reviewedById: "admin",
        }),
      });
      expect(updated).toMatchObject({
        latestVersion: 3,
        latestReleaseId: "r",
        pendingReleaseId: null,
        publishedAt: publishedAt ?? expect.any(Date),
        tags: ["tag"],
      });
    },
  );
  it("keeps unpublished templates unpublished when updating draft metadata", async () => {
    const updated = await updateAdminAssistantTemplate(
      "l",
      { ...input, status: "draft" },
      "admin",
    );
    expect(updated.publishedAt).toBeNull();
    expect(m.reject).not.toHaveBeenCalled();
  });
  it("returns null for absent snapshots and validates stored checksums", async () => {
    m.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ latestRelease: null });
    expect(await getAdminAssistantTemplate("missing")).toBeNull();
    expect(await getAdminAssistantTemplate("empty")).toBeNull();
    await createAdminAssistantTemplate(input, "admin");
    const { manifest, checksum } = m.release.mock.calls[0][0].data;
    m.find.mockResolvedValue({
      ...listing,
      latestRelease: { manifest, checksum },
    });
    expect(await getAdminAssistantTemplate("l")).toMatchObject({
      serverIds: [],
      manifest,
    });
    m.find.mockResolvedValue({
      ...listing,
      latestRelease: { manifest, checksum: "tampered" },
    });
    await expect(getAdminAssistantTemplate("l")).rejects.toThrow("checksum");
  });
  it("deletes only platform assistant templates and audits successful deletion", async () => {
    await deleteAdminAssistantTemplate("l");
    expect(m.remove).toHaveBeenCalledWith({
      where: { id: "l", kind: "assistant", publisherKind: "platform" },
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "system",
        action: "market.assistant.deleted",
      }),
    );
    m.remove.mockResolvedValue({ count: 0 });
    await expect(deleteAdminAssistantTemplate("missing")).rejects.toMatchObject(
      { code: "not_found" },
    );
  });
});
describe("market listing moderation propagation", () => {
  const moderation = {
    id: "l",
    status: "published" as const,
    curated: true,
    isFeatured: true,
    categoryIds: ["c"],
  };
  it("refuses invalid status, missing listing, and unapproved releases", async () => {
    await expect(
      updateAdminMarketListing({ ...moderation, status: "invalid" as "draft" }),
    ).rejects.toMatchObject({ code: "invalid_status" });
    m.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...listing, latestRelease: null });
    await expect(updateAdminMarketListing(moderation)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(updateAdminMarketListing(moderation)).rejects.toMatchObject({
      code: "release_required",
    });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("requires verified MCP tool metadata before publication", async () => {
    m.find.mockResolvedValue({ ...listing, kind: "mcp", sourceServer: null });
    await expect(updateAdminMarketListing(moderation)).rejects.toMatchObject({
      code: "invalid_config",
    });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("propagates categories to a verified source MCP", async () => {
    m.find.mockResolvedValue({
      ...listing,
      kind: "mcp",
      sourceServerId: "s",
      sourceServer: {
        verifiedAt: new Date(),
        verifiedTools: 0,
        installCfg: { toolCatalog: [] },
      },
    });
    await updateAdminMarketListing(moderation, "admin");
    expect(m.serverUpdate).toHaveBeenCalledWith({
      where: { id: "s" },
      data: { categories: { set: [{ id: "c" }] } },
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "admin",
        changes: {
          before: {
            status: "draft",
            curated: false,
            isFeatured: false,
            categoryIds: ["old"],
          },
          after: moderation,
        },
      }),
    );
  });
  it.each(["published", "disabled"] as const)(
    "synchronizes source toolkit enabled state to %s",
    async (status) => {
      m.find.mockResolvedValue({
        ...listing,
        kind: "toolkit",
        sourceToolkitId: "t",
      });
      await updateAdminMarketListing({ ...moderation, status });
      expect(m.toolkitUpdate).toHaveBeenCalledWith({
        where: { id: "t" },
        data: {
          enabled: status === "published",
          categories: { set: [{ id: "c" }] },
        },
      });
    },
  );
  it("updates only existing public toolkits with audited previous categories", async () => {
    m.toolkit.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "t",
      enabled: true,
      workspaceId: "w",
      categories: [{ id: "old" }],
    });
    await expect(
      updateAdminPublicToolkit({ id: "t", enabled: false, categoryIds: ["c"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await updateAdminPublicToolkit(
      { id: "t", enabled: false, categoryIds: ["c"] },
      "admin",
    );
    expect(m.toolkitUpdate).toHaveBeenCalledWith({
      where: { id: "t" },
      data: { enabled: false, categories: { set: [{ id: "c" }] } },
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "w",
        action: "market.toolkit.updated",
        changes: {
          before: { enabled: true, categoryIds: ["old"] },
          after: { id: "t", enabled: false, categoryIds: ["c"] },
        },
      }),
    );
  });
});
