// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  list: vi.fn(),
  listing: vi.fn(),
  agent: vi.fn(),
  user: vi.fn(),
  workspace: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@/lib/market/listings", () => ({
  listMarketListings: m.list,
  getMarketListing: m.listing,
}));
vi.mock("@/lib/agents/market", () => ({
  getAgentMarketListingByDirectorySlug: m.agent,
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: m.user,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/market/pi-package-archive", () => ({
  getPiPackageDownload: m.archive,
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { GET as list } from "@/app/api/v1/market/listings/route";
import { GET as detail } from "@/app/api/v1/market/listings/[namespace]/[slug]/route";
import { GET as download } from "@/app/api/v1/workspaces/[slug]/market/pi-packages/[releaseId]/download/route";
const request = new Request("https://test/api");
const ctx = { params: Promise.resolve({ namespace: "team", slug: "kit" }) };
const packageCtx = {
  params: Promise.resolve({ slug: "team", releaseId: "release" }),
};
describe("market discovery and package download boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.list.mockResolvedValue({ items: [], total: 0 });
    m.user.mockResolvedValue({ id: "user" });
    m.workspace.mockResolvedValue({ id: "ws" });
  });
  it.each([
    "",
    "?sort=newest&kind=skill&q=hello&tag=tag&category=tools&page=2&pageSize=12",
    "?sort=name",
    "?sort=invalid",
  ])("normalizes catalog query %s", async (query) => {
    const response = await list(new Request(`https://test/api${query}`));
    expect(await response.json()).toEqual({ items: [], total: 0 });
    const params = new URLSearchParams(query);
    expect(m.list).toHaveBeenCalledWith({
      kind: params.get("kind") ?? undefined,
      q: params.get("q") ?? undefined,
      tag: params.get("tag") ?? undefined,
      category: params.get("category") ?? undefined,
      sort:
        params.get("sort") === "newest"
          ? "newest"
          : params.get("sort") === "name"
            ? "name"
            : "popular",
      page: Number(params.get("page")),
      pageSize: Number(params.get("pageSize")),
    });
  });
  it("returns a standard listing without querying agent fallback", async () => {
    m.listing.mockResolvedValue({ id: "listing", kind: "skill" });
    expect(await (await detail(request, ctx)).json()).toEqual({
      id: "listing",
      kind: "skill",
    });
    expect(m.agent).not.toHaveBeenCalled();
  });
  it.each([null, { workspace: { slug: "other" } }])(
    "does not expose missing or foreign agent listings %j",
    async (agent) => {
      m.listing.mockResolvedValue(null);
      m.agent.mockResolvedValue(agent);
      expect((await detail(request, ctx)).status).toBe(404);
    },
  );
  it.each([
    { workspace: { slug: "team" }, namespace: "team" },
    { workspace: null, namespace: "toolplane" },
  ])(
    "maps an agent listing in its canonical namespace %j",
    async ({ workspace, namespace }) => {
      m.agent.mockResolvedValue({
        workspace,
        listing: { id: "listing", directorySlug: "kit", name: "Agent" },
        release: { id: "release", summary: "Summary" },
        manifest: { version: 1 },
      });
      const response = await detail(request, {
        params: Promise.resolve({ namespace, slug: "kit" }),
      });
      expect(await response.json()).toMatchObject({
        id: "listing",
        namespace,
        kind: "agent",
        slug: "kit",
        latestRelease: {
          id: "release",
          releaseSummary: "Summary",
          manifest: { version: 1 },
        },
      });
    },
  );
  it("requires account authentication before resolving workspace", async () => {
    m.user.mockResolvedValue(null);
    expect((await download(request, packageCtx)).status).toBe(401);
    expect(m.workspace).not.toHaveBeenCalled();
  });
  it("forbids a workspace without membership", async () => {
    m.workspace.mockResolvedValue(null);
    expect((await download(request, packageCtx)).status).toBe(403);
    expect(m.archive).not.toHaveBeenCalled();
  });
  it("streams the authorized artifact with checksum and private download headers", async () => {
    m.archive.mockResolvedValue({
      archive: Buffer.from([31, 139, 8]),
      filename: "package.tgz",
      checksum: "sha256:abc",
    });
    const response = await download(request, packageCtx);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([31, 139, 8]),
    );
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="package.tgz"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-toolplane-release-checksum")).toBe(
      "sha256:abc",
    );
    expect(m.archive).toHaveBeenCalledWith({
      workspaceId: "ws",
      userId: "user",
      releaseId: "release",
    });
  });
  it.each([
    { error: new Error("not_authorized"), code: "not_authorized", status: 403 },
    {
      error: new Error("listing_unavailable"),
      code: "listing_unavailable",
      status: 404,
    },
    {
      error: new Error("private details"),
      code: "pi_package_invalid",
      status: 422,
    },
    { error: "failure", code: "pi_package_invalid", status: 422 },
  ])(
    "maps archive errors without leaking internals $code",
    async ({ error, code, status }) => {
      m.archive.mockRejectedValue(error);
      const response = await download(request, packageCtx);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code });
    },
  );
});
