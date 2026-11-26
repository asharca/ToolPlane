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

export const FeedbackDiagnosticLogItemSchema = z
  .object({
    occurredAt: z.string().optional(),
    level: z.enum(["info", "warn", "error"]).default("error"),
    source: z.string().max(120),
    code: z.string().max(120).optional().nullable(),
    stage: z.string().max(120).optional().nullable(),
    message: z.string().max(2000),
  })
  .strict();
export type FeedbackDiagnosticLogItem = z.infer<
  typeof FeedbackDiagnosticLogItemSchema
>;

export const FeedbackScreenshotDataUrlSchema = z
  .string()
  .max(600_000)
  .regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,
    "Invalid screenshot data URL",
  );

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
    screenshotDataUrl: FeedbackScreenshotDataUrlSchema.optional(),
    includeDiagnosticLogs: z.boolean().optional(),
    clientErrorText: z.string().trim().max(2000).optional(),
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
  screenshotDataUrl: string | null;
  diagnosticLogs: FeedbackDiagnosticLogItem[] | null;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackDiagnosticContext = {
  failureCode: string | null;
  failureReason: string | null;
  executionStage: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  workSessionId: string | null;
  taskId: string | null;
  diagnosticLogs: FeedbackDiagnosticLogItem[];
  conversationSnippet: ConversationSnippetItem[];
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
