import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from './pagination';

export const REVIEW_KINDS = ['agent', 'skill', 'mcp', 'toolkit', 'assistant'] as const;
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

type ReviewRow = {
  id: string; listingId: string; source: 'agent' | 'market'; kind: string; name: string; slug: string;
  version: number; reviewStatus: string; submittedAt: Date; reviewedAt: Date | null;
  reviewNote: string | null; reviewer: string | null; publisher: string | null;
};

export async function listAdminReviews({ q = '', kind = '', status = 'pending', page = 1 }: {
  q?: string; kind?: string; status?: string; page?: number;
}) {
  const reviewStatus = REVIEW_STATUSES.find((value) => value === status) ?? 'pending';
  const reviewKind = REVIEW_KINDS.find((value) => value === kind);
  const term = q.trim().slice(0, 200);
  // Union in Postgres keeps pagination bounded across both release stores.
  const releases = Prisma.sql`
    SELECT r.id, r."listingId", 'market' AS source, l.kind, l.name, l.slug, r.version, r."reviewStatus",
      r."createdAt" AS "submittedAt", r."reviewedAt", r."reviewNote", coalesce(u.name, u.email) AS reviewer,
      coalesce(w.name, p.name, p.email, l."publisherKind") AS publisher
    FROM "MarketRelease" r JOIN "MarketListing" l ON l.id = r."listingId"
    LEFT JOIN "User" u ON u.id = r."reviewedById" LEFT JOIN "User" p ON p.id = l."publishedById"
    LEFT JOIN "Workspace" w ON w.id = l."publisherWorkspaceId"
    WHERE (r."reviewStatus" <> 'pending' OR l."pendingReleaseId" = r.id)
    UNION ALL
    SELECT r.id, r."listingId", 'agent' AS source, 'agent' AS kind, l.name, l."directorySlug" AS slug,
      r.version, r."reviewStatus", r."publishedAt" AS "submittedAt", r."reviewedAt", r."reviewNote",
      coalesce(u.name, u.email) AS reviewer, coalesce(w.name, p.name, p.email, l."publisherKind") AS publisher
    FROM "AgentRelease" r JOIN "AgentListing" l ON l.id = r."listingId"
    LEFT JOIN "User" u ON u.id = r."reviewedById" LEFT JOIN "User" p ON p.id = l."publishedById"
    LEFT JOIN "Workspace" w ON w.id = l."publisherWorkspaceId"
    WHERE (r."reviewStatus" <> 'pending' OR l."pendingReleaseId" = r.id)`;
  const where = Prisma.sql`"reviewStatus" = ${reviewStatus}
    ${reviewKind ? Prisma.sql`AND kind = ${reviewKind}` : Prisma.empty}
    ${term ? Prisma.sql`AND (name ILIKE ${`%${term}%`} OR slug ILIKE ${`%${term}%`} OR publisher ILIKE ${`%${term}%`})` : Prisma.empty}`;
  const [{ total }] = await db.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM (${releases}) r WHERE ${where}`);
  const pageSize = 25;
  const currentPage = Math.min(normalizeAdminPage(page), Math.max(1, Math.ceil(total / pageSize)));
  const direction = reviewStatus === 'pending' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const items = await db.$queryRaw<ReviewRow[]>(Prisma.sql`SELECT * FROM (${releases}) r WHERE ${where}
    ORDER BY "submittedAt" ${direction}, source, id LIMIT ${pageSize} OFFSET ${(currentPage - 1) * pageSize}`);
  return { items, total, page: currentPage, pageSize, status: reviewStatus, kind: reviewKind ?? '' };
}
