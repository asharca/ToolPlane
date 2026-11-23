import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { redactText } from "@/lib/observability/redaction";
import { readCurrentVersion } from "@/lib/system/release-update";
import {
  resolveWorkspaceScope,
  workspaceAccessWhere,
} from "@/lib/workspace/scope";
import { shouldReportFailureCode } from "./classification";
import {
  ConversationSnippetItemSchema,
  type ConversationSnippetItem,
  type FeedbackCategory,
  type FeedbackDetailItem,
  type FeedbackSource,
  type FeedbackStatus,
  type FeedbackSummaryItem,
  type ModelFeedbackToolInput,
  ModelFeedbackToolInputSchema,
  SubmitUserFeedbackInputSchema,
} from "./types";

const MAX_MODEL_FEEDBACK_PER_CONVERSATION = 5;

export class FeedbackServiceError extends Error {
  readonly status: 400 | 403 | 404 | 429;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 429, code: string, message: string) {
    super(message);
    this.name = "FeedbackServiceError";
    this.status = status;
    this.code = code;
  }
}

export const feedbackSummaryInclude = {
  workspace: {
    select: {
      name: true,
      slug: true,
    },
  },
  agent: {
    select: {
      name: true,
    },
  },
  submittedBy: {
    select: {
      email: true,
    },
  },
  approvedBy: {
    select: {
      email: true,
    },
  },
} satisfies Prisma.FeedbackInclude;

type FeedbackSummaryRow = Prisma.FeedbackGetPayload<{
  include: typeof feedbackSummaryInclude;
}>;

type FeedbackDetailRow = Prisma.FeedbackGetPayload<{
  include: typeof feedbackSummaryInclude & {
    occurrenceRecords: true;
  };
}>;

export function formatFeedbackSummary(
  row: FeedbackSummaryRow,
): FeedbackSummaryItem {
  return {
    id: row.id,
    source: row.source as FeedbackSource,
    category: row.category as FeedbackCategory,
    status: row.status as FeedbackStatus,
    title: row.title,
    body: row.body,
    failureCode: row.failureCode,
    failureReason: row.failureReason,
    executionStage: row.executionStage,
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    platformVersion: row.platformVersion,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace?.name ?? null,
    workspaceSlug: row.workspace?.slug ?? null,
    agentId: row.agentId,
    agentName: row.agent?.name ?? null,
    conversationId: row.conversationId,
    taskId: row.taskId,
    workSessionId: row.workSessionId,
    submittedByEmail: row.submittedBy?.email ?? null,
    approvedByEmail: row.approvedBy?.email ?? null,
    adminNote: row.adminNote,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function formatFeedbackDetail(
  row: FeedbackDetailRow,
): FeedbackDetailItem {
  let conversationSnippet: ConversationSnippetItem[] | null = null;
  if (Array.isArray(row.conversationSnippet)) {
    const parsed = ConversationSnippetItemSchema.array().safeParse(
      row.conversationSnippet,
    );
    if (parsed.success) {
      conversationSnippet = parsed.data;
    }
  }
  return {
    ...formatFeedbackSummary(row),
    fingerprint: row.fingerprint,
    conversationSnippet,
    occurrenceRecords: row.occurrenceRecords.map((occ) => ({
      id: occ.id,
      sourceKind: occ.sourceKind,
      sourceId: occ.sourceId,
      workspaceId: occ.workspaceId,
      agentId: occ.agentId,
      conversationId: occ.conversationId,
      createdAt: occ.createdAt.toISOString(),
    })),
  };
}

async function safeReadPlatformVersion(): Promise<string | null> {
  try {
    return await readCurrentVersion();
  } catch {
    return null;
  }
}

export function computeSystemFailureFingerprint(params: {
  code: string;
  reason?: string | null;
  stage?: string | null;
  runtimeKind?: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.code,
        params.reason ?? "",
        params.stage ?? "",
        params.runtimeKind ?? "",
      ]),
    )
    .digest("hex");
}

