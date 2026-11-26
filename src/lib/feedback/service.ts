import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseRuntimeFailure } from "@/lib/agents/runtime-failure";
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
  type FeedbackDiagnosticContext,
  type FeedbackDiagnosticLogItem,
  FeedbackDiagnosticLogItemSchema,
  FeedbackScreenshotDataUrlSchema,
  type FeedbackSource,
  type FeedbackStatus,
  type FeedbackSummaryItem,
  type ModelFeedbackToolInput,
  ModelFeedbackToolInputSchema,
  SubmitUserFeedbackInputSchema,
} from "./types";

const MAX_MODEL_FEEDBACK_PER_CONVERSATION = 5;
const MAX_DIAGNOSTIC_LOG_ITEMS = 12;

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

function parseFeedbackAttachments(raw: unknown): {
  conversationSnippet: ConversationSnippetItem[] | null;
  screenshotDataUrl: string | null;
  diagnosticLogs: FeedbackDiagnosticLogItem[] | null;
} {
  if (Array.isArray(raw)) {
    const parsed = ConversationSnippetItemSchema.array().safeParse(raw);
    return {
      conversationSnippet: parsed.success ? parsed.data : null,
      screenshotDataUrl: null,
      diagnosticLogs: null,
    };
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const messagesParsed = Array.isArray(record.messages)
      ? ConversationSnippetItemSchema.array().safeParse(record.messages)
      : null;
    const screenshotParsed =
      typeof record.screenshotDataUrl === "string"
        ? FeedbackScreenshotDataUrlSchema.safeParse(record.screenshotDataUrl)
        : null;
    const logsParsed = Array.isArray(record.diagnosticLogs)
      ? FeedbackDiagnosticLogItemSchema.array().safeParse(record.diagnosticLogs)
      : null;
    return {
      conversationSnippet: messagesParsed?.success ? messagesParsed.data : null,
      screenshotDataUrl: screenshotParsed?.success
        ? screenshotParsed.data
        : null,
      diagnosticLogs: logsParsed?.success ? logsParsed.data : null,
    };
  }
  return {
    conversationSnippet: null,
    screenshotDataUrl: null,
    diagnosticLogs: null,
  };
}

function serializeFeedbackAttachments(params: {
  messages?: ConversationSnippetItem[];
  screenshotDataUrl?: string | null;
  diagnosticLogs?: FeedbackDiagnosticLogItem[];
}): Prisma.InputJsonValue | undefined {
  const hasMessages = Boolean(params.messages?.length);
  const hasScreenshot = Boolean(params.screenshotDataUrl);
  const hasLogs = Boolean(params.diagnosticLogs?.length);
  if (!hasMessages && !hasScreenshot && !hasLogs) return undefined;
  if (hasMessages && !hasScreenshot && !hasLogs) {
    return params.messages as unknown as Prisma.InputJsonValue;
  }
  return {
    ...(hasMessages ? { messages: params.messages } : {}),
    ...(hasScreenshot ? { screenshotDataUrl: params.screenshotDataUrl } : {}),
    ...(hasLogs ? { diagnosticLogs: params.diagnosticLogs } : {}),
  } as unknown as Prisma.InputJsonValue;
}

