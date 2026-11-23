import { z } from "zod";

export const FEEDBACK_SOURCES = ["system", "user", "model"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export const FEEDBACK_CATEGORIES = [
  "bug",
  "failure",
  "suggestion",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = [
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_TOOL_NAME = "toolplane_feedback" as const;

export const ConversationSnippetItemSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(2000),
    createdAt: z.string().optional(),
  })
  .strict();
export type ConversationSnippetItem = z.infer<
  typeof ConversationSnippetItemSchema
>;

export const SubmitUserFeedbackInputSchema = z
  .object({
    category: z.enum(FEEDBACK_CATEGORIES),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    workspaceId: z.string().trim().min(1).max(128).optional(),
    agentId: z.string().trim().min(1).max(128).optional(),
    conversationId: z.string().trim().min(1).max(128).optional(),
    taskId: z.string().trim().min(1).max(128).optional(),
    workSessionId: z.string().trim().min(1).max(128).optional(),
    failureCode: z.string().trim().min(1).max(128).optional(),
    includeConversationSnippet: z.boolean().optional(),
    snippetMessageCount: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type SubmitUserFeedbackInput = z.infer<
  typeof SubmitUserFeedbackInputSchema
>;

export const ModelFeedbackToolInputSchema = z
  .object({
    category: z.enum(FEEDBACK_CATEGORIES),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type ModelFeedbackToolInput = z.infer<
  typeof ModelFeedbackToolInputSchema
>;

export const UpdateAdminFeedbackInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    status: z.enum(FEEDBACK_STATUSES),
    adminNote: z.string().trim().max(4000).optional().nullable(),
  })
  .strict();
export type UpdateAdminFeedbackInput = z.infer<
  typeof UpdateAdminFeedbackInputSchema
>;

export type FeedbackSummaryItem = {
  id: string;
  source: FeedbackSource;
  category: FeedbackCategory;
  status: FeedbackStatus;
  title: string;
  body: string | null;
  failureCode: string | null;
  failureReason: string | null;
  executionStage: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  platformVersion: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  taskId: string | null;
  workSessionId: string | null;
  submittedByEmail: string | null;
  approvedByEmail: string | null;
  adminNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackOccurrenceItem = {
  id: string;
  sourceKind: string;
  sourceId: string;
  workspaceId: string | null;
  agentId: string | null;
  conversationId: string | null;
  createdAt: string;
};

export type FeedbackDetailItem = FeedbackSummaryItem & {
  fingerprint: string | null;
  conversationSnippet: ConversationSnippetItem[] | null;
  occurrenceRecords: FeedbackOccurrenceItem[];
};
