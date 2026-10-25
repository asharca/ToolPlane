import "server-only";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { parseAssistantReleaseManifest } from "@/lib/market/assistant-manifest";
import { parseSkillReleaseManifest } from "@/lib/market/skill-manifest";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
  projectPiPackageSummary,
} from "@/lib/market/pi-package-manifest";
import {
  parseResourceMarketManifest,
  projectPublicResourceMarketManifest,
} from "@/lib/market/resources";
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
} from "@/lib/market/secret-scan";
import type { PiPackageSummary } from "@/lib/market/pi-package-manifest";
import type { PublicResourceMarketManifest } from "@/lib/market/resources";

const LISTING_KINDS = new Set([
  "mcp",
  "skill",
  "agent",
  "assistant",
  "pi-package",
]);

export type MarketViewer = { workspaceId: string; userId: string };

export type MarketRuntimeCompatibility =
  | {
      runtime: "pi-sdk";
      piVersion: string;
      nodeMajor: number;
      platform: string;
      arch: string;
    }
  | { runtime: "mcp"; transport: "stdio" | "streamable-http" | "sse" };

async function visibleListings(
  viewer?: MarketViewer,
): Promise<Prisma.MarketListingWhereInput> {
  if (!viewer) return { visibility: "public" };
  const workspace = await db.workspace.findFirst({
    where: {
      id: viewer.workspaceId,
      status: "active",
      OR: [
        { ownerId: viewer.userId },
        { members: { some: { userId: viewer.userId } } },
      ],
    },
    select: { id: true },
  });
  return workspace
    ? {
        OR: [
          { visibility: "public" },
          { visibility: "private", publisherWorkspaceId: workspace.id },
        ],
      }
    : { visibility: "public" };
}

