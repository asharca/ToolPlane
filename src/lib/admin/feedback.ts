import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  feedbackSummaryInclude,
  formatFeedbackDetail,
  formatFeedbackSummary,
} from "@/lib/feedback/service";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackDetailItem,
  type FeedbackSource,
  type FeedbackStatus,
  type FeedbackSummaryItem,
} from "@/lib/feedback/types";

export type AdminFeedbackFilters = {
  source?: string;
  status?: string;
  category?: string;
  workspaceId?: string;
  page?: number;
  pageSize?: number;
};

export async function listAdminFeedback(
  filters?: AdminFeedbackFilters,
): Promise<{
  items: FeedbackSummaryItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where: Prisma.FeedbackWhereInput = {};

  if (
    filters?.source &&
    (FEEDBACK_SOURCES as readonly string[]).includes(filters.source)
  ) {
    where.source = filters.source as FeedbackSource;
  }

  if (
    filters?.status &&
    (FEEDBACK_STATUSES as readonly string[]).includes(filters.status)
  ) {
    where.status = filters.status as FeedbackStatus;
  }

  if (
    filters?.category &&
    (FEEDBACK_CATEGORIES as readonly string[]).includes(filters.category)
  ) {
    where.category = filters.category as FeedbackCategory;
  }

  const workspaceId = filters?.workspaceId?.trim();
  if (workspaceId && workspaceId !== "all") {
    where.workspaceId = workspaceId;
  }

  const rawPage = filters?.page ?? 1;
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const rawPageSize = filters?.pageSize ?? 25;
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(100, Math.max(1, Math.floor(rawPageSize)))
    : 25;

  const [rows, total] = await Promise.all([
    db.feedback.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: feedbackSummaryInclude,
    }),
    db.feedback.count({ where }),
  ]);

  return {
    items: rows.map(formatFeedbackSummary),
    total,
    page,
    pageSize,
  };
}

export async function getAdminFeedbackDetail(
  id: string,
): Promise<FeedbackDetailItem | null> {
  const trimmedId = id.trim();
  if (!trimmedId) return null;

  const row = await db.feedback.findUnique({
    where: { id: trimmedId },
    include: {
      ...feedbackSummaryInclude,
      occurrenceRecords: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });

  if (!row) return null;
  return formatFeedbackDetail(row);
}