function extractMessageText(parts: unknown): string {
  if (typeof parts === "string") return parts.trim();
  if (!Array.isArray(parts)) {
    if (
      parts &&
      typeof parts === "object" &&
      "text" in parts &&
      typeof parts.text === "string"
    ) {
      return parts.text.trim();
    }
    return "";
  }
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if (
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text.trim()];
      }
      if ("text" in part && typeof part.text === "string") {
        return [part.text.trim()];
      }
      if (
        "type" in part &&
        part.type === "file" &&
        "filename" in part &&
        typeof part.filename === "string"
      ) {
        return [`[File: ${part.filename.trim().slice(0, 240)}]`];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

export async function recordSystemFailureFeedback(
  tx: Prisma.TransactionClient,
  params: {
    code: string;
    reason?: string | null;
    stage?: string | null;
    runtimeKind?: string | null;
    sourceKind: "work" | "a2a_task";
    sourceId: string;
    workspaceId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
    taskId?: string | null;
    workSessionId?: string | null;
  },
) {
  if (!shouldReportFailureCode(params.code)) {
    return null;
  }

  const fingerprint = computeSystemFailureFingerprint(params);
  const platformVersion = await safeReadPlatformVersion();
  const now = new Date();

  const existing = await tx.feedback.findUnique({
    where: { fingerprint },
    select: { id: true, status: true },
  });

  const reopen = existing?.status === "resolved";
  const feedback = await tx.feedback.upsert({
    where: { fingerprint },
    create: {
      source: "system",
      category: "failure",
      status: "open",
      title: params.code.slice(0, 200),
      body: null,
      failureCode: params.code,
      failureReason: params.reason ?? null,
      executionStage: params.stage ?? null,
      fingerprint,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      platformVersion,
      workspaceId: params.workspaceId ?? null,
      agentId: params.agentId ?? null,
      conversationId: params.conversationId ?? null,
      taskId: params.taskId ?? null,
      workSessionId: params.workSessionId ?? null,
    },
    update: {
      occurrences: { increment: 1 },
      lastSeenAt: now,
      platformVersion,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.conversationId
        ? { conversationId: params.conversationId }
        : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.workSessionId ? { workSessionId: params.workSessionId } : {}),
      ...(reopen ? { status: "open", resolvedAt: null } : {}),
    },
  });

  await tx.feedbackOccurrence.upsert({
    where: {
      feedbackId_sourceKind_sourceId: {
        feedbackId: feedback.id,
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
      },
    },
    create: {
      feedbackId: feedback.id,
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
      workspaceId: params.workspaceId ?? null,
      agentId: params.agentId ?? null,
      conversationId: params.conversationId ?? null,
    },
    update: {},
  });

  return feedback;
}

export async function submitUserFeedback(
  userId: string,
  rawInput: unknown,
): Promise<FeedbackSummaryItem> {
  const parsed = SubmitUserFeedbackInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new FeedbackServiceError(
      400,
      "INVALID_FEEDBACK_INPUT",
      "Invalid feedback payload.",
    );
  }
  const input = parsed.data;

  let resolvedWorkspaceId: string | null = null;
  let resolvedAgentId: string | null = input.agentId ?? null;
  let resolvedConversationId: string | null = input.conversationId ?? null;
  const resolvedWorkSessionId: string | null = input.workSessionId ?? null;
  const resolvedTaskId: string | null = input.taskId ?? null;

  if (input.workspaceId) {
    const scope =
      (await resolveWorkspaceScope(
        { id: input.workspaceId },
        userId,
        "read",
      )) ??
      (await resolveWorkspaceScope(
        { slug: input.workspaceId },
        userId,
        "read",
      ));
    if (!scope) {
      throw new FeedbackServiceError(
        403,
        "WORKSPACE_ACCESS_DENIED",
        "Workspace not found or access denied.",
      );
    }
    resolvedWorkspaceId = scope.id;
  }

  if (input.agentId) {
    const agent = await db.agent.findFirst({
      where: {
        id: input.agentId,
        ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
        workspace: workspaceAccessWhere(userId, "read"),
      },
      select: { id: true, workspaceId: true },
    });
    if (!agent) {
      throw new FeedbackServiceError(
        404,
        "AGENT_NOT_FOUND",
        "Agent not found or access denied.",
      );
    }
    resolvedWorkspaceId ??= agent.workspaceId;
    resolvedAgentId = agent.id;
  }

  if (input.conversationId) {
    const conversation = await db.conversation.findFirst({
      where: {
        id: input.conversationId,
        ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        agent: {
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          workspace: workspaceAccessWhere(userId, "read"),
        },
      },
      select: {
        id: true,
        agentId: true,
        agent: { select: { workspaceId: true } },
      },
    });
    if (!conversation) {
      throw new FeedbackServiceError(
        404,
        "CONVERSATION_NOT_FOUND",
        "Conversation not found or access denied.",
      );
    }
    resolvedConversationId = conversation.id;
    resolvedAgentId ??= conversation.agentId;
    resolvedWorkspaceId ??= conversation.agent.workspaceId;
  }

  if (input.workSessionId) {
    const workSession = await db.workSession.findFirst({
      where: {
        id: input.workSessionId,
        ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
        ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        ...(resolvedConversationId
          ? { conversationId: resolvedConversationId }
          : {}),
        workspace: workspaceAccessWhere(userId, "read"),
      },
      select: {
        id: true,
        workspaceId: true,
        agentId: true,
        conversationId: true,
      },
    });
    if (!workSession) {
      throw new FeedbackServiceError(
        404,
        "WORK_SESSION_NOT_FOUND",
        "Work session not found or access denied.",
      );
    }
    resolvedWorkspaceId ??= workSession.workspaceId;
    resolvedAgentId ??= workSession.agentId;
    resolvedConversationId ??= workSession.conversationId;
  }

  if (input.taskId) {
    const task = await db.a2ATask.findFirst({
      where: {
        id: input.taskId,
        context: {
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
          workspace: workspaceAccessWhere(userId, "read"),
        },
      },
      select: {
        id: true,
        context: {
          select: {
            workspaceId: true,
            agentId: true,
          },
        },
      },
    });
    if (!task) {
      throw new FeedbackServiceError(
        404,
        "TASK_NOT_FOUND",
        "Task not found or access denied.",
      );
    }
    resolvedWorkspaceId ??= task.context.workspaceId;
    resolvedAgentId ??= task.context.agentId;
  }

  let conversationSnippet: ConversationSnippetItem[] | undefined;
  if (input.includeConversationSnippet && resolvedConversationId) {
    const take = Math.min(Math.max(input.snippetMessageCount ?? 6, 1), 10);
    const messages = await db.message.findMany({
      where: {
        conversationId: resolvedConversationId,
        role: { in: ["user", "assistant"] },
        supersededAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
      take,
      select: {
        role: true,
        parts: true,
        createdAt: true,
      },
    });
    conversationSnippet = messages.reverse().map((msg) => ({
      role:
        msg.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: redactText(extractMessageText(msg.parts)).slice(0, 2000),
      createdAt: msg.createdAt.toISOString(),
    }));
  }

  const redactedTitle =
    redactText(input.title).trim().slice(0, 200) || "Feedback";
  const redactedBody = redactText(input.body).trim().slice(0, 4000);
  const platformVersion = await safeReadPlatformVersion();

  const created = await db.feedback.create({
    data: {
      source: "user",
      category: input.category,
      status: "open",
      title: redactedTitle,
      body: redactedBody,
      failureCode: input.failureCode ?? null,
      platformVersion,
      ...(conversationSnippet
        ? {
            conversationSnippet:
              conversationSnippet as unknown as Prisma.InputJsonValue,
          }
        : {}),
      workspaceId: resolvedWorkspaceId,
      agentId: resolvedAgentId,
      conversationId: resolvedConversationId,
      taskId: resolvedTaskId,
      workSessionId: resolvedWorkSessionId,
      submittedById: userId,
    },
    include: feedbackSummaryInclude,
  });

  return formatFeedbackSummary(created);
}

