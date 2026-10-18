// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
  listing: vi.fn(),
  tracking: vi.fn(),
  install: vi.fn(),
  publish: vi.fn(),
  check: vi.fn(),
  ignore: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  registry: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.refresh }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique: m.member },
    marketListing: { findFirst: m.listing },
    piPackageTracking: { findFirst: m.tracking },
  },
}));
vi.mock("@/lib/market/resources", () => ({
  installOfficialPiPackage: m.install,
  publishPiPackageRelease: m.publish,
}));
vi.mock("@/lib/market/pi-package-catalog", () => ({
  checkPiPackageUpdates: m.check,
  ignorePiPackageUpdate: m.ignore,
  createPiPackageSource: m.create,
  updatePiPackageSource: m.update,
  deletePiPackageSource: m.remove,
  publishPiPackageToRegistry: m.registry,
}));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { MarketError } from "@/lib/market/skills";
import { piCatalogAction } from "@/lib/market/pi-catalog-actions";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ workspace: "team", ...values }))
    data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "u" });
  m.workspace.mockResolvedValue({ id: "w", slug: "team", ownerId: "u" });
  m.install.mockResolvedValue({ install: { id: "i" } });
  m.publish.mockResolvedValue({ listing: { id: "l" } });
});
describe("Pi catalog action security and transitions", () => {
  it("refuses anonymous and inaccessible workspaces", async () => {
    m.user.mockResolvedValueOnce(null);
    expect(await piCatalogAction({}, form())).toEqual({
      error: "not_authorized",
    });
    expect(m.workspace).not.toHaveBeenCalled();
    m.workspace.mockResolvedValueOnce(null);
    expect(await piCatalogAction({}, form())).toEqual({
      error: "not_authorized",
    });
    expect(m.refresh).not.toHaveBeenCalled();
  });
  it.each([null, { role: "member" }])(
    "requires owner or admin for source mutation",
    async (membership) => {
      m.workspace.mockResolvedValue({
        id: "w",
        slug: "team",
        ownerId: "other",
      });
      m.member.mockResolvedValue(membership);
      expect(
        await piCatalogAction(
          {},
          form({ operation: "create-source", auth: "keep", kind: "npm" }),
        ),
      ).toEqual({ error: "not_authorized" });
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("allows ordinary members to install an official package without source-administration rights", async () => {
    m.workspace.mockResolvedValue({ id: "w", slug: "team", ownerId: "other" });
    expect(
      await piCatalogAction(
        {},
        form({
          operation: "install-official",
          name: " pkg ",
          version: " 1.2.3 ",
        }),
      ),
    ).toEqual({ ok: true, installId: "i", listingId: undefined });
    expect(m.install).toHaveBeenCalledWith({
      workspaceId: "w",
      userId: "u",
      name: "pkg",
      version: "1.2.3",
    });
    expect(m.member).not.toHaveBeenCalled();
    expect(m.refresh.mock.calls.map(([path]) => path)).toEqual([
      "/app/team/market/pi-packages",
      "/app/team/toolkits/pi-packages",
      "/app/team/toolkits/pi-packages/sources",
      "/app/team/market/installed",
    ]);
  });
  it.each(["", "listing"])(
    "checks all or a selected tracked listing",
    async (listingId) => {
      expect(
        await piCatalogAction({}, form({ operation: "check", listingId })),
      ).toMatchObject({ ok: true });
      expect(m.check).toHaveBeenCalledWith({
        workspaceId: "w",
        userId: "u",
        ...(listingId ? { listingId } : {}),
      });
    },
  );
  it("ignores the selected update identity as a member", async () => {
    expect(
      await piCatalogAction(
        {},
        form({ operation: "ignore", listingId: "l", identity: "sha256:abc" }),
      ),
    ).toMatchObject({ ok: true });
    expect(m.ignore).toHaveBeenCalledWith({
      workspaceId: "w",
      userId: "u",
      listingId: "l",
      identity: "sha256:abc",
    });
  });
  it.each(["create-source", "update-source"])(
    "rejects unrecognized credential modes for %s",
    async (operation) => {
      expect(
        await piCatalogAction({}, form({ operation, auth: "unexpected" })),
      ).toEqual({ error: "invalid_source" });
      expect(m.create).not.toHaveBeenCalled();
      expect(m.update).not.toHaveBeenCalled();
    },
  );
  it.each(["catalog", "npm", "git"])(
    "creates a %s source for workspace admins",
    async (kind) => {
      m.workspace.mockResolvedValue({
        id: "w",
        slug: "team",
        ownerId: "other",
      });
      m.member.mockResolvedValue({ role: "admin" });
      expect(
        await piCatalogAction(
          {},
          form({
            operation: "create-source",
            auth: "keep",
            kind,
            name: " Team ",
            url: " https://registry.example.com ",
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(m.create).toHaveBeenCalledWith({
        workspaceId: "w",
        userId: "u",
        name: "Team",
        kind,
        url: "https://registry.example.com",
        credentials: undefined,
      });
    },
  );
  it("rejects unsupported source kinds", async () => {
    expect(
      await piCatalogAction(
        {},
        form({ operation: "create-source", auth: "clear", kind: "http" }),
      ),
    ).toEqual({ error: "invalid_source" });
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each([
    { auth: "keep", expected: undefined },
    { auth: "clear", expected: null },
    { auth: "bearer", expected: { type: "bearer", token: " token " } },
    {
      auth: "basic",
      expected: { type: "basic", username: "name", password: " password " },
    },
  ])(
    "updates sources with $auth credential semantics",
    async ({ auth, expected }) => {
      expect(
        await piCatalogAction(
          {},
          form({
            operation: "update-source",
            sourceId: "s",
            name: "Team",
            url: "https://registry.example.com",
            auth,
            token: " token ",
            username: " name ",
            password: " password ",
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(m.update).toHaveBeenCalledWith({
        workspaceId: "w",
        userId: "u",
        sourceId: "s",
        name: "Team",
        url: "https://registry.example.com",
        credentials: expected,
      });
    },
  );
  it.each(["delete-source", "registry-publish"])(
    "requires explicit confirmation for %s",
    async (operation) => {
      expect(await piCatalogAction({}, form({ operation }))).toEqual({
        error: "confirmation_required",
      });
      expect(m.remove).not.toHaveBeenCalled();
      expect(m.registry).not.toHaveBeenCalled();
    },
  );
  it("deletes a confirmed source", async () => {
    expect(
      await piCatalogAction(
        {},
        form({ operation: "delete-source", confirm: "on", sourceId: "s" }),
      ),
    ).toMatchObject({ ok: true });
    expect(m.remove).toHaveBeenCalledWith({
      workspaceId: "w",
      userId: "u",
      sourceId: "s",
    });
  });
  it.each(["", "beta"])(
    "publishes confirmed releases with optional tags",
    async (tag) => {
      expect(
        await piCatalogAction(
          {},
          form({
            operation: "registry-publish",
            confirm: "on",
            sourceId: "s",
            releaseId: "r",
            tag,
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(m.registry).toHaveBeenCalledWith({
        workspaceId: "w",
        userId: "u",
        sourceId: "s",
        releaseId: "r",
        tag: tag || undefined,
        confirm: true,
      });
    },
  );
  it.each(["", "s"])(
    "imports private snapshots with optional source binding",
    async (sourceId) => {
      const data = form({
        operation: "import",
        source: "npm:pkg",
        sourceId,
        name: "Package",
        slug: "package",
        summary: "Summary",
      });
      data.append("categoryIds", "c1");
      data.append("categoryIds", "c2");
      expect(await piCatalogAction({}, data)).toMatchObject({
        ok: true,
        listingId: "l",
      });
      expect(m.publish).toHaveBeenCalledWith({
        workspaceId: "w",
        publishedById: "u",
        source: "npm:pkg",
        sourceId: sourceId || undefined,
        listingId: undefined,
        visibility: "private",
        listing: {
          name: "Package",
          slug: "package",
          summary: "Summary",
          tags: [],
        },
        categoryIds: ["c1", "c2"],
      });
    },
  );
  it.each([
    { visibility: "public", summary: "Summary", sourceId: "s" },
    { visibility: "private", summary: null, sourceId: null },
    { visibility: "unexpected", summary: null, sourceId: null },
  ])(
    "captures tracked source while preserving publisher metadata",
    async ({ visibility, summary, sourceId }) => {
      m.listing.mockResolvedValue({
        id: "existing",
        name: "Original",
        slug: "original",
        summary,
        tags: ["tag"],
        categories: [{ id: "c" }],
        visibility,
      });
      m.tracking.mockResolvedValue({ requested: "npm:original", sourceId });
      expect(
        await piCatalogAction(
          {},
          form({
            operation: "capture",
            listingId: "existing",
            source: "npm:attacker",
            name: "Attacker",
          }),
        ),
      ).toMatchObject({ ok: true, listingId: "l" });
      expect(m.publish).toHaveBeenCalledWith({
        workspaceId: "w",
        publishedById: "u",
        source: "npm:original",
        sourceId: sourceId ?? undefined,
        listingId: "existing",
        visibility: visibility === "public" ? "public" : "private",
        listing: {
          name: "Original",
          slug: "original",
          summary: summary ?? "",
          tags: ["tag"],
        },
        categoryIds: ["c"],
      });
    },
  );
  it("rejects captures without an owned listing or tracking record", async () => {
    m.listing.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "l" });
    m.tracking.mockResolvedValue(null);
    expect(await piCatalogAction({}, form({ operation: "capture" }))).toEqual({
      error: "source_not_found",
    });
    expect(m.tracking).not.toHaveBeenCalled();
    expect(await piCatalogAction({}, form({ operation: "capture" }))).toEqual({
      error: "source_not_found",
    });
    expect(m.publish).not.toHaveBeenCalled();
  });
  it.each([
    new MarketError("source_not_found", "secret response"),
    new Error("https://secret.example.com"),
    new Error("secret upstream token"),
  ])("exposes only bounded machine-readable errors", async (error) => {
    m.install.mockRejectedValue(error);
    expect(
      await piCatalogAction({}, form({ operation: "install-official" })),
    ).toEqual({
      error:
        error instanceof MarketError && error.code === "source_not_found"
          ? "source_not_found"
          : "action_failed",
    });
    expect(m.refresh).not.toHaveBeenCalled();
  });
  it("rejects unknown operations", async () => {
    expect(await piCatalogAction({}, form({ operation: "unknown" }))).toEqual({
      error: "action_failed",
    });
    expect(m.refresh).not.toHaveBeenCalled();
  });
});