export async function listMarketListings(
  input: {
    kind?: string;
    target?: "agent" | "assistant";
    q?: string;
    tag?: string;
    category?: string;
    sourceKind?: string;
    runtime?: "pi-sdk" | "mcp";
    sort?: "popular" | "newest" | "name";
    page?: number;
    pageSize?: number;
    viewer?: MarketViewer;
  } = {},
) {
  const kind = LISTING_KINDS.has(input.kind ?? "") ? input.kind : undefined;
  const term = input.q?.trim().slice(0, 200) ?? "";
  const sourceKind = input.sourceKind?.trim().slice(0, 40);
  const runtime =
    input.runtime === "pi-sdk" || input.runtime === "mcp"
      ? input.runtime
      : undefined;
  const tag = input.tag?.trim().toLocaleLowerCase().slice(0, 40) ?? "";
  const category =
    input.category?.trim().toLocaleLowerCase().slice(0, 120) ?? "";
  const sort =
    input.sort === "newest" || input.sort === "name" ? input.sort : "popular";
  const page =
    Number.isSafeInteger(input.page) &&
    input.page !== undefined &&
    input.page > 0
      ? input.page
      : 1;
  const pageSize =
    Number.isSafeInteger(input.pageSize) &&
    input.pageSize !== undefined &&
    input.pageSize > 0
      ? Math.min(50, input.pageSize)
      : 24;
  if (input.kind === "toolkit")
    return { items: [], total: 0, availableTotal: 0, page, pageSize };
  if (input.target === "assistant" && kind === "agent")
    return { items: [], total: 0, availableTotal: 0, page, pageSize };
  if (kind === "agent") {
    if (sourceKind || runtime)
      return { items: [], total: 0, availableTotal: 0, page, pageSize };
    const { listAgentMarketListings } = await import("@/lib/agents/market");
    const result = await listAgentMarketListings({
      q: term || tag,
      category,
      sort,
      page,
      pageSize,
    });
    return {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        kind: "agent" as const,
        namespace: item.workspaceSlug ?? "toolplane",
        slug: item.directorySlug,
        name: item.name,
        summary: item.summary,
        iconUrl: item.iconUrl,
        tags: item.tags,
        categories: item.categories,
        curated: item.curated,
        isFeatured: item.isFeatured,
        installCount: item.installCount,
        publishedAt: item.publishedAt,
        sourceKind: null,
        requiredEnvironment: [] as string[],
        runtimeCompatibility: null as MarketRuntimeCompatibility | null,
        latestRelease: {
          id: item.latestReleaseId,
          version: item.latestVersion,
          releaseSummary: item.releaseSummary,
        },
      })),
    };
  }
  const baseWhere: Prisma.MarketListingWhereInput = {
    AND: [
      await visibleListings(input.viewer),
      ...(input.target === "assistant"
        ? [
            {
              OR: [
                { kind: "assistant" },
                {
                  kind: "mcp",
                  latestRelease: {
                    is: {
                      AND: [
                        {
                          manifest: {
                            path: ["mcp", "recipe", "source"],
                            equals: "remote",
                          },
                        },
                        {
                          OR: [
                            {
                              manifest: {
                                path: ["mcp", "recipe", "transport"],
                                equals: "streamable-http",
                              },
                            },
                            {
                              manifest: {
                                path: ["mcp", "recipe", "transport"],
                                equals: "sse",
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ]
        : [
            {
              kind: {
                in: [
                  "mcp",
                  "skill",
                  "pi-package",
                  ...(input.target === "agent" ? [] : ["assistant"]),
                ],
              },
            },
          ]),
    ],
    status: "published",
    latestReleaseId: { not: null },
    latestRelease: {
      is: {
        reviewStatus: "approved",
        AND: [
          ...(sourceKind
            ? [
                {
                  OR: [
                    {
                      manifest: {
                        path: ["package", "source", "kind"],
                        equals: sourceKind,
                      },
                    },
                    {
                      manifest: {
                        path: ["mcp", "recipe", "source"],
                        equals: sourceKind,
                      },
                    },
                  ],
                },
              ]
            : []),
          ...(runtime
            ? [
                {
                  manifest: {
                    path:
                      runtime === "pi-sdk"
                        ? ["package", "runtime", "kind"]
                        : ["kind"],
                    equals: runtime === "pi-sdk" ? "pi-sdk" : "mcp",
                  },
                },
              ]
            : []),
        ],
      },
    },
    ...(kind ? { kind } : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { summary: { contains: term, mode: "insensitive" } },
            { namespace: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } },
            { tags: { has: term.toLocaleLowerCase() } },
            {
              categories: {
                some: { name: { contains: term, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };
  const where: Prisma.MarketListingWhereInput = {
    ...baseWhere,
    ...(tag ? { tags: { has: tag } } : {}),
    ...(category ? { categories: { some: { slug: category } } } : {}),
  };
  const orderBy: Prisma.MarketListingOrderByWithRelationInput[] = [
    { isFeatured: "desc" },
    ...(sort === "newest"
      ? [{ publishedAt: "desc" as const }]
      : sort === "name"
        ? [{ name: "asc" as const }]
        : [
            { installCount: "desc" as const },
            { publishedAt: "desc" as const },
          ]),
  ];
  const [total, availableTotal, items] = await Promise.all([
    db.marketListing.count({ where }),
    db.marketListing.count({ where: baseWhere }),
    db.marketListing.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy,
      select: {
        id: true,
        kind: true,
        namespace: true,
        slug: true,
        name: true,
        summary: true,
        iconUrl: true,
        tags: true,
        categories: {
          select: { slug: true, name: true },
          orderBy: { name: "asc" },
        },
        curated: true,
        isFeatured: true,
        installCount: true,
        publishedAt: true,
        latestRelease: {
          select: { id: true, version: true, releaseSummary: true },
        },
      },
    }),
  ]);
  const releaseIds = items.flatMap((item) =>
    item.latestRelease ? [item.latestRelease.id] : [],
  );
  const metadata = releaseIds.length
    ? await db.$queryRaw<
        Array<{
          id: string;
          sourceKind: string | null;
          piVersion: string | null;
          nodeMajor: string | null;
          platform: string | null;
          arch: string | null;
          mcpSource: string | null;
          transport: string | null;
          requiredEnvironment: unknown;
        }>
      >`
    SELECT id, manifest #>> '{package,source,kind}' AS "sourceKind",
      manifest #>> '{package,runtime,piVersion}' AS "piVersion", manifest #>> '{package,runtime,nodeMajor}' AS "nodeMajor",
      manifest #>> '{package,runtime,platform}' AS platform, manifest #>> '{package,runtime,arch}' AS arch,
      manifest #>> '{mcp,recipe,source}' AS "mcpSource", manifest #>> '{mcp,recipe,transport}' AS transport,
      manifest #> '{mcp,recipe,env}' AS "requiredEnvironment"
    FROM "MarketRelease" WHERE id = ANY(${releaseIds}::text[]) AND "reviewStatus" = 'approved'
  `
    : [];
  const byRelease = new Map(metadata.map((row) => [row.id, row]));
  return {
    items: items.map((item) => {
      const row = item.latestRelease
        ? byRelease.get(item.latestRelease.id)
        : undefined;
      let runtimeCompatibility: MarketRuntimeCompatibility | null = null;
      if (
        item.kind === "pi-package" &&
        row?.piVersion &&
        row.nodeMajor &&
        row.platform &&
        row.arch
      ) {
        runtimeCompatibility = {
          runtime: "pi-sdk",
          piVersion: row.piVersion,
          nodeMajor: Number(row.nodeMajor),
          platform: row.platform,
          arch: row.arch,
        };
      } else if (item.kind === "mcp" && row?.mcpSource) {
        runtimeCompatibility = {
          runtime: "mcp",
          transport:
            row.mcpSource === "remote"
              ? row.transport === "sse"
                ? "sse"
                : "streamable-http"
              : "stdio",
        };
      }
      return {
        ...item,
        sourceKind: row?.sourceKind ?? row?.mcpSource ?? null,
        requiredEnvironment: Array.isArray(row?.requiredEnvironment)
          ? row.requiredEnvironment.filter(
              (name): name is string =>
                typeof name === "string" &&
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
            )
          : [],
        runtimeCompatibility,
      };
    }),
    total,
    availableTotal,
    page,
    pageSize,
  };
}

export async function listMarketListingCategories(
  kind: "skill" | "assistant" | "pi-package",
  viewer?: MarketViewer,
) {
  const listingWhere: Prisma.MarketListingWhereInput = {
    kind,
    AND: [await visibleListings(viewer)],
    status: "published",
    latestReleaseId: { not: null },
    latestRelease: { is: { reviewStatus: "approved" } },
  };
  const rows = await db.category.findMany({
    where: { marketListings: { some: listingWhere } },
    orderBy: { name: "asc" },
    select: {
      slug: true,
      name: true,
      _count: { select: { marketListings: { where: listingWhere } } },
    },
  });
  return rows
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      count: row._count.marketListings,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function getMarketListing(
  namespace: string,
  slug: string,
  viewer?: MarketViewer,
) {
  const listing = await db.marketListing.findFirst({
    where: {
      namespace,
      slug,
      AND: [await visibleListings(viewer)],
      status: "published",
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: "approved" } },
    },
    select: {
      id: true,
      kind: true,
      namespace: true,
      slug: true,
      publisherKind: true,
      name: true,
      summary: true,
      iconUrl: true,
      tags: true,
      categories: {
        select: { slug: true, name: true },
        orderBy: { name: "asc" },
      },
      metadata: true,
      status: true,
      visibility: true,
      curated: true,
      isFeatured: true,
      installCount: true,
      publishedAt: true,
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          manifest: true,
          releaseSummary: true,
          checksum: true,
          releaseNotes: true,
          publishedAt: true,
        },
      },
    },
  });
  if (!listing?.latestRelease) return null;
  const latestRelease = listing.latestRelease;
  let publicManifest: PublicResourceMarketManifest | null = null;
  let piPackage: PiPackageSummary | null = null;
  if (listing.kind === "skill") {
    const manifest = parseSkillReleaseManifest(
      latestRelease.manifest,
      latestRelease.checksum,
    );
    if (
      scanSkillReleaseManifest(manifest, latestRelease.releaseNotes).status ===
      "blocked"
    )
      return null;
  } else if (listing.kind === "assistant") {
    const manifest = parseAssistantReleaseManifest(
      latestRelease.manifest,
      latestRelease.checksum,
    );
    if (
      scanMarketArtifact(manifest, latestRelease.releaseNotes).status ===
      "blocked"
    )
      return null;
  } else if (listing.kind === "pi-package") {
    const manifest = parsePiPackageReleaseManifest(
      latestRelease.manifest,
      latestRelease.checksum,
    );
    if (
      scanPiPackageReleaseManifest(manifest, latestRelease.releaseNotes)
        .status === "blocked"
    )
      return null;
    piPackage = projectPiPackageSummary(manifest.package);
  } else if (listing.kind === "mcp" || listing.kind === "toolkit") {
    const manifest = parseResourceMarketManifest(
      latestRelease.manifest,
      latestRelease.checksum,
    );
    if (
      scanMarketArtifact(manifest, latestRelease.releaseNotes).status ===
      "blocked"
    )
      return null;
    publicManifest = projectPublicResourceMarketManifest(manifest);
  }
  const publicListing = {
    ...listing,
    metadata:
      listing.kind === "pi-package" && piPackage
        ? { name: piPackage.name, version: piPackage.version }
        : listing.metadata,
    piPackage,
    latestRelease:
      listing.kind === "pi-package"
        ? { ...latestRelease, manifest: null }
        : latestRelease,
  };
  if (!publicManifest) return publicListing;
  return {
    ...publicListing,
    latestRelease: {
      ...publicListing.latestRelease,
      manifest: publicManifest,
      checksum: marketReleaseChecksum(publicManifest),
    },
  };
}
