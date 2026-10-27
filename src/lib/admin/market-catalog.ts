import "server-only";
import { writeAudit } from "@/lib/observability/audit";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { parseAssistantReleaseManifest } from "@/lib/market/assistant-manifest";
import { hasVerifiedMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";

const PAGE_SIZE = 25;
export const ADMIN_MARKET_LISTING_STATUSES = [
  "draft",
  "published",
  "disabled",
] as const;
export type AdminMarketListingStatus =
  (typeof ADMIN_MARKET_LISTING_STATUSES)[number];

export class AdminMarketCatalogError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_categories"
      | "invalid_status"
      | "release_required"
      | "invalid_config"
      | "invalid_manifest"
      | "slug_conflict",
  ) {
    super(code);
    this.name = "AdminMarketCatalogError";
  }
}

export async function listAdminMarketListings({
  page = 1,
  q = "",
  kind,
}: {
  page?: number;
  q?: string;
  kind?: string;
} = {}) {
  const currentPage = normalizeAdminPage(page);
  const term = q.trim().slice(0, 200);
  const where: Prisma.MarketListingWhereInput = {
    ...(kind ? { kind } : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } },
            { namespace: { contains: term, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.marketListing.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        kind: true,
        publisherKind: true,
        namespace: true,
        slug: true,
        name: true,
        status: true,
        curated: true,
        isFeatured: true,
        latestVersion: true,
        installCount: true,
        categories: { select: { id: true }, orderBy: { name: "asc" } },
        latestRelease: { select: { reviewStatus: true } },
        pendingRelease: { select: { version: true, reviewStatus: true } },
      },
    }),
    db.marketListing.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export async function listAdminPublicToolkits({
  page = 1,
  q = "",
}: {
  page?: number;
  q?: string;
} = {}) {
  const currentPage = normalizeAdminPage(page);
  const term = q.trim().slice(0, 200);
  const where: Prisma.ToolkitWhereInput = {
    visibility: "public",
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } },
            { workspace: { name: { contains: term, mode: "insensitive" } } },
            { workspace: { slug: { contains: term, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.toolkit.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        enabled: true,
        categories: { select: { id: true }, orderBy: { name: "asc" } },
        workspace: { select: { name: true, slug: true } },
        _count: { select: { servers: true, skills: true } },
      },
    }),
    db.toolkit.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

async function assertCategories(
  tx: Prisma.TransactionClient,
  categoryIds: string[],
) {
  const uniqueIds = [...new Set(categoryIds)];
  if (uniqueIds.length !== categoryIds.length)
    throw new AdminMarketCatalogError("invalid_categories");
  const count = await tx.category.count({ where: { id: { in: uniqueIds } } });
  if (count !== uniqueIds.length)
    throw new AdminMarketCatalogError("invalid_categories");
  return uniqueIds;
}

export async function getAdminAssistantTemplate(id: string) {
  const listing = await db.marketListing.findFirst({
    where: { id, kind: "assistant", publisherKind: "platform" },
    include: {
      categories: { select: { id: true } },
      latestRelease: { select: { manifest: true, checksum: true } },
    },
  });
  if (!listing?.latestRelease) return null;
  const manifest = parseAssistantReleaseManifest(
    listing.latestRelease.manifest,
    listing.latestRelease.checksum,
  );
  const serverSlugs = manifest.assistant.mcpRequirements.map(
    ({ catalogSlug }) => catalogSlug,
  );
  const servers = serverSlugs.length
    ? await db.server.findMany({
        where: { slug: { in: serverSlugs }, verifiedAt: { not: null } },
        select: { id: true },
      })
    : [];
  return {
    listing,
    manifest,
    serverIds: servers.map(({ id: serverId }) => serverId),
  };
}

export async function deleteAdminAssistantTemplate(
  id: string,
  actorId = "system",
) {
  await db.$transaction(async (tx) => {
    const deleted = await tx.marketListing.deleteMany({
      where: { id, kind: "assistant", publisherKind: "platform" },
    });
    if (deleted.count !== 1) throw new AdminMarketCatalogError("not_found");
    await writeAudit(tx, {
      actorId,
      action: "market.assistant.deleted",
      targetType: "marketListing",
      targetId: id,
    });
  });
}

export async function updateAdminMarketListing(
  input: {
    id: string;
    status: AdminMarketListingStatus;
    curated: boolean;
    isFeatured: boolean;
    categoryIds: string[];
  },
  actorId = "system",
) {
  if (!ADMIN_MARKET_LISTING_STATUSES.includes(input.status)) {
    throw new AdminMarketCatalogError("invalid_status");
  }
  return db.$transaction(async (tx) => {
    const listing = await tx.marketListing.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        kind: true,
        status: true,
        curated: true,
        isFeatured: true,
        categories: { select: { id: true } },
        sourceServerId: true,
        sourceToolkitId: true,
        sourceServer: {
          select: { verifiedAt: true, verifiedTools: true, installCfg: true },
        },
        latestRelease: { select: { reviewStatus: true } },
      },
    });
    if (!listing) throw new AdminMarketCatalogError("not_found");
    if (listing.kind === "toolkit")
      throw new AdminMarketCatalogError("invalid_config");
    if (input.status === "published" && listing.status !== "published") {
      throw new AdminMarketCatalogError("invalid_status");
    }
    if (
      input.status === "published" &&
      listing.latestRelease?.reviewStatus !== "approved"
    ) {
      throw new AdminMarketCatalogError("release_required");
    }
    if (
      input.status === "published" &&
      listing.kind === "mcp" &&
      listing.sourceServerId !== null &&
      !hasVerifiedMcpToolCatalog(listing.sourceServer)
    ) {
      throw new AdminMarketCatalogError("invalid_config");
    }
    const categoryIds = await assertCategories(tx, input.categoryIds);
    const updated = await tx.marketListing.update({
      where: { id: listing.id },
      data: {
        status: input.status,
        curated: input.curated,
        isFeatured: input.isFeatured,
        categories: { set: categoryIds.map((id) => ({ id })) },
      },
    });
    if (listing.kind === "mcp" && listing.sourceServerId) {
      await tx.server.update({
        where: { id: listing.sourceServerId },
        data: {
          categories: { set: categoryIds.map((id) => ({ id })) },
        },
      });
    }
    await writeAudit(tx, {
      actorId,
      action: "market.listing.updated",
      targetType: "marketListing",
      targetId: input.id,
      changes: {
        before: {
          status: listing.status,
          curated: listing.curated,
          isFeatured: listing.isFeatured,
          categoryIds: listing.categories.map(({ id }) => id),
        },
        after: input,
      },
    });
    return updated;
  });
}
