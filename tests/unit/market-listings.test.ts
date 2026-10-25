import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  categoryFindMany: vi.fn(),
  listAgentMarketListings: vi.fn(),
  metadata: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    marketListing: { count: mocks.count, findMany: mocks.findMany },
    category: { findMany: mocks.categoryFindMany },
    $queryRaw: mocks.metadata,
  },
}));
vi.mock("@/lib/agents/market", () => ({
  listAgentMarketListings: mocks.listAgentMarketListings,
}));

import {
  listMarketListingCategories,
  listMarketListings,
} from "@/lib/market/listings";

describe("market listing pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.metadata.mockResolvedValue([]);
    mocks.listAgentMarketListings.mockResolvedValue({
      items: [],
      total: 0,
      availableTotal: 0,
      page: 1,
      pageSize: 24,
    });
  });

  it.each([undefined, 0, Number.NaN])(
    "defaults an invalid page size (%s) to 24",
    async (pageSize) => {
      await expect(listMarketListings({ pageSize })).resolves.toMatchObject({
        pageSize: 24,
      });
      expect(mocks.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 24 }),
      );
    },
  );

  it("filters exact tags and applies the requested sort", async () => {
    await listMarketListings({
      kind: "assistant",
      tag: " Research ",
      sort: "name",
    });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "assistant",
          tags: { has: "research" },
        }),
        orderBy: [{ isFeatured: "desc" }, { name: "asc" }],
      }),
    );
  });

  it("serves agent listings from the real agent marketplace", async () => {
    mocks.listAgentMarketListings.mockResolvedValue({
      total: 1,
      availableTotal: 1,
      page: 1,
      pageSize: 24,
      items: [
        {
          id: "agent-1",
          workspaceSlug: "acme",
          directorySlug: "acme-research",
          name: "Research Agent",
          summary: "Researches",
          iconUrl: null,
          tags: ["research"],
          categories: [{ slug: "research", name: "Research" }],
          curated: false,
          isFeatured: false,
          installCount: 3,
          publishedAt: new Date("2026-01-01"),
          latestReleaseId: "agent-release-1",
          latestVersion: 2,
          releaseSummary: { resourceCount: 1 },
        },
      ],
    });

    await expect(
      listMarketListings({ kind: "agent", q: "research" }),
    ).resolves.toMatchObject({
      items: [
        {
          kind: "agent",
          namespace: "acme",
          slug: "acme-research",
          latestRelease: { id: "agent-release-1", version: 2 },
        },
      ],
    });
    expect(mocks.listAgentMarketListings).toHaveBeenCalledWith(
      expect.objectContaining({ q: "research", pageSize: 24 }),
    );
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("filters by a real category relation and returns category metadata", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "listing-1",
        categories: [{ slug: "research", name: "Research" }],
      },
    ]);

    await expect(
      listMarketListings({ kind: "assistant", category: "research" }),
    ).resolves.toMatchObject({
      items: [{ categories: [{ slug: "research", name: "Research" }] }],
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          categories: { some: { slug: "research" } },
        }),
        select: expect.objectContaining({
          categories: {
            select: { slug: true, name: true },
            orderBy: { name: "asc" },
          },
        }),
      }),
    );
  });

  it("returns only small approved runtime metadata for cards, never executable manifest bytes", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pi",
        kind: "pi-package",
        latestRelease: { id: "pi-release", version: 1 },
      },
      {
        id: "mcp",
        kind: "mcp",
        latestRelease: { id: "mcp-release", version: 1 },
      },
    ]);
    mocks.metadata.mockResolvedValue([
      {
        id: "pi-release",
        sourceKind: "zip",
        piVersion: "0.87.1",
        nodeMajor: "24",
        platform: "linux",
        arch: "x64",
      },
      {
        id: "mcp-release",
        sourceKind: null,
        mcpSource: "config",
        transport: null,
      },
    ]);
    const result = await listMarketListings();
    expect(result.items).toMatchObject([
      {
        sourceKind: "zip",
        runtimeCompatibility: {
          runtime: "pi-sdk",
          nodeMajor: 24,
          platform: "linux",
          arch: "x64",
        },
      },
      {
        sourceKind: "config",
        runtimeCompatibility: { runtime: "mcp", transport: "stdio" },
      },
    ]);
    expect(
      result.items.every(
        (item) => !item.latestRelease || !("manifest" in item.latestRelease),
      ),
    ).toBe(true);
    expect(
      mocks.findMany.mock.calls[0][0].select.latestRelease.select,
    ).not.toHaveProperty("manifest");
  });

  it("constrains source and runtime in the shared database predicate before page slicing", async () => {
    await listMarketListings({
      sourceKind: "zip",
      runtime: "pi-sdk",
      page: 2,
      pageSize: 1,
    });
    const predicate = mocks.findMany.mock.calls[0][0].where.latestRelease;
    expect(predicate.is).toMatchObject({
      reviewStatus: "approved",
      AND: [
        {
          OR: [
            {
              manifest: { path: ["package", "source", "kind"], equals: "zip" },
            },
            { manifest: { path: ["mcp", "recipe", "source"], equals: "zip" } },
          ],
        },
        {
          manifest: { path: ["package", "runtime", "kind"], equals: "pi-sdk" },
        },
      ],
    });
    expect(
      mocks.count.mock.calls.every(
        ([query]) => query.where.latestRelease === predicate,
      ),
    ).toBe(true);
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({ skip: 1, take: 1 });
  });

  it("builds category facets in descending usage order", async () => {
    mocks.categoryFindMany.mockResolvedValue([
      { slug: "chat", name: "Chat", _count: { marketListings: 1 } },
      { slug: "research", name: "Research", _count: { marketListings: 2 } },
    ]);

    await expect(listMarketListingCategories("assistant")).resolves.toEqual([
      { slug: "research", name: "Research", count: 2 },
      { slug: "chat", name: "Chat", count: 1 },
    ]);
    expect(mocks.categoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          marketListings: {
            some: expect.objectContaining({ kind: "assistant" }),
          },
        },
      }),
    );
  });
});