export function formatFeedbackSummary(
  row: FeedbackSummaryRow,
): FeedbackSummaryItem {
  const attachments = parseFeedbackAttachments(row.conversationSnippet);
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
    screenshotDataUrl: attachments.screenshotDataUrl,
    diagnosticLogs: attachments.diagnosticLogs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function formatFeedbackDetail(
  row: FeedbackDetailRow,
): FeedbackDetailItem {
  const attachments = parseFeedbackAttachments(row.conversationSnippet);
  return {
    ...formatFeedbackSummary(row),
    fingerprint: row.fingerprint,
    conversationSnippet: attachments.conversationSnippet,
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

function extractPartDiagnosticLogs(
  parts: unknown,
  occurredAt: string,
): FeedbackDiagnosticLogItem[] {
  if (!Array.isArray(parts)) return [];
  const items: FeedbackDiagnosticLogItem[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (
      type === "data-work-runtime" &&
      record.data &&
      typeof record.data === "object"
    ) {
      const data = record.data as Record<string, unknown>;
      if (data.status === "failed") {
        const text = typeof data.text === "string" ? data.text.trim() : "";
        const parsed = parseRuntimeFailure(text);
        if (text || parsed) {
          items.push({
            occurredAt,
            level: "error",
            source: "work-runtime",
            code: parsed?.code ?? null,
            message: redactText(text || parsed?.code || "Runtime failed").slice(
              0,
              2000,
            ),
          });
        }
      }
    } else if (type.startsWith("tool-") && record.state === "output-error") {
      const toolName = type.slice("tool-".length) || "tool";
      const errorText =
        typeof record.errorText === "string" ? record.errorText.trim() : "";
      items.push({
        occurredAt,
        level: "error",
        source: `tool:${toolName.slice(0, 80)}`,
        message: redactText(errorText || `${toolName} failed`).slice(0, 2000),
      });
    }
  }
  return items;
}

function extractTaskFailureInfo(
  snapshot: unknown,
  uiProjection: unknown,
): {
  code: string | null;
  reason: string | null;
  stage: string | null;
} {
  const stage =
    uiProjection &&
    typeof uiProjection === "object" &&
    "executionStage" in uiProjection &&
    typeof uiProjection.executionStage === "string"
      ? uiProjection.executionStage
      : null;
  if (!snapshot || typeof snapshot !== "object") {
    return { code: null, reason: null, stage };
  }
  const status = (snapshot as { status?: unknown }).status;
  if (!status || typeof status !== "object") {
    return { code: null, reason: null, stage };
  }
  const message = (status as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return { code: null, reason: null, stage };
  }
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return { code: null, reason: null, stage };
  }
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const text =
      "text" in part && typeof part.text === "string"
        ? part.text
        : "content" in part &&
            part.content &&
            typeof part.content === "object" &&
            "value" in part.content &&
            typeof part.content.value === "string"
          ? part.content.value
          : null;
    if (!text) continue;
    const parsed = parseRuntimeFailure(text);
    if (parsed) {
      return {
        code: parsed.code,
        reason: parsed.reason ?? null,
        stage,
      };
    }
  }
  return { code: null, reason: null, stage };
}

type FeedbackTargetInput = {
  workspaceId?: string;
  agentId?: string;
  conversationId?: string;
  taskId?: string;
  workSessionId?: string;
  failureCode?: string;
};

async function resolveFeedbackTargets(
  userId: string,
  input: FeedbackTargetInput,
) {
  let resolvedWorkspaceId: string | null = null;
  let resolvedAgentId: string | null = input.agentId ?? null;
  let resolvedAgentName: string | null = null;
  let resolvedConversationId: string | null = input.conversationId ?? null;
  let resolvedWorkSessionId: string | null = input.workSessionId ?? null;
  let resolvedTaskId: string | null = input.taskId ?? null;
  let resolvedFailureCode: string | null = input.failureCode ?? null;
  let resolvedFailureReason: string | null = null;
  let resolvedExecutionStage: string | null = null;

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
      select: { id: true, name: true, workspaceId: true },
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
    resolvedAgentName = agent.name;
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
        agent: { select: { name: true, workspaceId: true } },
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
    resolvedAgentName ??= conversation.agent.name;
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
        error: true,
        agent: { select: { name: true } },
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
    resolvedAgentName ??= workSession.agent.name;
    resolvedConversationId ??= workSession.conversationId;
    resolvedWorkSessionId = workSession.id;
    if (!resolvedFailureCode && workSession.error) {
      resolvedFailureCode = workSession.error;
    }
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
        snapshot: true,
        uiProjection: true,
        context: {
          select: {
            workspaceId: true,
            agentId: true,
            agent: { select: { name: true } },
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
    resolvedAgentName ??= task.context.agent?.name ?? null;
    resolvedTaskId = task.id;
    const taskInfo = extractTaskFailureInfo(task.snapshot, task.uiProjection);
    resolvedFailureCode ??= taskInfo.code;
    resolvedFailureReason ??= taskInfo.reason;
    resolvedExecutionStage ??= taskInfo.stage;
  } else if (resolvedWorkSessionId || resolvedConversationId) {
    const sourceIds = [
      ...(resolvedWorkSessionId ? [resolvedWorkSessionId] : []),
      ...(resolvedConversationId ? [resolvedConversationId] : []),
    ];
    const binding = await db.a2AEntryBinding.findFirst({
      where: {
        sourceId: { in: sourceIds },
        context: {
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          workspace: workspaceAccessWhere(userId, "read"),
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        lastTaskId: true,
        lastTask: {
          select: {
            id: true,
            snapshot: true,
            uiProjection: true,
          },
        },
      },
    });
    if (binding?.lastTask) {
      resolvedTaskId ??= binding.lastTask.id;
      const taskInfo = extractTaskFailureInfo(
        binding.lastTask.snapshot,
        binding.lastTask.uiProjection,
      );
      resolvedFailureCode ??= taskInfo.code;
      resolvedFailureReason ??= taskInfo.reason;
      resolvedExecutionStage ??= taskInfo.stage;
    }
  }

  return {
    resolvedWorkspaceId,
    resolvedAgentId,
    resolvedAgentName,
    resolvedConversationId,
    resolvedWorkSessionId,
    resolvedTaskId,
    resolvedFailureCode,
    resolvedFailureReason,
    resolvedExecutionStage,
  };
}

async function gatherDiagnostics(params: {
  workspaceId: string | null;
  agentId: string | null;
  conversationId: string | null;
  workSessionId: string | null;
  taskId: string | null;
  failureCode: string | null;
  failureReason: string | null;
  executionStage: string | null;
  snippetTake: number;
}): Promise<{
  diagnosticLogs: FeedbackDiagnosticLogItem[];
  conversationSnippet: ConversationSnippetItem[];
}> {
  const diagnosticLogs: FeedbackDiagnosticLogItem[] = [];
  let conversationSnippet: ConversationSnippetItem[] = [];

  if (params.failureCode) {
    diagnosticLogs.push({
      level: "error",
      source: "runtime",
      code: params.failureCode,
      stage: params.executionStage,
      message: redactText(
        params.failureReason
          ? `${params.failureCode}: ${params.failureReason}`
          : params.failureCode,
      ).slice(0, 2000),
    });
  }

  if (params.conversationId) {
    const messages = await db.message.findMany({
      where: {
        conversationId: params.conversationId,
        role: { in: ["user", "assistant"] },
        supersededAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { sequence: "desc" }],
      take: params.snippetTake,
      select: {
        role: true,
        parts: true,
        createdAt: true,
      },
    });
    const ordered = [...messages].reverse();
    conversationSnippet = ordered.map((msg) => ({
      role:
        msg.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: redactText(extractMessageText(msg.parts)).slice(0, 2000),
      createdAt: msg.createdAt.toISOString(),
    }));
    for (const msg of ordered) {
      diagnosticLogs.push(
        ...extractPartDiagnosticLogs(msg.parts, msg.createdAt.toISOString()),
      );
    }
  }

  const scopeFilters: Prisma.LogEventWhereInput[] = [];
  if (params.taskId) scopeFilters.push({ taskId: params.taskId });
  if (params.workSessionId) scopeFilters.push({ runId: params.workSessionId });
  if (params.conversationId) {
    scopeFilters.push({ conversationId: params.conversationId });
  }
  if (!scopeFilters.length && params.agentId) {
    scopeFilters.push({ agentId: params.agentId });
  }

  if (params.workspaceId && scopeFilters.length > 0) {
    const events = await db.logEvent.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: scopeFilters,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 24,
      select: {
        occurredAt: true,
        level: true,
        domain: true,
        eventName: true,
        message: true,
        outcome: true,
        errorType: true,
        errorCode: true,
        toolName: true,
      },
    });

    const prioritized = [
      ...events.filter(
        (ev) =>
          ev.level === "error" ||
          ev.level === "warn" ||
          ev.outcome === "error" ||
          Boolean(ev.errorCode),
      ),
      ...events.filter(
        (ev) =>
          ev.level !== "error" &&
          ev.level !== "warn" &&
          ev.outcome !== "error" &&
          !ev.errorCode &&
          (ev.domain === "runtime" ||
            ev.domain === "a2a" ||
            ev.domain === "mcp" ||
            ev.domain === "work"),
      ),
    ];

    for (const ev of prioritized) {
      if (diagnosticLogs.length >= MAX_DIAGNOSTIC_LOG_ITEMS) break;
      const summaryParts = [
        ev.toolName ? `tool=${ev.toolName}` : null,
        ev.errorType ? `type=${ev.errorType}` : null,
        ev.message && ev.message !== ev.eventName ? ev.message : null,
      ].filter(Boolean);
      const level =
        ev.level === "error" || ev.outcome === "error"
          ? "error"
          : ev.level === "warn"
            ? "warn"
            : "info";
      diagnosticLogs.push({
        occurredAt: ev.occurredAt.toISOString(),
        level,
        source: `${ev.domain}:${ev.eventName}`.slice(0, 120),
        code: ev.errorCode ?? null,
        message: redactText(
          summaryParts.length ? summaryParts.join(" · ") : ev.eventName,
        ).slice(0, 2000),
      });
    }
  }

  return {
    diagnosticLogs: diagnosticLogs.slice(0, MAX_DIAGNOSTIC_LOG_ITEMS),
    conversationSnippet,
  };
}

export async function collectFeedbackDiagnosticContext(
  userId: string,
  input: FeedbackTargetInput,
): Promise<FeedbackDiagnosticContext> {
  const targets = await resolveFeedbackTargets(userId, input);
  const { diagnosticLogs, conversationSnippet } = await gatherDiagnostics({
    workspaceId: targets.resolvedWorkspaceId,
    agentId: targets.resolvedAgentId,
    conversationId: targets.resolvedConversationId,
    workSessionId: targets.resolvedWorkSessionId,
    taskId: targets.resolvedTaskId,
    failureCode: targets.resolvedFailureCode,
    failureReason: targets.resolvedFailureReason,
    executionStage: targets.resolvedExecutionStage,
    snippetTake: 6,
  });

  return {
    failureCode: targets.resolvedFailureCode,
    failureReason: targets.resolvedFailureReason,
    executionStage: targets.resolvedExecutionStage,
    agentId: targets.resolvedAgentId,
    agentName: targets.resolvedAgentName,
    conversationId: targets.resolvedConversationId,
    workSessionId: targets.resolvedWorkSessionId,
    taskId: targets.resolvedTaskId,
    diagnosticLogs,
    conversationSnippet,
  };
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
  const targets = await resolveFeedbackTargets(userId, input);

  const shouldCollectLogs = input.includeDiagnosticLogs !== false;
  const snippetTake = Math.min(Math.max(input.snippetMessageCount ?? 6, 1), 10);
  const { diagnosticLogs: collectedLogs, conversationSnippet } =
    shouldCollectLogs ||
    (input.includeConversationSnippet && targets.resolvedConversationId)
      ? await gatherDiagnostics({
          workspaceId: targets.resolvedWorkspaceId,
          agentId: targets.resolvedAgentId,
          conversationId: targets.resolvedConversationId,
          workSessionId: targets.resolvedWorkSessionId,
          taskId: targets.resolvedTaskId,
          failureCode: targets.resolvedFailureCode,
          failureReason: targets.resolvedFailureReason,
          executionStage: targets.resolvedExecutionStage,
          snippetTake,
        })
      : { diagnosticLogs: [], conversationSnippet: [] };

  const diagnosticLogs = shouldCollectLogs ? [...collectedLogs] : [];
  if (shouldCollectLogs && input.clientErrorText) {
    const cleanClientError = redactText(input.clientErrorText).trim();
    if (
      cleanClientError &&
      !diagnosticLogs.some((entry) => entry.message === cleanClientError)
    ) {
      diagnosticLogs.unshift({
        level: "error",
        source: "ui",
        code: targets.resolvedFailureCode,
        stage: targets.resolvedExecutionStage,
        message: cleanClientError.slice(0, 2000),
      });
    }
  }

  const storedAttachments = serializeFeedbackAttachments({
    messages:
      input.includeConversationSnippet && targets.resolvedConversationId
        ? conversationSnippet
        : undefined,
    screenshotDataUrl: input.screenshotDataUrl ?? null,
    diagnosticLogs: diagnosticLogs.slice(0, MAX_DIAGNOSTIC_LOG_ITEMS),
  });

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
      failureCode: targets.resolvedFailureCode,
      failureReason: targets.resolvedFailureReason,
      executionStage: targets.resolvedExecutionStage,
      platformVersion,
      ...(storedAttachments ? { conversationSnippet: storedAttachments } : {}),
      workspaceId: targets.resolvedWorkspaceId,
      agentId: targets.resolvedAgentId,
      conversationId: targets.resolvedConversationId,
      taskId: targets.resolvedTaskId,
      workSessionId: targets.resolvedWorkSessionId,
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