export async function submitModelFeedback(params: {
  workspaceId: string;
  agentId: string;
  conversationId?: string | null;
  taskId?: string | null;
  approvedById?: string | null;
  input: ModelFeedbackToolInput;
}): Promise<{ id: string; status: string }> {
  const parsed = ModelFeedbackToolInputSchema.parse(params.input);

  if (params.conversationId) {
    const existingCount = await db.feedback.count({
      where: {
        source: "model",
        conversationId: params.conversationId,
      },
    });
    if (existingCount >= MAX_MODEL_FEEDBACK_PER_CONVERSATION) {
      throw new FeedbackServiceError(
        429,
        "MODEL_FEEDBACK_LIMIT_EXCEEDED",
        "Maximum model feedback submissions (5) reached for this conversation.",
      );
    }
  }

  let validApprovedById: string | null = null;
  if (params.approvedById) {
    const approver = await db.user.findUnique({
      where: { id: params.approvedById },
      select: { id: true },
    });
    validApprovedById = approver?.id ?? null;
  }

  const redactedTitle =
    redactText(parsed.title).trim().slice(0, 200) || "Feedback";
  const redactedBody = redactText(parsed.body).trim().slice(0, 4000);
  const platformVersion = await safeReadPlatformVersion();

  const created = await db.feedback.create({
    data: {
      source: "model",
      category: parsed.category,
      status: "open",
      title: redactedTitle,
      body: redactedBody,
      platformVersion,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      conversationId: params.conversationId ?? null,
      taskId: params.taskId ?? null,
      submittedById: null,
      approvedById: validApprovedById,
    },
    select: {
      id: true,
      status: true,
    },
  });

  return created;
}

export async function listUserFeedback(
  userId: string,
): Promise<FeedbackSummaryItem[]> {
  const rows = await db.feedback.findMany({
    where: {
      OR: [{ submittedById: userId }, { approvedById: userId }],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: feedbackSummaryInclude,
  });

  return rows.map(formatFeedbackSummary);
}
