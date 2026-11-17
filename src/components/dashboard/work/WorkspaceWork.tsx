"use client";
import { SidebarToolbar } from "@/components/dashboard/SidebarToolbar";
import { useSidebarScroll } from "@/components/dashboard/useSidebarScroll";
import { notify } from "@/components/dashboard/Toaster";
import { ModelProviderNotice } from "@/components/dashboard/ModelProviderNotice";
import { AgentMessageFeedback } from "@/components/dashboard/agents/AgentMessageFeedback";

import { Button } from "@/components/motion/button";

import { unstable_rethrow, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslations } from "next-intl";

import {
  Bot,
  CircleAlert,
  Boxes,
  Circle,
  Clock3,
  Minimize2,
  FileText,
  FileOutput,
  Folder,
  MessageSquarePlus,
  Monitor,
  Pin,
  PanelLeft,
  TerminalSquare,
  GitBranch,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { Tooltip } from "@/components/motion/tooltip";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMove,
} from "@/components/agents/ai-sidebar";
import {
  ChatApp,
  ChatAppSidebarTrigger,
} from "@/components/dashboard/chat/ChatApp";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarInset,
  AnimatedSidebarRail,
} from "@/components/motion/animated-sidebar";
import { AgentConversation } from "@/components/dashboard/agents/AgentConversation";
import {
  RevisionUpgradeNotice,
  McpToolsUpdatedNote,
} from "@/components/dashboard/RevisionUpgradeNotice";
import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import type { BudgetWarning } from "@/lib/agents/budget-warning";
import { AgentPromptProvenance } from "@/components/dashboard/agents/AgentPromptProvenance";
import {
  ConversationContextUsage,
  ConversationComposer,
  conversationComposerDockClassName,
} from "@/components/dashboard/ConversationComposer";
import { WorkComposer } from "./WorkComposer";
import { ConversationExecution } from "./ConversationExecution";
import { useLiveTaskOutput } from "./useLiveTaskOutput";
import { LiveOutputStatus, LiveOutputView } from "./LiveOutputView";
import {
  AgentMessageQueueView,
  useAgentMessageQueue,
  type QueueMode,
} from "@/components/dashboard/AgentMessageQueue";
import type { AgentMessageQueue } from "@/lib/agents/execution/message-queue";
import {
  A2AContextView,
  useA2AContexts,
  a2aStateKey,
  type A2AContextSummary,
} from "./A2AContextView";
import { createWorkCompletionTransition } from "./completion-transition";
import { WorkTurnTrace } from "./WorkTurnTrace";
import { useWorkCompletionNotification } from "./useWorkCompletionNotification";
import {
  ComposerModelSelect,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/ComposerModelSelect";
import type { ComposerReference } from "@/lib/work/composer-types";
import { interleaveLiveText } from "@/lib/conversation/content-blocks";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { SidebarGroupDialog } from "@/components/dashboard/SidebarGroupDialog";
import { sidebarHoverActionsClassName } from "@/components/dashboard/sidebarHoverActions";
import {
  AssistantMarkdown,
  ConversationMessageShell,
  ConversationBudgetWarnings,
  parseConversationBudgetWarning,
  conversationUserBubbleClassName,
} from "@/components/dashboard/ConversationMessage";
import { WorkContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import { formatContentDuration as formatWorkDuration } from "@/lib/conversation/content-blocks";
import {
  StreamRuleTriggerSchema,
  STREAM_RULE_TRIGGER_PART,
  type StreamRuleTrigger,
} from "@/lib/agents/stream-rules";
import { HookActivitySchema } from "../agents/HookActivity";
import {
  ADVISOR_SUGGESTIONS_PART,
  AdvisorSuggestionsSchema,
} from "@/lib/agents/advisor";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
  MessageGroup,
} from "@/components/agents/message";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { MessageScroller } from "@/components/agents/message-scroller";
import { SandboxConsole } from "@/components/dashboard/sandboxes/SandboxConsole";
import {
  SandboxScreen,
  type SandboxDisplay,
} from "@/components/dashboard/sandboxes/SandboxScreen";
import { resolveContextUsage } from "@/lib/context-usage";
import {
  deleteAgentAction,
  deleteConversationAction,
  pinAgentAction,
} from "@/lib/agents/actions";
import {
  selectionSupportsReasoning,
  type ReasoningEffort,
  type ReasoningLevel,
} from "@/lib/agents/constants";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import {
  SubagentConversationScope,
  type SubagentSource,
} from "../agents/SubagentActivity";
import {
  displayMessagingUserText,
  type ParsedMessagingSession,
} from "@/lib/agents/messaging";
import {
  activeConversationMessages,
  isConversationControl,
  messageCompaction,
} from "@/lib/agents/conversation-context";
import {
  COMMAND_RESULT_PART,
  parseRuntimeCommand,
  sessionRuntimeCommands,
} from "@/lib/agents/runtime-commands";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";

import {
  usePersistentBoolean,
  usePersistentBooleanRecord,
} from "@/lib/use-persistent-boolean";
import {
  workAgentGroupPreferencesCookieName,
  workAgentGroupsCookieName,
  workSidebarCookieName,
} from "@/lib/sidebar-preferences";
import {
  createSidebarGroupId,
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  sortSidebarItems,
  reorderSidebarItems,
  type SidebarGroupPreferences,
} from "@/lib/sidebar-groups";
import { usePersistentSidebarGroups } from "@/lib/use-persistent-sidebar-groups";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
} from "@/components/dashboard/dialog";

type ConversationExportTarget = {
  id: string;
  agentId: string;
  nativeAvailable: boolean;
};
type ConversationExportFormat = "jsonl" | "html" | "md";

const exportErrorKeys = {
  UNAUTHORIZED: "exportUnauthorized",
  NOT_FOUND: "exportNotFound",
  SESSION_EXPORT_FORMAT_INVALID: "exportFormatInvalid",
  SESSION_EXPORT_NATIVE_UNAVAILABLE: "exportNativeUnavailable",
  SESSION_EXPORT_SANDBOX_NOT_RUNNING: "exportSandboxNotRunning",
  SESSION_EXPORT_SANDBOX_BUSY: "exportSandboxBusy",
  SESSION_EXPORT_NATIVE_MISSING: "exportNativeMissing",
  SESSION_EXPORT_NATIVE_INVALID: "exportNativeInvalid",
  SESSION_EXPORT_TOO_LARGE: "exportTooLarge",
  SESSION_EXPORT_FAILED: "exportFailed",
} as const;

function exportFilename(disposition: string, fallback: string) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.trim()).replace(/[\\/]/g, "-") || fallback;
    } catch {
      // A malformed extended filename must not discard a valid download.
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? fallback;
}

function ConversationExportDialog({
  target,
  onClose,
}: {
  target: ConversationExportTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations("console.work");
  const common = useTranslations("common");
  const [pending, setPending] = useState<ConversationExportFormat | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const inFlight = useRef(false);

  async function download(format: ConversationExportFormat) {
    if (!target || inFlight.current) return;
    inFlight.current = true;
    setPending(format);
    try {
      const response = await fetch(
        `/api/v1/agents/${encodeURIComponent(target.agentId)}/conversations/${encodeURIComponent(target.id)}/export?format=${format}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          body && typeof body === "object" && "code" in body ? body.code : null;
        const key =
          typeof code === "string" && Object.hasOwn(exportErrorKeys, code)
            ? exportErrorKeys[code as keyof typeof exportErrorKeys]
            : response.status === 401
              ? "exportUnauthorized"
              : response.status === 404
                ? "exportNotFound"
                : response.status === 413
                  ? "exportTooLarge"
                  : "exportFailed";
        if (code === "SESSION_EXPORT_NATIVE_UNAVAILABLE")
          setNativeUnavailable(true);
        notify(t(key), { severity: "error" });
        return;
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0];
      const expectedType = {
        jsonl: "application/x-ndjson",
        html: "text/html",
        md: "text/markdown",
      }[format];
      const disposition = response.headers.get("content-disposition") ?? "";
      if (contentType !== expectedType || !/^attachment\b/i.test(disposition)) {
        notify(t("exportFailed"), { severity: "error" });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = exportFilename(
          disposition,
          `conversation-${target.id}.${format}`,
        );
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      onClose();
    } catch {
      notify(t("exportFailed"), { severity: "error" });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const formats: ConversationExportFormat[] =
    target?.nativeAvailable && !nativeUnavailable
      ? ["jsonl", "html", "md"]
      : ["md"];
  const labels = {
    jsonl: "exportJsonl",
    html: "exportHtml",
    md: "exportMarkdown",
  } as const;
  return (
    <CenterMorphModal
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={t("exportConversation")}
        closeButtonLabel={common("cancel")}
        className="max-w-md"
      >
        <DialogHeader title={t("exportConversation")} />
        <DialogBody>
          <div className="flex flex-wrap gap-2" aria-busy={Boolean(pending)}>
            {formats.map((format) => (
              <Button
                key={format}
                type="button"
                variant="outline"
                size="md"
                disabled={Boolean(pending)}
                onClick={() => void download(format)}
              >
                {pending === format
                  ? t("exportDownloading")
                  : t(labels[format])}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("exportPersistedOnly")}
          </p>
        </DialogBody>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

const executionStageKeys = {
  queued: "executionQueued",
  preparing: "executionPreparing",
  "waiting-model": "executionWaitingModel",
  generating: "executionGenerating",
  "tool-running": "executionToolRunning",
} as const;

type WorkAgent = {
  id: string;
  name: string;
  description?: string | null;
  pinned: boolean;
  supportsWork: boolean;
  ready: boolean;
  runtimeKind: string | null;
  currentRevisionVersion?: number;
  mcpToolsUpdated?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  } | null;
  providerId?: string | null;
  providerLabel?: string;
  model?: string | null;
  reasoningEffort?: ReasoningLevel | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  sandboxes: Array<{
    id: string;
    name: string;
    kind: string;
    deploymentId: string;
    status?: string;
    running: boolean;
    isDefault: boolean;
  }>;
};

type WorkPart = {
  type: string;
  text?: string;
  filename?: string;
  mediaType?: string;
  url?: string;
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  input?: unknown;
  output?: unknown;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  status?: "running" | "completed" | "failed" | "cancelled";
  runtimeKind?: string;
  data?: unknown;
  source?: SubagentSource;
  reference?: Omit<ComposerReference, "text">;
};

type WorkActivity = {
  id: string;
  type: "runtime" | "reasoning" | "tool";
  status: "running" | "completed" | "failed" | "cancelled";
  runtimeKind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
  input?: unknown;
  output?: unknown;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  source?: SubagentSource;
  textOffset?: number;
};

function mergeStreamRuleTriggers(
  current: StreamRuleTrigger[],
  incoming: unknown[],
) {
  const triggers = new Map(current.map((trigger) => [trigger.id, trigger]));
  for (const value of incoming) {
    const parsed = StreamRuleTriggerSchema.safeParse(value);
    if (parsed.success) triggers.set(parsed.data.id, parsed.data);
  }
  return [...triggers.values()];
}

type WorkMessage = {
  id: string;
  role: string;
  createdAt?: string;
  piEntryId?: string | null;
  parts: WorkPart[];
};
type ConversationSummary = {
  id: string;
  agentId: string;
  title?: string | null;
  source: ParsedMessagingSession | null;
  triggerId?: string | null;
  readOnly?: boolean;
  exportable?: boolean;
};
type ConversationDetail = ConversationSummary & {
  sandbox?: WorkItem["sandbox"];
  runtimeKind?: string;
  modelName?: string | null;
  modelOverride?: {
    providerId: string;
    model: string;
    providerName: string | null;
  } | null;
  contextWindow?: number | null;
  agentRevisionId?: string | null;
  agentRevisionVersion?: number | null;
  legacyRevisionUnresolved?: boolean;
  contextWindowEstimated?: boolean;
  readOnly: boolean;
  messages: WorkMessage[];
  reasoningEffort?: ReasoningEffort | null;
};

type WorkSidebarAgent = {
  agent: WorkAgent;
  sessions: WorkItem[];
  chats: Array<ConversationSummary & { label: string }>;
  channels: Array<ConversationSummary & { label: string }>;
  triggers: Array<ConversationSummary & { label: string }>;
  a2aContexts: A2AContextSummary[];
};
type WorkTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  approvalWaitMs?: number;
  runtimeKind?: string;
  modelName?: string;
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
};

const EXECUTION_STAGES: ReadonlySet<string> = new Set<AgentExecutionStage>([
  "queued",
  "preparing",
  "waiting-model",
  "generating",
  "tool-running",
]);

type WorkTreeAction = {
  kind: "edit" | "retry" | "branch";
  messageId: string;
  text?: string;
};

type WorkPanel = "files" | "terminal" | "screen";

type WorkItem = {
  id: string;
  agentId: string;
  title: string | null;
  titlePending?: boolean;
  /** Client-only placeholder shown before the server list includes it. */
  optimistic?: boolean;
  task: string | null;
  acceptanceCriteria: string | null;
  runtimeKind: string;
  readOnly?: boolean;
  agentRevisionId?: string | null;
  agentRevisionVersion?: number | null;
  legacyRevisionUnresolved?: boolean;
  modelName?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  waitingQuestion: string | null;
  result: string | null;
  error: string | null;
  artifacts: string[];
  conversationId: string;
  reasoningEffort?: ReasoningEffort | null;
  workingDirectory?: string;
  sandbox: {
    id: string;
    name: string;
    kind: string;
    deploymentId: string;
    status?: string;
    running: boolean;
  } | null;
  messages: WorkMessage[];
};

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const MESSAGEABLE_STATUSES = new Set([
  "idle",
  "waiting_user",
  "completed",
  "failed",
]);
const DELETABLE_STATUSES = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];
const EMPTY_SANDBOX_DISPLAYS: SandboxDisplay[] = [];
const EMPTY_EXPANDED_AGENTS: Record<string, boolean> = {};
const UNGROUPED_SIDEBAR_GROUP_ID = "__ungrouped__";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function sidebarFolderIds(resources: SidebarResource[]): string[] {
  return resources.flatMap((resource) =>
    resource.kind === "folder" || resource.kind === "project"
      ? [resource.id, ...sidebarFolderIds(resource.children ?? [])]
      : [],
  );
}

function sidebarIssueTone(
  status: string,
): "error" | "warning" | "running" | null {
  if (
    [
      "error",
      "failed",
      "copy_failed",
      "restore_failed",
      "restore_cleanup_required",
    ].includes(status)
  )
    return "error";
  // Sandboxes stop while idle and start on demand; only actionable states warn.
  if (["setup_required", "waiting_user"].includes(status)) return "warning";
  if (status === "running") return "running";
  return null;
}

type AgentSidebarIssue =
  | { kind: "notConfigured" }
  | { kind: "sandboxFailed" | "sandboxSetup"; name: string }
  | {
      kind: "waitingUser";
      sessionId: string;
      title: string;
    };

/** Everything that needs the user's attention, most severe first. */
function agentSidebarStatus(
  agent: WorkAgent | undefined,
  sessions: readonly WorkItem[],
): {
  tone: "error" | "warning" | "running" | null;
  issues: AgentSidebarIssue[];
  running: number;
} {
  if (!agent) return { tone: null, issues: [], running: 0 };
  const issues: AgentSidebarIssue[] = [];
  // Readiness comes from the published Agent revision, not a live sandbox.
  if (agent.supportsWork && !agent.ready)
    issues.push({ kind: "notConfigured" });
  for (const sandbox of agent.sandboxes) {
    const sandboxTone = sidebarIssueTone(sandbox.status ?? "");
    if (sandboxTone === "error")
      issues.unshift({ kind: "sandboxFailed", name: sandbox.name });
    else if (sandboxTone === "warning")
      issues.push({ kind: "sandboxSetup", name: sandbox.name });
  }
  let running = 0;
  for (const session of sessions) {
    if (session.agentId !== agent.id) continue;
    const title = session.title || session.task || session.id;
    if (session.status === "waiting_user")
      issues.push({ kind: "waitingUser", sessionId: session.id, title });
    else if (session.status === "running") running += 1;
  }
  const tone = issues.some((issue) => issue.kind === "sandboxFailed")
    ? "error"
    : issues.length
      ? "warning"
      : running
        ? "running"
        : null;
  return { tone, issues, running };
}

function parseWorkTiming(value: unknown): WorkTiming | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const startedAt =
    typeof data.startedAt === "number" &&
    Number.isFinite(data.startedAt) &&
    data.startedAt > 0
      ? data.startedAt
      : null;
  if (startedAt === null) return null;
  const completedAt =
    typeof data.completedAt === "number" &&
    Number.isFinite(data.completedAt) &&
    data.completedAt >= startedAt
      ? data.completedAt
      : undefined;
  const durationMs =
    typeof data.durationMs === "number" &&
    Number.isFinite(data.durationMs) &&
    data.durationMs >= 0
      ? data.durationMs
      : undefined;
  const approvalWaitMs =
    typeof data.approvalWaitMs === "number" &&
    Number.isFinite(data.approvalWaitMs) &&
    data.approvalWaitMs >= 0
      ? data.approvalWaitMs
      : undefined;
  const stages = Array.isArray(data.stages)
    ? data.stages.flatMap((value: unknown) => {
        if (!value || typeof value !== "object") return [];
        const mark = value as { stage?: unknown; at?: unknown };
        return typeof mark.stage === "string" &&
          EXECUTION_STAGES.has(mark.stage) &&
          typeof mark.at === "number" &&
          Number.isFinite(mark.at)
          ? [{ stage: mark.stage as AgentExecutionStage, at: mark.at }]
          : [];
      })
    : [];
  return {
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(approvalWaitMs === undefined ? {} : { approvalWaitMs }),
    ...(typeof data.runtimeKind === "string" && data.runtimeKind
      ? { runtimeKind: data.runtimeKind }
      : {}),
    ...(typeof data.modelName === "string" && data.modelName
      ? { modelName: data.modelName }
      : {}),
    ...(stages.length ? { stages } : {}),
  };
}

function messageWorkTiming(message: WorkMessage): WorkTiming | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type !== "data-work-timing") continue;
    const timing = parseWorkTiming(part.data);
    if (timing) return timing;
  }
  return null;
}

function workTimingDuration(
  timing: WorkTiming | null,
  now?: number,
): number | undefined {
  if (!timing) return undefined;
  const finishedAt = timing.completedAt ?? now;
  const total =
    timing.durationMs ??
    (finishedAt === undefined
      ? undefined
      : Math.max(0, finishedAt - timing.startedAt));
  if (total === undefined) return undefined;
  return Math.max(0, total - (timing.approvalWaitMs ?? 0));
}

function WorkElapsed({
  timing,
  live = false,
  dataUi,
  className,
  separator = false,
}: {
  timing: WorkTiming | null;
  live?: boolean;
  dataUi: string;
  className?: string;
  separator?: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);
  const startedAt = timing?.startedAt;
  const completedAt = timing?.completedAt;
  useEffect(() => {
    if (!live || startedAt === undefined || completedAt !== undefined)
      return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [completedAt, live, startedAt]);
  const duration = workTimingDuration(
    timing,
    live ? (now ?? undefined) : undefined,
  );
  const label = formatWorkDuration(duration);
  return label ? (
    <>
      {separator ? (
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          ·
        </span>
      ) : null}
      <span
        data-ui={dataUi}
        className={className}
        title={`${Math.round(duration ?? 0)} ms`}
      >
        {label}
      </span>
    </>
  ) : null;
}

function formatWorkMessageTime(
  value: string | undefined,
): { label: string; title: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    label: date.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
    title: date.toLocaleString(),
  };
}

function workHref(slug: string, id: string) {
  return `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(id)}`;
}

function agentSettingsHref(
  slug: string,
  agentId: string,
  returnTo: string,
  section = "agent",
) {
  return `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?settings=${encodeURIComponent(section)}&returnTo=${encodeURIComponent(returnTo)}`;
}

function CompactionNote({ message }: { message: WorkMessage }) {
  const t = useTranslations("console.conversationOperations");
  const data = messageCompaction(message);
  if (!data) return null;
  return (
    <details
      data-message-id={message.id}
      data-ui="conversation.compaction"
      className="my-3 min-w-0 border-y border-border py-2 text-xs text-muted-foreground"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <Minimize2 className="size-3.5 shrink-0" />
        <span>{t("compacted")}</span>
        <span>
          {t("tokens", { before: data.beforeTokens, after: data.afterTokens })}
        </span>
      </summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
        {data.summary}
      </pre>
    </details>
  );
}

function WorkTranscript({
  workspaceSlug,
  agentName,
  agentId,
  conversationId,
  modelName: fallbackModelName,
  messages,
  streamText,
  streamActivities,
  streamBudgetWarning,
  streamRuleTriggers,
  streamStartedAt,
  streamRuntimeKind,
  streamModelName,
  executionStage,
  sessionStartedAt,
  sessionCompletedAt,
  streaming,
  treeActionsEnabled = false,
  treeActionsDisabled = false,
  treeActionPending = false,
  onTreeAction,
}: {
  workspaceSlug: string;
  agentName: string;
  agentId?: string;
  conversationId?: string;
  modelName?: string | null;
  messages: WorkMessage[];
  streamText: string;
  streamActivities: WorkActivity[];
  streamBudgetWarning?: BudgetWarning;
  streamRuleTriggers: StreamRuleTrigger[];
  streamStartedAt?: number;
  streamRuntimeKind?: string;
  streamModelName?: string;
  executionStage: AgentExecutionStage;
  sessionStartedAt?: string | null;
  sessionCompletedAt?: string | null;
  streaming: boolean;
  treeActionsEnabled?: boolean;
  treeActionsDisabled?: boolean;
  treeActionPending?: boolean;
  onTreeAction?: (action: WorkTreeAction) => Promise<boolean>;
}) {
  const t = useTranslations("console.work");
  const agentsT = useTranslations("console.agents");
  const composerT = useTranslations("console.workComposer");
  const common = useTranslations("common");
  const [treeAction, setTreeAction] = useState<WorkTreeAction | null>(null);
  const [editText, setEditText] = useState("");
  const lastUserMessage = messages.findLast(
    (message) => message.role === "user",
  );
  const lastTurnMessage = messages.findLast(
    (message) =>
      !isConversationControl(message) &&
      !(
        message.parts.some((part) => part.type === ADVISOR_SUGGESTIONS_PART) &&
        message.parts.every(
          (part) =>
            part.type === ADVISOR_SUGGESTIONS_PART ||
            (part.type === "text" && !part.text),
        )
      ) &&
      (message.role === "user" || message.role === "assistant"),
  );
  const treeActionBlocked =
    streaming || treeActionsDisabled || treeActionPending;
  const confirmTreeAction = async () => {
    if (
      !treeAction ||
      !onTreeAction ||
      !treeActionsEnabled ||
      treeActionBlocked
    )
      return;
    if (
      !messages.some(
        (message) => message.id === treeAction.messageId && message.piEntryId,
      ) ||
      (treeAction.kind === "retry" &&
        treeAction.messageId !== lastUserMessage?.id)
    ) {
      notify(t("tree.errors.messageNotFound"), { severity: "error" });
      return;
    }
    const text = editText.trim();
    if (treeAction.kind === "edit" && (!text || text.length > 20_000)) {
      notify(t("tree.errors.invalidText"), { severity: "error" });
      return;
    }
    if (
      await onTreeAction({
        ...treeAction,
        ...(treeAction.kind === "edit" ? { text } : {}),
      })
    )
      setTreeAction(null);
  };
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";
  const streamPersisted =
    streamStartedAt !== undefined &&
    messages.some(
      (message) =>
        (message.role === "assistant" || isConversationControl(message)) &&
        messageWorkTiming(message)?.startedAt === streamStartedAt,
    );
  const transcript: WorkMessage[] =
    streaming && !streamPersisted
      ? [
          ...messages,
          {
            id: "work-stream",
            role: "assistant",
            ...(streamStartedAt
              ? { createdAt: new Date(streamStartedAt).toISOString() }
              : {}),
            parts: [
              ...interleaveLiveText(streamActivities, streamText).map(
                (activity): WorkPart => {
                  if (activity.type === "text") return activity;
                  if (activity.type === "tool") {
                    return {
                      type: "work-tool",
                      source: activity.source,
                      toolCallId: activity.toolCallId,
                      toolName: activity.toolName,
                      deploymentName: activity.deploymentName,
                      originalToolName: activity.originalToolName,
                      durationMs: activity.durationMs,
                      startedAt: activity.startedAt,
                      completedAt: activity.completedAt,
                      input: activity.input,
                      output: activity.output,
                      patch: activity.patch,
                      truncated: activity.truncated,
                      firstChangedLine: activity.firstChangedLine,
                      isError: activity.isError,
                      status: activity.status,
                    };
                  }
                  if (activity.type === "reasoning") {
                    return {
                      type: "reasoning",
                      source: activity.source,
                      text: activity.text,
                      status: activity.status,
                      startedAt: activity.startedAt,
                      completedAt: activity.completedAt,
                    };
                  }
                  return {
                    type: "work-runtime",
                    source: activity.source,
                    runtimeKind: activity.runtimeKind,
                    status: activity.status,
                  };
                },
              ),
              ...(streamBudgetWarning
                ? [{ type: "data-budget-warning", data: streamBudgetWarning }]
                : []),
              ...streamRuleTriggers.map(
                (data): WorkPart => ({
                  type: STREAM_RULE_TRIGGER_PART,
                  data,
                }),
              ),
              ...(streamStartedAt
                ? [
                    {
                      type: "data-work-timing",
                      data: {
                        startedAt: streamStartedAt,
                        ...(streamRuntimeKind
                          ? { runtimeKind: streamRuntimeKind }
                          : {}),
                        ...(streamModelName
                          ? { modelName: streamModelName }
                          : {}),
                      },
                    },
                  ]
                : []),
            ],
          },
        ]
      : messages;

  if (!transcript.length) {
    return (
      <div className="flex min-h-52 items-center justify-center px-6 text-sm text-muted-foreground">
        <Clock3 className="mr-2 size-4" />
        {t("noMessages")}
      </div>
    );
  }

  return (
    <>
      <MessageGroup
        spacing="default"
        className="mx-auto w-full max-w-3xl gap-6 px-4 py-8 sm:px-6"
      >
        {transcript.map((message, messageIndex) => {
          if (messageCompaction(message))
            return <CompactionNote key={message.id} message={message} />;
          const isStreamingMessage = message.id === "work-stream";
          const advisorPart = message.parts.find(
            (part) => part.type === ADVISOR_SUGGESTIONS_PART,
          );
          const advisorResult = AdvisorSuggestionsSchema.safeParse(
            advisorPart?.data,
          );
          const advisory = advisorResult.success ? advisorResult.data : null;
          const advisorOnly =
            advisorPart !== undefined &&
            message.parts.every(
              (part) =>
                part.type === ADVISOR_SUGGESTIONS_PART ||
                (part.type === "text" && !part.text),
            );
          const actionVisibility =
            messageIndex === transcript.length - 1
              ? ""
              : "opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto motion-reduce:transition-none";
          const messageTime = formatWorkMessageTime(message.createdAt);
          const persistedTiming = messageWorkTiming(message);
          const sessionStart = Date.parse(sessionStartedAt ?? "");
          const sessionEnd = Date.parse(sessionCompletedAt ?? "");
          const fallbackTiming: WorkTiming | null =
            !persistedTiming &&
            !advisorOnly &&
            !isStreamingMessage &&
            message.role === "assistant" &&
            messages.filter((item) => item.role === "assistant").length === 1 &&
            Number.isFinite(sessionStart) &&
            Number.isFinite(sessionEnd) &&
            sessionEnd >= sessionStart
              ? {
                  startedAt: sessionStart,
                  completedAt: sessionEnd,
                  durationMs: sessionEnd - sessionStart,
                }
              : null;
          const messageTiming = persistedTiming ?? fallbackTiming;
          const turnModelData = message.parts.find(
            (part) => part.type === "data-agent-turn-model",
          )?.data;
          const turnModel =
            turnModelData &&
            typeof turnModelData === "object" &&
            "model" in turnModelData &&
            typeof turnModelData.model === "string"
              ? turnModelData.model
              : null;
          const messageModelName =
            advisory?.model ??
            turnModel ??
            messageTiming?.modelName ??
            resolveContextUsage([message])?.modelName ??
            fallbackModelName;
          const commandResult = message.parts.find(
            (part) => part.type === COMMAND_RESULT_PART,
          )?.data as { text?: string } | undefined;
          const rawText =
            message.parts
              .filter(
                (part) =>
                  part.type === "text" &&
                  typeof part.text === "string" &&
                  !part.reference,
              )
              .map((part) => part.text)
              .join("\n\n") ||
            (typeof commandResult?.text === "string" ? commandResult.text : "");
          const text =
            message.role === "user"
              ? displayMessagingUserText(rawText)
              : isStreamingMessage
                ? rawText
                : rawText.trim();
          // Tool errors are results the model handles; only the runtime outcome fails a turn.
          const processFailed = message.parts.some(
            (part) => part.type === "work-runtime" && part.status === "failed",
          );
          const fileParts = message.parts.filter(
            (part) =>
              part.type === "file" &&
              typeof part.url === "string" &&
              (part.url.startsWith("/api/v1/attachments/") ||
                /^data:[\w.+-]+\/[\w.+-]+;base64,/.test(part.url)),
          );
          const attachmentLinks = fileParts.length ? (
            <div className="flex max-w-full flex-wrap gap-1.5">
              {fileParts.map((part, index) => (
                <a
                  // biome-ignore lint/suspicious/noArrayIndexKey: Streamed attachment parts are append-only; retain their positional identity, including duplicate URLs.
                  key={`${part.url}-${index}`}
                  href={part.url}
                  download={part.filename ?? agentsT("attachment")}
                  className={`inline-flex min-w-0 max-w-56 items-center gap-1.5 rounded-lg bg-muted/70 px-2 py-1.5 text-xs text-foreground hover:bg-muted ${part.mediaType?.startsWith("image/") ? "flex-wrap" : "flex-nowrap"}`}
                >
                  {part.mediaType?.startsWith("image/") ? (
                    // biome-ignore lint/performance/noImgElement: Authorized attachment URLs and base64 data must render directly without the Next image optimizer or layout sizing changes.
                    <img
                      src={part.url}
                      alt={part.filename ?? agentsT("attachment")}
                      className="max-h-48 w-full object-contain"
                    />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">
                    {part.filename ?? agentsT("attachment")}
                  </span>
                </a>
              ))}
            </div>
          ) : null;
          const messageBody = (
            <>
              {attachmentLinks}
              {message.role === "user" ? (
                <AgentPromptProvenance parts={message.parts} />
              ) : null}
              {message.parts
                .filter((part) => part.reference)
                .map((part, index) =>
                  part.reference ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Streamed reference parts are append-only and can repeat the same reference; preserve existing disclosure identity.
                    <details key={index} className="my-1 text-xs">
                      <summary className="cursor-pointer break-words">
                        {part.reference.kind === "agent" ? (
                          <Bot
                            aria-hidden="true"
                            className="mr-1 inline size-3.5 align-text-bottom"
                          />
                        ) : null}
                        @{part.reference.label}
                        {part.reference.kind === "agent" ? (
                          <span className="ml-2 text-muted-foreground">
                            {composerT(
                              part.reference.targetKind === "remote"
                                ? "remoteAgent"
                                : "localAgent",
                            )}
                          </span>
                        ) : null}
                      </summary>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                        {part.text}
                      </pre>
                    </details>
                  ) : null,
                )}
              {message.role === "user" ? (
                text ? (
                  <span className="whitespace-pre-wrap">{text}</span>
                ) : null
              ) : (
                <>
                  <div data-ui="work-process" className="w-full">
                    <WorkContentBlocks
                      messageId={message.id}
                      parts={message.parts}
                      streaming={isStreamingMessage}
                      activeLabel={t(executionStageKeys[executionStage])}
                    />
                  </div>
                  {!rawText ||
                  message.parts.some(
                    (part) =>
                      part.type === "text" && !part.reference && part.text,
                  ) ? null : (
                    <AssistantMarkdown
                      text={text}
                      streaming={isStreamingMessage}
                    />
                  )}
                </>
              )}
            </>
          );
          const showIdentity =
            messageIndex === 0 ||
            transcript[messageIndex - 1]?.role !== "assistant";
          const messageDuration = workTimingDuration(messageTiming);
          const replyMetadata =
            message.role !== "user" ? (
              <div
                className={`flex min-w-0 flex-wrap items-center gap-2 text-[11px] font-normal text-muted-foreground ${actionVisibility}`}
              >
                {messageModelName ? (
                  <span
                    data-ui="assistant-reply-model"
                    title={messageModelName}
                    className="truncate"
                  >
                    {messageModelName}
                  </span>
                ) : null}
                {messageTime ? (
                  <time
                    data-ui="work-message-time"
                    dateTime={message.createdAt}
                    title={messageTime.title}
                  >
                    {messageTime.label}
                  </time>
                ) : null}
                {messageTiming &&
                !isStreamingMessage &&
                messageDuration !== undefined ? (
                  <WorkTurnTrace
                    messageId={message.id}
                    timing={messageTiming}
                    durationMs={messageDuration}
                    parts={message.parts}
                    modelName={messageModelName}
                    status={
                      processFailed
                        ? "failed"
                        : message.parts.some(
                              (part) =>
                                part.type === "work-runtime" &&
                                part.status === "cancelled",
                            )
                          ? "cancelled"
                          : "completed"
                    }
                  >
                    <WorkElapsed
                      timing={messageTiming}
                      dataUi="work-message-duration"
                    />
                  </WorkTurnTrace>
                ) : (
                  <WorkElapsed
                    timing={messageTiming}
                    live={isStreamingMessage}
                    dataUi="work-message-duration"
                  />
                )}
              </div>
            ) : null;
          const treeActions =
            treeActionsEnabled && onTreeAction && !isStreamingMessage ? (
              <>
                {message.role === "user" && message.piEntryId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={messageActionClassName}
                    disabled={treeActionBlocked}
                    aria-label={t("tree.edit")}
                    title={t("tree.edit")}
                    onClick={() => {
                      setEditText(rawText);
                      setTreeAction({ kind: "edit", messageId: message.id });
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                ) : null}
                {message.id === lastTurnMessage?.id &&
                lastUserMessage?.piEntryId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={messageActionClassName}
                    disabled={treeActionBlocked}
                    aria-label={t("tree.retry")}
                    title={t("tree.retry")}
                    onClick={() =>
                      setTreeAction({
                        kind: "retry",
                        messageId: lastUserMessage.id,
                      })
                    }
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                ) : null}
                {message.piEntryId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={messageActionClassName}
                    disabled={treeActionBlocked}
                    aria-label={t("tree.branch")}
                    title={t("tree.branch")}
                    onClick={() =>
                      setTreeAction({ kind: "branch", messageId: message.id })
                    }
                  >
                    <GitBranch className="size-3.5" />
                  </Button>
                ) : null}
              </>
            ) : null;
          return (
            <ConversationMessageShell
              key={message.id}
              from={message.role === "user" ? "user" : "assistant"}
              name={agentName}
              showIdentity={showIdentity}
              metadata={replyMetadata}
              data-message-id={message.id}
              aria-busy={isStreamingMessage || undefined}
            >
              {showIdentity ? null : replyMetadata}
              {message.role === "user" ? (
                <MessageBubble
                  variant="soft"
                  className={conversationUserBubbleClassName}
                >
                  <MessageBubbleContent>{messageBody}</MessageBubbleContent>
                </MessageBubble>
              ) : (
                <StreamingResponse
                  status={
                    isStreamingMessage
                      ? "streaming"
                      : processFailed
                        ? "error"
                        : "complete"
                  }
                  showActions={false}
                  announce={false}
                >
                  {messageBody}
                </StreamingResponse>
              )}
              {message.role === "assistant" ? (
                <ConversationBudgetWarnings
                  parts={message.parts}
                  workspaceSlug={workspaceSlug}
                  live={isStreamingMessage}
                />
              ) : null}
              {message.role === "assistant" &&
              !isStreamingMessage &&
              !advisorOnly ? (
                <MessageFooter className={`gap-0.5 ${actionVisibility}`}>
                  {text ? (
                    <CopyButton
                      text={text}
                      label={common("copy")}
                      iconOnly
                      className={messageActionClassName}
                    />
                  ) : null}
                  {agentId && conversationId ? (
                    <AgentMessageFeedback
                      agentId={agentId}
                      conversationId={conversationId}
                      messageId={message.id}
                    />
                  ) : null}
                  {treeActions}
                </MessageFooter>
              ) : null}
              {message.role === "user" ? (
                <MessageFooter className={`gap-0.5 ${actionVisibility}`}>
                  {messageTime ? (
                    <time
                      data-ui="work-message-time"
                      dateTime={message.createdAt}
                      title={messageTime.title}
                    >
                      {messageTime.label}
                    </time>
                  ) : null}
                  {text ? (
                    <CopyButton
                      text={text}
                      label={common("copy")}
                      iconOnly
                      className={messageActionClassName}
                    />
                  ) : null}
                  {treeActions}
                </MessageFooter>
              ) : null}
            </ConversationMessageShell>
          );
        })}
      </MessageGroup>
      <CenterMorphModal
        open={Boolean(treeAction)}
        onOpenChange={(open) => {
          if (!open && !treeActionPending) setTreeAction(null);
        }}
      >
        <CenterMorphModalContent
          ariaLabel={t(`tree.${treeAction?.kind ?? "edit"}`)}
          closeButtonLabel={agentsT("close")}
          className="max-w-lg"
        >
          <DialogHeader title={t(`tree.${treeAction?.kind ?? "edit"}`)} />
          <DialogBody>
            <p className="mb-4 text-sm text-muted-foreground">
              {t("tree.contextOnly")}
              {treeAction?.kind === "branch"
                ? ` ${t("tree.branchFiles")}`
                : null}
            </p>
            {treeAction?.kind === "edit" ? (
              <ConversationComposer
                value={editText}
                onValueChange={setEditText}
                onSubmit={() => void confirmTreeAction()}
                autoFocus
                disabled={treeActionBlocked || !treeActionsEnabled}
                loading={treeActionPending}
                aria-label={t("tree.edit")}
                maxLength={20_000}
                placeholder={t("tree.edit")}
              />
            ) : null}
          </DialogBody>
          <DialogFooter cancel={<DialogCancel disabled={treeActionPending} />}>
            {treeAction?.kind !== "edit" ? (
              <Button
                type="button"
                variant="primary"
                disabled={treeActionBlocked || !treeActionsEnabled}
                aria-busy={treeActionPending}
                onClick={() => void confirmTreeAction()}
              >
                {t(`tree.${treeAction?.kind ?? "retry"}`)}
              </Button>
            ) : null}
          </DialogFooter>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </>
  );
}

const NO_PIN_OVERRIDES: Record<string, boolean> = {};

export function WorkspaceWork({
  slug,
  workspaceId,
  agents: serverAgents,
  providers,
  sessions,
  selectedWorkSessionId,
  selectedSession,
  requestedAgentId,
  requestedA2ATaskId,
  conversations = [],
  selectedConversation = null,
  hasChannels = false,
  hasTriggers = false,
  initialExpandedAgents = EMPTY_EXPANDED_AGENTS,
  initialGroupPreferences = EMPTY_SIDEBAR_GROUP_PREFERENCES,
  initialSidebarOpen = true,
}: {
  slug: string;
  workspaceId: string;
  agents: WorkAgent[];
  providers: ModelProviderOption[];
  sessions: WorkItem[];
  selectedWorkSessionId: string | null;
  selectedSession?: WorkItem | null;
  requestedAgentId?: string;
  requestedA2ATaskId?: string;
  conversations?: ConversationSummary[];
  selectedConversation?: ConversationDetail | null;
  hasChannels?: boolean;
  hasTriggers?: boolean;
  initialExpandedAgents?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const composerT = useTranslations("console.workComposer");
  const tChannels = useTranslations("console.agentMessaging");
  const operationsT = useTranslations("console.conversationOperations");
  const tSandboxes = useTranslations("console.sandboxes");
  const common = useTranslations("common");
  const taskStates = useTranslations("console.observability.viewer");
  const router = useRouter();
  const { control: completionNotificationControl, notifyCompletion } =
    useWorkCompletionNotification(workspaceId, slug);
  // Pin toggles apply immediately; overrides drop once refreshed props arrive.
  const [pinState, setPinState] = useState<{
    source: WorkAgent[];
    values: Record<string, boolean>;
  }>({ source: serverAgents, values: {} });
  const pinOverrides =
    pinState.source === serverAgents ? pinState.values : NO_PIN_OVERRIDES;
  const agents = useMemo(
    () =>
      serverAgents.map((item) =>
        item.id in pinOverrides
          ? { ...item, pinned: pinOverrides[item.id] }
          : item,
      ),
    [serverAgents, pinOverrides],
  );
  const initialSelected =
    selectedSession ??
    sessions.find((item) => item.id === selectedWorkSessionId) ??
    null;
  const workAgents = agents.filter((item) => item.supportsWork);
  const [items, setItems] = useState(sessions);
  const deletedWorkSessionIds = useRef(new Set<string>());
  // Server lists are authoritative after navigation/refresh; optimistic
  // entries survive until the server returns them.
  const [syncedSessions, setSyncedSessions] = useState(sessions);
  if (syncedSessions !== sessions) {
    setSyncedSessions(sessions);
    setItems((current) => {
      const known = new Set(sessions.map((item) => item.id));
      return [
        ...current.filter((item) => item.optimistic && !known.has(item.id)),
        ...sessions.filter(
          (item) => !deletedWorkSessionIds.current.has(item.id),
        ),
      ];
    });
  }
  const [liveSelected, setLiveSelected] = useState<WorkItem | null>(null);
  const selectionKey = requestedA2ATaskId
    ? `a2a:${requestedAgentId ?? ""}:${requestedA2ATaskId}`
    : (selectedConversation?.id ?? selectedWorkSessionId);
  const [draftSelectionKey, setDraftSelectionKey] = useState<string | null>(
    null,
  );
  if (draftSelectionKey && draftSelectionKey !== selectionKey)
    setDraftSelectionKey(null);
  const creatingMode = !selectionKey || draftSelectionKey === selectionKey;
  const viewingA2A = Boolean(!creatingMode && requestedA2ATaskId);
  const conversation = creatingMode || viewingA2A ? null : selectedConversation;
  const [conversationBusy, setConversationBusy] = useState(false);
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [fullConversationLists, setFullConversationLists] = useState<
    Record<string, boolean>
  >({});
  const [searchExpandedResources, setSearchExpandedResources] = useState<{
    query: string;
    ids: string[];
  } | null>(null);
  const [mobilePane, setMobilePane] = useState<"sessions" | "work">("work");
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:work-sidebar:${workspaceId}`,
    initialSidebarOpen,
    workSidebarCookieName(workspaceId),
  );
  const [expandedAgents, setExpandedAgents] = usePersistentBooleanRecord(
    `toolplane:work-agent-groups:${workspaceId}`,
    initialExpandedAgents,
    workAgentGroupsCookieName(workspaceId),
  );
  const [groupPreferences, setGroupPreferences] = usePersistentSidebarGroups(
    `toolplane:work-agent-sidebar-groups:${workspaceId}`,
    initialGroupPreferences,
    workAgentGroupPreferencesCookieName(workspaceId),
  );
  const selected =
    creatingMode || conversation || viewingA2A
      ? null
      : liveSelected?.id === selectedWorkSessionId
        ? liveSelected
        : initialSelected;
  const initialAgentId =
    selectedConversation?.agentId ??
    initialSelected?.agentId ??
    workAgents.find((item) => item.id === requestedAgentId)?.id ??
    workAgents[0]?.id ??
    "";
  const [agentId, setAgentId] = useState(initialAgentId);
  const [sandboxId, setSandboxId] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(
    initialSelected?.workingDirectory ?? ".",
  );
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<WorkAgent | null>(
    null,
  );
  const [deleteConversationTarget, setDeleteConversationTarget] = useState<
    (ConversationSummary & { workSessionId?: string }) | null
  >(null);
  const [deleteConversationError, setDeleteConversationError] = useState("");
  const [deleteConversationPending, setDeleteConversationPending] =
    useState(false);
  const [exportConversationTarget, setExportConversationTarget] =
    useState<ConversationExportTarget | null>(null);
  const [groupEditor, setGroupEditor] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [modelChoices, setModelChoices] = useState<
    Record<string, ModelSelection | null>
  >({});
  const [reasoningChoices, setReasoningChoices] = useState<
    Record<string, ReasoningEffort>
  >({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [referenceSelection, setReferenceSelection] = useState<{
    scope: string;
    items: ComposerReference[];
  }>({ scope: "", items: [] });
  const [composerPending, setComposerPending] = useState(false);
  const [belowEditorElement, setBelowEditorElement] =
    useState<HTMLDivElement | null>(null);
  const commandsT = useTranslations("console.runtimeCommands");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const treeActionInFlight = useRef(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [desktopPanel, setDesktopPanel] = useState<WorkPanel | null>(null);
  const [mobilePanel, setMobilePanel] = useState<WorkPanel | null>(null);
  const [screenDisplays, setScreenDisplays] = useState<{
    key: string;
    displays: SandboxDisplay[];
  }>({ key: "", displays: EMPTY_SANDBOX_DISPLAYS });
  const [screenControlRequest, setScreenControlRequest] = useState({
    scope: "",
    value: 0,
  });
  const [screenReleaseRequest, setScreenReleaseRequest] = useState(0);
  const seenTakeoverRequests = useRef(new Set<string>());
  const [streamOutput, setStreamOutput] = useState<{
    workSessionId: string;
    text: string;
    activities: WorkActivity[];
    budgetWarning?: BudgetWarning;
    streamRuleTriggers?: StreamRuleTrigger[];
    startedAt?: number;
    runtimeKind?: string;
    modelName?: string;
    executionStage?: AgentExecutionStage;
  }>({ workSessionId: "", text: "", activities: [] });
  const agent = useMemo(
    () => agents.find((item) => item.id === agentId) ?? null,
    [agents, agentId],
  );
  const selectedAgent = viewingA2A
    ? (agents.find((item) => item.id === (requestedAgentId ?? agentId)) ?? null)
    : selected || conversation
      ? (agents.find(
          (item) => item.id === (conversation?.agentId ?? selected?.agentId),
        ) ?? null)
      : null;
  const sandboxOptions = agent?.sandboxes ?? [];
  const activeSandboxId =
    sandboxId ||
    sandboxOptions.find((item) => item.isDefault)?.id ||
    sandboxOptions[0]?.id ||
    "";
  const activeSandbox =
    sandboxOptions.find((item) => item.id === activeSandboxId) ?? null;
  const controlAgent = selectedAgent ?? agent;
  const controlSandbox = conversation
    ? (conversation.sandbox ?? null)
    : selected
      ? selected.sandbox
      : null;
  const conversationWorkspace = Boolean(conversation || selected);
  const workspacePending =
    controlSandbox &&
    ["copying", "provisioning"].includes(controlSandbox.status ?? "");
  const workspaceUnavailableLabel =
    conversationWorkspace && !controlSandbox
      ? t("conversationWorkspaceNotCreated")
      : workspacePending
        ? t("conversationWorkspaceProvisioning")
        : t("noSandbox");
  const controlWorkspaceRoot = "/workspace";
  const composerScope = `${controlAgent?.id}:${controlSandbox?.id}:${selected?.id ?? conversation?.id ?? "new"}`;
  const screenSandboxId = controlSandbox?.id;
  const screenRunning = controlSandbox?.running === true;
  const screenKey = `${slug}:${screenSandboxId}`;
  const displays =
    screenRunning && screenDisplays.key === screenKey
      ? screenDisplays.displays
      : EMPTY_SANDBOX_DISPLAYS;
  const hasScreen = displays.length > 0;
  const controlRequest =
    screenControlRequest.scope === composerScope
      ? screenControlRequest.value
      : 0;

  useEffect(() => {
    if (!screenSandboxId || !screenRunning) {
      setScreenDisplays({ key: screenKey, displays: EMPTY_SANDBOX_DISPLAYS });
      return;
    }
    const controller = new AbortController();
    void fetch(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/sandboxes/${encodeURIComponent(screenSandboxId)}/screen`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { displays: SandboxDisplay[] };
        if (!controller.signal.aborted) {
          setScreenDisplays({ key: screenKey, displays: data.displays });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setScreenDisplays({
            key: screenKey,
            displays: EMPTY_SANDBOX_DISPLAYS,
          });
        }
      });
    return () => controller.abort();
  }, [screenSandboxId, screenRunning, screenKey, slug]);

  const openScreen = useCallback(() => {
    if (!hasScreen) return;
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setMobilePanel(null);
      setDesktopPanel("screen");
    } else {
      setDesktopPanel(null);
      setMobilePanel("screen");
    }
    setScreenControlRequest((current) => ({
      scope: composerScope,
      value: current.scope === composerScope ? current.value + 1 : 1,
    }));
  }, [hasScreen, composerScope]);

  const openTakeoverScreen = useCallback(
    (id: string) => {
      if (!hasScreen || !window.matchMedia("(min-width: 1280px)").matches)
        return;
      const key = `${composerScope}:${id}`;
      if (seenTakeoverRequests.current.has(key)) return;
      seenTakeoverRequests.current.add(key);
      setScreenControlRequest({ scope: composerScope, value: 0 });
      setMobilePanel(null);
      setDesktopPanel("screen");
    },
    [hasScreen, composerScope],
  );
  const releaseScreenControl = useCallback(
    () => setScreenReleaseRequest((current) => current + 1),
    [],
  );
  const defaultModelSelection =
    controlAgent?.providerId && controlAgent.model
      ? { providerId: controlAgent.providerId, model: controlAgent.model }
      : null;
  const reasoningAvailable = selectionSupportsReasoning(
    providers,
    modelChoices[composerScope] ?? defaultModelSelection,
  );
  const reasoningEffort =
    reasoningChoices[composerScope] ??
    conversation?.reasoningEffort ??
    selected?.reasoningEffort ??
    "default";
  const references =
    referenceSelection.scope === composerScope ? referenceSelection.items : [];
  const commandRuntimeKind = conversation
    ? (conversation.runtimeKind ?? "")
    : selected
      ? selected.runtimeKind
      : (controlAgent?.runtimeKind ?? "");
  const sessionReadOnly = viewingA2A
    ? true
    : conversation
      ? conversation.readOnly ||
        !isExecutableAgentRuntimeKind(conversation.runtimeKind)
      : selected
        ? selected.readOnly !== false ||
          !isExecutableAgentRuntimeKind(selected.runtimeKind)
        : !isExecutableAgentRuntimeKind(controlAgent?.runtimeKind);
  // Channel execution remains read-only here; native dialogs use their own authorization.
  const channelConversation = Boolean(conversation?.source);
  const observingConversation = Boolean(
    conversation &&
      isExecutableAgentRuntimeKind(conversation.runtimeKind) &&
      (channelConversation || sessionReadOnly),
  );
  const approvalConversationBase = conversation
    ? `/api/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversation.id)}`
    : selected?.conversationId
      ? `/api/v1/agents/${encodeURIComponent(selected.agentId)}/conversations/${encodeURIComponent(selected.conversationId)}`
      : null;
  const conversationLive = useLiveTaskOutput({
    // Conversation events currently exclude WorkSession-backed conversations.
    // Work approvals recover from the authenticated Work native UI projection.
    url:
      conversation && approvalConversationBase
        ? `${approvalConversationBase}/events`
        : null,
    onSettled: () => router.refresh(),
    onTranscriptChange: () => router.refresh(),
    onRevoked: () => router.refresh(),
  });
  const approvalParts =
    conversation && conversationLive.connection === "revoked"
      ? []
      : conversation && conversationLive.connection === "live"
        ? conversationLive.dataParts
        : null;
  const approvalEndpoint =
    approvalConversationBase &&
    (!conversation || conversationLive.connection !== "revoked")
      ? `${approvalConversationBase}/tool-approvals`
      : undefined;
  const conversationOutput = observingConversation
    ? conversationLive.output
    : null;
  const conversationOutputPersisted = Boolean(
    conversationOutput &&
      !conversationOutput.active &&
      conversation?.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "data-agent-task" &&
            part.data &&
            typeof part.data === "object" &&
            "taskId" in part.data &&
            part.data.taskId === conversationOutput.taskId &&
            (conversationOutput.startedAt === undefined ||
              ("startedAt" in part.data &&
                part.data.startedAt === conversationOutput.startedAt)),
        ),
      ),
  );
  const conversationAccessRevoked =
    observingConversation && conversationLive.connection === "revoked";
  const observedTaskId = conversationOutput?.taskId;
  const observedStartedAt = conversationOutput?.startedAt;
  useEffect(() => {
    // Pick up the incoming channel message once per turn, not once per token.
    if (observedTaskId && observedStartedAt !== undefined) router.refresh();
  }, [observedTaskId, observedStartedAt, router]);
  const unappliedDraft = Boolean(
    !viewingA2A &&
      !selected &&
      !conversation &&
      isExecutableAgentRuntimeKind(agent?.runtimeKind) &&
      agent?.currentRevisionVersion === 0,
  );
  const commands = sessionReadOnly
    ? []
    : sessionRuntimeCommands(commandRuntimeKind, selected?.messages ?? []);
  const conversationWorkspaceApiBase = conversation
    ? `/api/v1/agents/${conversation.agentId}/conversations/${conversation.id}/sandbox`
    : undefined;
  const workspaceRpcApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/rpc`
    : conversationWorkspaceApiBase
      ? `${conversationWorkspaceApiBase}/rpc`
      : undefined;
  const workspaceTerminalApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/terminal`
    : conversationWorkspaceApiBase
      ? `${conversationWorkspaceApiBase}/terminal`
      : undefined;
  const activeWorkingDirectory = conversation
    ? "."
    : (selected?.workingDirectory ?? workingDirectory);
  const workReturnTo = viewingA2A
    ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(requestedAgentId ?? agentId)}&a2a=${encodeURIComponent(requestedA2ATaskId ?? "")}`
    : conversation
      ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversation.agentId)}&c=${encodeURIComponent(conversation.id)}`
      : selected
        ? workHref(slug, selected.id)
        : `/app/${encodeURIComponent(slug)}/work`;
  const selectedStatus = selected?.status;
  const errorMessage = error ?? selected?.error;
  const visibleError =
    errorMessage === "WORK_AGENT_REFERENCE_FORBIDDEN"
      ? composerT("agentReferenceForbidden")
      : errorMessage === "Invalid references"
        ? composerT("referenceFailed")
        : errorMessage;
  const describeRuntimeError = useRuntimeErrorText();
  const runtimeError = describeRuntimeError(visibleError);
  const configurationError = /no configured model/i.test(visibleError ?? "");
  const showConfigurationNotice =
    !viewingA2A &&
    (configurationError ||
      (!selected && !conversation && agent && !agent.ready && !unappliedDraft));

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes reset the existing provisioning poll.
  useEffect(() => {
    if (
      selected ||
      observingConversation ||
      (!conversationBusy &&
        !["copying", "provisioning"].includes(controlSandbox?.status ?? ""))
    )
      return;
    const interval = window.setInterval(() => router.refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [
    controlSandbox?.status,
    conversationBusy,
    router,
    observingConversation,
    selected,
    conversation,
  ]);

  useEffect(() => {
    if ((!hasChannels && !hasTriggers) || conversation || conversationBusy)
      return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [hasChannels, hasTriggers, conversation, conversationBusy, router]);

  const streamText =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.text
      : "";
  const streamActivities =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.activities
      : EMPTY_WORK_ACTIVITIES;
  const streamBudgetWarning =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.budgetWarning
      : undefined;
  const streamRuleTriggers =
    streamOutput.workSessionId === selectedWorkSessionId
      ? (streamOutput.streamRuleTriggers ?? [])
      : [];
  const streamStartedAt =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.startedAt
      : undefined;
  const streamRuntimeKind =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.runtimeKind
      : undefined;
  const streamModelName =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.modelName
      : undefined;
  const executionStage =
    streamOutput.workSessionId === selectedWorkSessionId
      ? (streamOutput.executionStage ??
        (selectedStatus === "queued" ? "queued" : "preparing"))
      : selectedStatus === "queued"
        ? "queued"
        : "preparing";
  const sessionContextWindow =
    conversation?.contextWindow ?? selected?.contextWindow;
  const sessionModelName =
    conversation?.modelOverride?.model ??
    conversation?.modelName ??
    selected?.modelName;
  const sessionContextEstimated =
    conversation?.contextWindowEstimated ?? selected?.contextWindowEstimated;
  const renderedHookIds = useMemo(
    () =>
      (conversation?.messages ?? selected?.messages ?? []).flatMap((message) =>
        message.parts.flatMap((part) => {
          if (
            part.type !== "hook-activity" &&
            part.type !== "data-hook-activity"
          )
            return [];
          const parsed = HookActivitySchema.safeParse(part.data);
          return parsed.success ? [`native-hook:${parsed.data.id}`] : [];
        }),
      ),
    [conversation?.messages, selected?.messages],
  );
  const contextUsage = useMemo(
    () =>
      resolveContextUsage(
        activeConversationMessages(
          conversation?.messages ?? selected?.messages ?? [],
        ).map((message) => ({
          parts: Array.isArray(message.parts) ? message.parts : [],
        })),
        {
          maxTokens: sessionContextWindow,
          modelName: sessionModelName,
          context: streamText,
          estimated: sessionContextEstimated,
        },
      ),
    [
      sessionContextWindow,
      sessionContextEstimated,
      sessionModelName,
      selected?.messages,
      conversation?.messages,
      streamText,
    ],
  );
  const workspacePanelOpen =
    !viewingA2A &&
    Boolean(desktopPanel) &&
    (desktopPanel !== "screen" || hasScreen);

  const activeAgentId = viewingA2A
    ? (requestedAgentId ?? agentId)
    : (conversation?.agentId ?? selected?.agentId ?? agentId);
  const a2a = useA2AContexts(
    slug,
    agents
      .filter(
        (item) =>
          item.id === activeAgentId ||
          (expandedAgents[item.id] ??
            conversations.some((entry) => entry.agentId === item.id)),
      )
      .map((item) => item.id),
    viewingA2A ? activeAgentId : undefined,
    viewingA2A ? requestedA2ATaskId : undefined,
  );
  const visibleAgents = useMemo<WorkSidebarAgent[]>(
    () =>
      sortSidebarItems(agents, groupPreferences.entityOrder).map((item) => {
        const order = groupPreferences.conversationOrder?.[item.id];
        const agentSessions = sortSidebarItems(
          items.filter((session) => session.agentId === item.id),
          order,
        );
        const agentConversations = sortSidebarItems(
          conversations.filter((entry) => entry.agentId === item.id),
          order,
        ).map((entry) => {
          if (!entry.source)
            return { ...entry, label: entry.title || t("untitledSession") };
          const { platform, chatId } = entry.source;
          const platformLabel = tChannels.has(`platforms.${platform}`)
            ? tChannels(`platforms.${platform}`)
            : platform;
          return { ...entry, label: `${platformLabel} · ${chatId}` };
        });
        const receivedContexts = a2a.pages[item.id]?.items ?? [];
        const a2aContexts =
          a2a.context &&
          item.id === activeAgentId &&
          !receivedContexts.some(
            (entry) => entry.contextId === a2a.context?.contextId,
          )
            ? [...receivedContexts, a2a.context].sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
              )
            : receivedContexts;
        return {
          agent: item,
          sessions: agentSessions,
          chats: agentConversations.filter(
            (entry) => !entry.source && !entry.triggerId,
          ),
          channels: agentConversations.filter((entry) => entry.source),
          triggers: agentConversations.filter(
            (entry) => !entry.source && entry.triggerId,
          ),
          a2aContexts,
        };
      }),
    [
      agents,
      items,
      conversations,
      a2a.pages,
      a2a.context,
      activeAgentId,
      groupPreferences.entityOrder,
      groupPreferences.conversationOrder,
      tChannels,
      t,
    ],
  );
  const groupedAgents = useMemo(() => {
    const agentsByGroup = new Map<string, WorkSidebarAgent[]>(
      groupPreferences.groups.map((group) => [group.id, []]),
    );
    const ungrouped: WorkSidebarAgent[] = [];
    for (const item of visibleAgents) {
      const group = agentsByGroup.get(
        groupPreferences.assignments[item.agent.id] ?? "",
      );
      if (group) group.push(item);
      else ungrouped.push(item);
    }
    return {
      groups: groupPreferences.groups.map((group) => ({
        group,
        agents: agentsByGroup.get(group.id) ?? [],
      })),
      ungrouped,
    };
  }, [groupPreferences.assignments, groupPreferences.groups, visibleAgents]);
  const sidebarResources = useMemo<SidebarResource[]>(() => {
    const agentResources = (entries: WorkSidebarAgent[]): SidebarResource[] =>
      entries.map(
        ({
          agent: itemAgent,
          sessions: agentSessions,
          chats,
          channels,
          triggers,
          a2aContexts,
        }) => ({
          id: `agent:${itemAgent.id}`,
          label: itemAgent.name,
          kind: "project",
          children: [
            ...agentSessions.map((item) => ({
              id: `session:${item.id}`,
              label: item.title || item.task || t("untitled"),
              kind: "file" as const,
            })),
            ...chats.map((item) => ({
              id: `conversation:${item.id}`,
              label: item.label,
              kind: "bookmark" as const,
            })),
            ...(channels.length
              ? [
                  {
                    id: `channel-group:${itemAgent.id}`,
                    label: t("channelGroup"),
                    kind: "folder" as const,
                    children: channels
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`channel:${itemAgent.id}`] ||
                          index < 5 ||
                          item.id === conversation?.id,
                      )
                      .map((item) => ({
                        id: `conversation:${item.id}`,
                        label: item.label,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
            ...(triggers.length
              ? [
                  {
                    id: `trigger-group:${itemAgent.id}`,
                    label: t("triggerGroup"),
                    kind: "folder" as const,
                    children: triggers
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`trigger:${itemAgent.id}`] ||
                          index < 5 ||
                          item.id === conversation?.id,
                      )
                      .map((item) => ({
                        id: `conversation:${item.id}`,
                        label: item.label,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
            ...(a2aContexts.length
              ? [
                  {
                    id: `a2a-group:${itemAgent.id}`,
                    label: t("a2a.group"),
                    kind: "folder" as const,
                    children: a2aContexts
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`a2a:${itemAgent.id}`] ||
                          index < 5 ||
                          item.contextId === a2a.context?.contextId,
                      )
                      .map((item) => ({
                        id: `a2a:${item.contextId}`,
                        label: item.title
                          ? `${item.peer.name} · ${item.title}`
                          : item.peer.name,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
          ].filter(
            (item, index) =>
              item.kind === "folder" ||
              sidebarSearch.trim() ||
              fullConversationLists[itemAgent.id] ||
              index < 5 ||
              item.id === `session:${selectedWorkSessionId}` ||
              item.id === `conversation:${conversation?.id}`,
          ),
        }),
      );
    if (!groupPreferences.groups.length) return agentResources(visibleAgents);
    return [
      ...groupedAgents.groups.map(({ group, agents: groupAgents }) => ({
        id: `group:${group.id}`,
        label: group.name,
        kind: "folder" as const,
        children: agentResources(groupAgents),
      })),
      {
        id: "group:ungrouped",
        label: t("ungrouped"),
        kind: "folder" as const,
        children: agentResources(groupedAgents.ungrouped),
      },
    ];
  }, [
    groupPreferences.groups.length,
    groupedAgents,
    t,
    visibleAgents,
    sidebarSearch,
    fullConversationLists,
    selectedWorkSessionId,
    conversation?.id,
    a2a.context?.contextId,
  ]);
  const filteredSidebarResources = useMemo(() => {
    const query = sidebarSearch.trim().toLocaleLowerCase();
    if (!query) return sidebarResources;
    const filter = (resources: SidebarResource[]): SidebarResource[] =>
      resources.flatMap((resource) => {
        if (resource.label.toLocaleLowerCase().includes(query))
          return [resource];
        const children = resource.children ? filter(resource.children) : [];
        return children.length ? [{ ...resource, children }] : [];
      });
    return filter(sidebarResources);
  }, [sidebarResources, sidebarSearch]);
  const activeResourceId =
    viewingA2A && a2a.context
      ? `a2a:${a2a.context.contextId}`
      : conversation
        ? `conversation:${conversation.id}`
        : selected
          ? `session:${selected.id}`
          : null;
  const activeResourceIdRef = useRef(activeResourceId);
  activeResourceIdRef.current = activeResourceId;
  const revealedResourceId = useRef<string | null>(null);
  useEffect(() => {
    if (revealedResourceId.current === activeResourceId) return;
    revealedResourceId.current = activeResourceId;
    if (!activeResourceId) return;
    const folderKey = channelConversation
      ? `channel:${activeAgentId}`
      : conversation?.triggerId
        ? `trigger:${activeAgentId}`
        : viewingA2A
          ? `a2a:${activeAgentId}`
          : null;
    setExpandedAgents((current) => {
      if (current[activeAgentId] && (!folderKey || current[folderKey]))
        return current;
      return {
        ...current,
        [activeAgentId]: true,
        ...(folderKey ? { [folderKey]: true } : {}),
      };
    });
    setGroupPreferences((current) => {
      const groupId =
        current.assignments[activeAgentId] ?? UNGROUPED_SIDEBAR_GROUP_ID;
      if (!current.collapsed[groupId]) return current;
      return {
        ...current,
        collapsed: { ...current.collapsed, [groupId]: false },
      };
    });
  }, [
    activeResourceId,
    activeAgentId,
    channelConversation,
    conversation?.triggerId,
    viewingA2A,
    setExpandedAgents,
    setGroupPreferences,
  ]);
  const expandedResourceIds = useMemo(
    () =>
      sidebarSearch.trim() &&
      searchExpandedResources?.query === sidebarSearch.trim()
        ? searchExpandedResources.ids
        : [
            ...(sidebarSearch.trim()
              ? sidebarFolderIds(filteredSidebarResources)
              : []),
            ...groupPreferences.groups
              .filter((group) => !groupPreferences.collapsed[group.id])
              .map((group) => `group:${group.id}`),
            ...(groupPreferences.collapsed[UNGROUPED_SIDEBAR_GROUP_ID]
              ? []
              : ["group:ungrouped"]),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent, chats, channels, triggers }) =>
                  expandedAgents[itemAgent.id] ??
                  (itemAgent.id === activeAgentId ||
                    chats.length > 0 ||
                    channels.length > 0 ||
                    triggers.length > 0),
              )
              .map(({ agent: itemAgent }) => `agent:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`a2a:${itemAgent.id}`] ?? true,
              )
              .map(({ agent: itemAgent }) => `a2a-group:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`channel:${itemAgent.id}`] ?? false,
              )
              .map(({ agent: itemAgent }) => `channel-group:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`trigger:${itemAgent.id}`] ?? false,
              )
              .map(({ agent: itemAgent }) => `trigger-group:${itemAgent.id}`),
          ],
    [
      activeAgentId,
      expandedAgents,
      filteredSidebarResources,
      groupPreferences.collapsed,
      groupPreferences.groups,
      searchExpandedResources,
      sidebarSearch,
      visibleAgents,
    ],
  );

  function persistExpandedResources(ids: string[]) {
    if (sidebarSearch.trim()) {
      setSearchExpandedResources({ query: sidebarSearch.trim(), ids });
      return;
    }
    const expanded = new Set(ids);
    setExpandedAgents(
      Object.fromEntries(
        agents.flatMap((item) => [
          [item.id, expanded.has(`agent:${item.id}`)],
          [`a2a:${item.id}`, expanded.has(`a2a-group:${item.id}`)],
          [`channel:${item.id}`, expanded.has(`channel-group:${item.id}`)],
          [`trigger:${item.id}`, expanded.has(`trigger-group:${item.id}`)],
        ]),
      ),
    );
    setGroupPreferences((current) => ({
      ...current,
      collapsed: Object.fromEntries([
        ...current.groups.map((group) => [
          group.id,
          !expanded.has(`group:${group.id}`),
        ]),
        [UNGROUPED_SIDEBAR_GROUP_ID, !expanded.has("group:ungrouped")],
      ]),
    }));
  }

  async function moveSidebarResource(move: SidebarResourceMove) {
    const [sourceKind, sourceId] = move.itemId.split(":", 2);
    const [targetKind, targetId] = move.targetId?.split(":", 2) ?? [];
    if (sourceKind === "agent") {
      const targetAgent =
        targetKind === "agent"
          ? agents.find((item) => item.id === targetId)
          : null;
      const targetGroupId =
        targetKind === "group" && move.position === "inside"
          ? targetId === "ungrouped"
            ? null
            : targetId
          : targetAgent &&
              (move.position === "before" || move.position === "after")
            ? (groupPreferences.assignments[targetAgent.id] ?? null)
            : undefined;
      if (
        targetGroupId === undefined ||
        !agents.some((item) => item.id === sourceId)
      )
        throw new Error("Unsupported agent move");
      setGroupPreferences((current) => {
        const assignments = { ...current.assignments };
        if (targetGroupId) assignments[sourceId] = targetGroupId;
        else delete assignments[sourceId];
        const next = {
          ...current,
          assignments,
          collapsed: {
            ...current.collapsed,
            [targetGroupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false,
          },
        };
        return targetAgent &&
          (move.position === "before" || move.position === "after")
          ? {
              ...next,
              entityOrder: reorderSidebarItems(
                sortSidebarItems(agents, current.entityOrder),
                sourceId,
                targetId,
                move.position,
              ),
            }
          : next;
      });
      return;
    }
    const edge =
      move.position === "before"
        ? "before"
        : move.position === "after"
          ? "after"
          : null;
    if (
      (sourceKind !== "session" && sourceKind !== "conversation") ||
      targetKind !== sourceKind ||
      !targetId ||
      !edge
    ) {
      throw new Error("Unsupported resource move");
    }
    const source = (sourceKind === "session" ? items : conversations).find(
      (item) => item.id === sourceId,
    );
    const target = (sourceKind === "session" ? items : conversations).find(
      (item) => item.id === targetId,
    );
    if (!source || !target || source.agentId !== target.agentId)
      throw new Error("Resources must stay with their agent");
    if (
      ("source" in source && Boolean(source.source)) !==
      ("source" in target && Boolean(target.source))
    )
      throw new Error("Conversations must stay in their folder");
    const agentItems = [...items, ...conversations].filter(
      (item) => item.agentId === source.agentId,
    );
    setGroupPreferences((current) => ({
      ...current,
      conversationOrder: {
        ...current.conversationOrder,
        [source.agentId]: reorderSidebarItems(
          sortSidebarItems(
            agentItems,
            current.conversationOrder?.[source.agentId],
          ),
          sourceId,
          targetId,
          edge,
        ),
      },
    }));
  }

  const refreshSelected = useCallback(async () => {
    if (!selectedWorkSessionId || creatingMode) return false;
    try {
      const response = await fetch(
        `/api/v1/work-sessions/${selectedWorkSessionId}`,
        { cache: "no-store" },
      );
      if (!response.ok) return false;
      const next = (await response.json()) as WorkItem;
      next.artifacts = Array.isArray(next.artifacts)
        ? next.artifacts.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      setLiveSelected(next);
      setItems((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      return true;
    } catch {
      return false;
    }
  }, [creatingMode, selectedWorkSessionId]);

  const selectedActive = Boolean(
    selectedStatus && ACTIVE_STATUSES.has(selectedStatus),
  );
  const messageQueue = useAgentMessageQueue({
    agentId: selected?.agentId,
    conversationId: selected?.conversationId,
    active: selectedActive,
    onRefresh: () => {
      void refreshSelected();
    },
  });
  const observeMessageQueue = messageQueue.observe;
  const queueT = useTranslations("console.messageQueue");

  async function sendQueuedMessage(mode: QueueMode) {
    if (
      sessionReadOnly ||
      busy ||
      composerPending ||
      messageQueue.pending ||
      messageQueue.forbidden ||
      !draft.trim()
    )
      return;
    if (attachments.length || references.length) {
      notify(queueT("textOnly"), { severity: "error" });
      return;
    }
    const text = draft;
    const resource = activeResourceId;
    if (await messageQueue.send(mode, text)) {
      if (activeResourceIdRef.current === resource)
        setDraft((current) => (current === text ? "" : current));
    }
  }

  useEffect(() => {
    if (!selected?.titlePending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshSelected();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [refreshSelected, selected?.titlePending]);

  const outputSubscription = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (creatingMode || !selectedWorkSessionId) return;
    return () => {
      outputSubscription.current?.();
      outputSubscription.current = null;
    };
  }, [creatingMode, selectedWorkSessionId]);

  useEffect(() => {
    if (
      !selectedWorkSessionId ||
      creatingMode ||
      !selectedActive ||
      outputSubscription.current ||
      typeof EventSource === "undefined"
    )
      return undefined;

    let disposed = false;
    let finishing = false;
    const completion = createWorkCompletionTransition();
    const source = new EventSource(
      `/api/v1/work-sessions/${encodeURIComponent(selectedWorkSessionId)}/events`,
    );

    const payload = <T,>(event: Event): T | null => {
      try {
        return JSON.parse((event as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      source.close();
      const refreshed = await refreshSelected();
      if (!disposed && refreshed) {
        setStreamOutput({
          workSessionId: selectedWorkSessionId,
          text: "",
          activities: [],
        });
      }
      dispose();
    };

    source.addEventListener("snapshot", (event) => {
      const next = payload<{
        text?: string;
        activities?: WorkActivity[];
        budgetWarning?: unknown;
        streamRuleTriggers?: unknown[];
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
        executionStage?: AgentExecutionStage;
        messageQueue?: AgentMessageQueue;
      }>(event);
      if (!next) return;
      completion.observe("snapshot", next);
      observeMessageQueue(
        next.messageQueue ?? { messages: [], pendingMessageCount: 0 },
      );
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: next.text ?? "",
        activities: Array.isArray(next.activities) ? next.activities : [],
        streamRuleTriggers: mergeStreamRuleTriggers(
          [],
          Array.isArray(next.streamRuleTriggers) ? next.streamRuleTriggers : [],
        ),
        executionStage: next.executionStage,
        budgetWarning: parseConversationBudgetWarning(next.budgetWarning),
        ...(typeof next.startedAt === "number"
          ? { startedAt: next.startedAt }
          : {}),
        ...(typeof next.runtimeKind === "string"
          ? { runtimeKind: next.runtimeKind }
          : {}),
        ...(typeof next.modelName === "string"
          ? { modelName: next.modelName }
          : {}),
      });
      if (next.done) {
        void finish();
        return;
      }
    });
    source.addEventListener("start", (event) => {
      const next = payload<{
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
        executionStage?: AgentExecutionStage;
      }>(event);
      if (next) completion.observe("start", next);
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: "",
        activities: [],
        executionStage: next?.executionStage,
        ...(typeof next?.startedAt === "number"
          ? { startedAt: next.startedAt }
          : {}),
        ...(typeof next?.runtimeKind === "string"
          ? { runtimeKind: next.runtimeKind }
          : {}),
        ...(typeof next?.modelName === "string"
          ? { modelName: next.modelName }
          : {}),
      });
      void refreshSelected();
      observeMessageQueue({ messages: [], pendingMessageCount: 0 });
    });
    source.addEventListener("stream_rule_triggered", (event) => {
      const next = payload<{
        trigger?: unknown;
        streamRuleTriggers?: unknown[];
        startedAt?: number;
      }>(event);
      if (!next) return;
      setStreamOutput((current) => {
        const sameTurn =
          current.workSessionId === selectedWorkSessionId &&
          (next.startedAt === undefined ||
            current.startedAt === next.startedAt);
        return {
          ...(sameTurn
            ? current
            : {
                workSessionId: selectedWorkSessionId,
                text: "",
                activities: [],
                startedAt: next.startedAt,
              }),
          streamRuleTriggers: mergeStreamRuleTriggers(
            sameTurn ? (current.streamRuleTriggers ?? []) : [],
            [
              ...(Array.isArray(next.streamRuleTriggers)
                ? next.streamRuleTriggers
                : []),
              next.trigger,
            ],
          ),
        };
      });
    });
    source.addEventListener("stage", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{
        text: string;
        activities: WorkActivity[];
        executionStage?: AgentExecutionStage;
        messageQueue?: AgentMessageQueue;
      }>(event);
      if (!next) return;
      observeMessageQueue(
        next.messageQueue ?? { messages: [], pendingMessageCount: 0 },
      );
      setStreamOutput((current) => ({
        ...(current.workSessionId === selectedWorkSessionId
          ? current
          : { workSessionId: selectedWorkSessionId }),
        text: next.text,
        activities: next.activities,
        executionStage: next.executionStage,
      }));
      // Stage snapshots also carry consumption boundaries, not just stage labels.
      void refreshSelected();
    });
    source.addEventListener("delta", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{ delta?: string }>(event);
      if (!next?.delta) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text:
          (current.workSessionId === selectedWorkSessionId
            ? current.text
            : "") + next.delta,
        activities:
          current.workSessionId === selectedWorkSessionId
            ? current.activities
            : [],
        budgetWarning:
          current.workSessionId === selectedWorkSessionId
            ? current.budgetWarning
            : undefined,
        streamRuleTriggers:
          current.workSessionId === selectedWorkSessionId
            ? current.streamRuleTriggers
            : [],
        executionStage:
          current.workSessionId === selectedWorkSessionId
            ? current.executionStage
            : undefined,
        ...(current.workSessionId === selectedWorkSessionId &&
        current.startedAt !== undefined
          ? { startedAt: current.startedAt }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId &&
        current.runtimeKind
          ? { runtimeKind: current.runtimeKind }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName
          ? { modelName: current.modelName }
          : {}),
      }));
    });
    source.addEventListener("activity", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{ activities?: WorkActivity[] }>(event);
      if (!Array.isArray(next?.activities)) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text:
          current.workSessionId === selectedWorkSessionId ? current.text : "",
        activities: next.activities ?? [],
        budgetWarning:
          current.workSessionId === selectedWorkSessionId
            ? current.budgetWarning
            : undefined,
        streamRuleTriggers:
          current.workSessionId === selectedWorkSessionId
            ? current.streamRuleTriggers
            : [],
        executionStage:
          current.workSessionId === selectedWorkSessionId
            ? current.executionStage
            : undefined,
        ...(current.workSessionId === selectedWorkSessionId &&
        current.startedAt !== undefined
          ? { startedAt: current.startedAt }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId &&
        current.runtimeKind
          ? { runtimeKind: current.runtimeKind }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName
          ? { modelName: current.modelName }
          : {}),
      }));
    });
    const receiveBudgetWarning = (event: Event) => {
      const next = payload<{ budgetWarning?: unknown; data?: unknown }>(event);
      const warning = parseConversationBudgetWarning(
        next?.budgetWarning ??
          (event.type === "data-budget-warning" ? next?.data : undefined),
      );
      if (!warning) return;
      setStreamOutput((current) => {
        const sameSession = current.workSessionId === selectedWorkSessionId;
        if (sameSession && current.budgetWarning?.taskId === warning.taskId)
          return current;
        return {
          ...(sameSession
            ? current
            : {
                workSessionId: selectedWorkSessionId,
                text: "",
                activities: [],
              }),
          budgetWarning: warning,
        };
      });
    };
    source.addEventListener("data-budget-warning", receiveBudgetWarning);
    source.addEventListener("error", () => completion.disconnect());
    source.addEventListener("done", (event) => {
      if (disposed) return;
      receiveBudgetWarning(event);
      const next = payload<{
        active?: boolean;
        done?: boolean;
        startedAt?: number;
      }>(event);
      const startedAt = next ? completion.observe("done", next) : null;
      if (startedAt !== null)
        notifyCompletion(selectedWorkSessionId, startedAt);
      void finish();
    });

    function dispose() {
      disposed = true;
      completion.disconnect();
      source.close();
      if (outputSubscription.current === dispose)
        outputSubscription.current = null;
    }
    // REST status becomes terminal before the coordinator publishes SSE done.
    // Only the stream itself or a selection/unmount may dispose this listener.
    outputSubscription.current = dispose;
  }, [
    creatingMode,
    refreshSelected,
    selectedActive,
    selectedWorkSessionId,
    notifyCompletion,
    observeMessageQueue,
  ]);

  function openAgentGroup(nextAgentId: string) {
    setGroupPreferences((current) => {
      const groupId = current.assignments[nextAgentId];
      if (!groupId || !current.collapsed[groupId]) return current;
      return {
        ...current,
        collapsed: { ...current.collapsed, [groupId]: false },
      };
    });
  }

  function startNewWork(nextAgentId = agentId) {
    setExpandedAgents((current) => ({ ...current, [nextAgentId]: true }));
    openAgentGroup(nextAgentId);
    setAgentId(nextAgentId);
    setSandboxId("");
    setDraftSelectionKey(selectionKey);
    setMobilePane("work");
    setDraft("");
    setAttachments([]);
    setReferenceSelection({ scope: "", items: [] });
    setWorkingDirectory(".");
    setError(null);
    window.history.replaceState(
      window.history.state,
      "",
      `/app/${encodeURIComponent(slug)}/work`,
    );
  }

  async function uploadAttachments(): Promise<string[]> {
    const uploaded: string[] = [];
    try {
      for (const file of attachments) {
        const query = new URLSearchParams({ filename: file.name });
        const response = await fetch(
          `/api/v1/workspaces/${workspaceId}/attachments?${query}`,
          {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          },
        );
        const result = (await response.json().catch(() => ({}))) as {
          id?: string;
          error?: string;
        };
        if (!response.ok || !result.id)
          throw new Error(result.error || tAgents("attachmentUploadFailed"));
        uploaded.push(result.id);
      }
      return uploaded;
    } catch (error) {
      await Promise.all(
        uploaded.map((id) =>
          fetch(`/api/v1/attachments/${id}`, { method: "DELETE" }).catch(
            () => undefined,
          ),
        ),
      );
      throw error;
    }
  }

  async function discardUploaded(ids: string[]) {
    await Promise.all(
      ids.map((id) =>
        fetch(`/api/v1/attachments/${id}`, { method: "DELETE" }).catch(
          () => undefined,
        ),
      ),
    );
  }

  async function createWork() {
    if (
      !agent ||
      !isExecutableAgentRuntimeKind(agent?.runtimeKind) ||
      !agentId ||
      !activeSandboxId ||
      !draft.trim()
    )
      return;
    const runtimeKind = agent.runtimeKind;
    setBusy("create");
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
      const response = await fetch("/api/v1/work-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          sandboxId: activeSandboxId,
          task: draft.trim(),
          ...(modelChoices[composerScope]
            ? { modelOverride: modelChoices[composerScope] }
            : {}),
          ...(reasoningAvailable ? { reasoningEffort } : {}),
          ...(references.length ? { references } : {}),
          workingDirectory,
          attachmentIds,
        }),
      });
      const body = (await response.json()) as {
        workSessionId?: string;
        error?: string;
      };
      if (!response.ok || !body.workSessionId)
        throw new Error(body.error || t("createError"));
      const nextScope = `${agentId}:${activeSandboxId}:${body.workSessionId}`;
      setModelChoices((choices) => ({
        ...choices,
        [nextScope]: choices[composerScope] ?? null,
      }));
      setReasoningChoices((choices) => ({
        ...choices,
        [nextScope]: reasoningEffort,
      }));
      setItems((current) => [
        {
          id: body.workSessionId as string,
          agentId,
          title: conversationTitleFromParts([{ type: "text", text: draft }]),
          titlePending: true,
          optimistic: true,
          task: draft.trim(),
          acceptanceCriteria: null,
          runtimeKind,
          status: "queued",
          waitingQuestion: null,
          result: null,
          error: null,
          artifacts: [],
          conversationId: "",
          sandbox: null,
          messages: [],
        },
        ...current,
      ]);
      setDraft("");
      setAttachments([]);
      setReferenceSelection({ scope: "", items: [] });
      setDraftSelectionKey(null);
      setBusy(null);
      router.push(workHref(slug, body.workSessionId));
    } catch (cause) {
      await discardUploaded(attachmentIds);
      setError(cause instanceof Error ? cause.message : t("createError"));
      setBusy(null);
    }
  }

  async function postAction(path: string, body?: Record<string, unknown>) {
    if (!selected) return false;
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/work-sessions/${selected.id}/${path}`,
        {
          method: "POST",
          ...(body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || t("createError"));
      await refreshSelected();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createError"));
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function mutateConversationTree(action: WorkTreeAction) {
    if (
      !selected ||
      sessionReadOnly ||
      selectedActive ||
      busy ||
      composerPending ||
      treeActionInFlight.current
    )
      return false;
    treeActionInFlight.current = true;
    setBusy("tree");
    const target = selected;
    try {
      const path =
        action.kind === "retry"
          ? "retry"
          : `messages/${encodeURIComponent(action.messageId)}/${action.kind}`;
      const response = await fetch(
        `/api/v1/agents/${encodeURIComponent(target.agentId)}/conversations/${encodeURIComponent(target.conversationId)}/${path}`,
        {
          method: "POST",
          ...(action.kind === "edit"
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: action.text }),
              }
            : {}),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        kind?: string;
        workSessionId?: string;
        contextOnly?: boolean;
        filesRewound?: boolean;
        externalEffectsRewound?: boolean;
      } | null;
      if (!response.ok) {
        const code = result?.error ?? "conversationTreeFailed";
        notify(
          t.has(`tree.errors.${code}`)
            ? t(`tree.errors.${code}`)
            : (describeRuntimeError(code)?.text ??
                t("tree.errors.conversationTreeFailed")),
          { severity: "error" },
        );
        return false;
      }
      if (
        !result?.workSessionId ||
        result.kind !== (action.kind === "branch" ? "branched" : "queued")
      ) {
        notify(t("tree.errors.conversationTreeFailed"), { severity: "error" });
        return false;
      }
      const contextOnly =
        result.contextOnly === true &&
        result.filesRewound === false &&
        result.externalEffectsRewound === false;
      notify(
        `${t(action.kind === "branch" ? "tree.branched" : "tree.queued")}${contextOnly ? ` ${t("tree.contextOnly")}` : ""}`,
      );
      if (action.kind === "branch") {
        if (activeResourceIdRef.current === `session:${target.id}`)
          router.push(workHref(slug, result.workSessionId));
      } else {
        if (activeResourceIdRef.current === `session:${target.id}`) {
          setError(null);
          setFollowingOutput(true);
          setStreamOutput({
            workSessionId: target.id,
            text: "",
            activities: [],
          });
          setLiveSelected({
            ...target,
            status: "queued",
            error: null,
            result: null,
            artifacts: [],
            completedAt: null,
            waitingQuestion: null,
          });
        }
        await refreshSelected();
      }
      router.refresh();
      return true;
    } catch {
      notify(t("tree.errors.conversationTreeFailed"), { severity: "error" });
      return false;
    } finally {
      treeActionInFlight.current = false;
      setBusy(null);
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    if (
      sessionReadOnly ||
      conversation ||
      busy ||
      messageQueue.pending ||
      (running && !messageQueue.fallback) ||
      composerPending
    )
      return;
    const input = draft.trim();
    if (!input) return;
    // Opening a disclosure pauses following; a new turn returns to the live edge.
    setFollowingOutput(true);
    const command = parseRuntimeCommand(input, commandRuntimeKind);
    if (command && command.name !== "new") {
      if (
        !isExecutableAgentRuntimeKind(commandRuntimeKind) &&
        !commands.some((item) => item.name === command.name)
      ) {
        setError(commandsT("unsupportedCommand"));
        return;
      }
      if (attachments.length || references.length) {
        setError(commandsT("noAttachments"));
        return;
      }
      if (input.length > 2000) {
        setError(commandsT("invalidCommand"));
        return;
      }
      if (!selected) {
        if (isExecutableAgentRuntimeKind(commandRuntimeKind) && canSend)
          return createWork();
        setError(commandsT("needsConversation"));
        return;
      }
      setBusy("command");
      setError(null);
      try {
        const response = await fetch(
          `/api/v1/agents/${encodeURIComponent(selected.agentId)}/conversations/${encodeURIComponent(selected.conversationId)}/commands`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              line: input,
              ...(modelChoices[composerScope]
                ? { modelOverride: modelChoices[composerScope] }
                : {}),
            }),
          },
        );
        const result = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(
            result.error && commandsT.has(result.error)
              ? commandsT(result.error)
              : result.error || commandsT("failed"),
          );
        setDraft("");
        await refreshSelected();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : commandsT("failed"));
      } finally {
        setBusy(null);
      }
      return;
    }
    if (/^\/new(?:\s|$)/i.test(input)) {
      setError(operationsT("channelCommandOnly"));
      return;
    }
    if (!canSend && !messageQueue.fallback) return;
    if (!selected) return createWork();
    setBusy("input");
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tAgents("attachmentUploadFailed"),
      );
      setBusy(null);
      return;
    }
    if (
      await postAction("input", {
        input,
        ...(modelChoices[composerScope]
          ? { modelOverride: modelChoices[composerScope] }
          : {}),
        ...(reasoningAvailable ? { reasoningEffort } : {}),
        ...(references.length ? { references } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      })
    ) {
      setDraft("");
      setAttachments([]);
      setReferenceSelection({ scope: "", items: [] });
    } else {
      await discardUploaded(attachmentIds);
    }
  }

  async function deleteWorkConversation(
    target: ConversationSummary & { workSessionId: string },
  ) {
    const response = await fetch(
      `/api/v1/work-sessions/${encodeURIComponent(target.workSessionId)}`,
      {
        method: "DELETE",
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : t("deleteConversationError"),
      );
    }
    deletedWorkSessionIds.current.add(target.workSessionId);
    setItems((current) =>
      current.filter((item) => item.id !== target.workSessionId),
    );
    setDeleteConversationTarget(null);
    notify(t("conversationDeleted"));
    if (activeResourceIdRef.current !== `session:${target.workSessionId}`)
      return;
    const remaining = visibleAgents.find(
      (item) => item.agent.id === target.agentId,
    );
    const nextSession = remaining?.sessions.find(
      (item) => item.id !== target.workSessionId,
    );
    const nextConversation = sortSidebarItems(
      conversations.filter((item) => item.agentId === target.agentId),
      groupPreferences.conversationOrder?.[target.agentId],
    )[0];
    const href = nextSession
      ? workHref(slug, nextSession.id)
      : nextConversation
        ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(target.agentId)}&c=${encodeURIComponent(nextConversation.id)}`
        : `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(target.agentId)}`;
    router.replace(href, { scroll: false });
  }

  async function toggleAgentPin(item: WorkAgent) {
    const pinned = !item.pinned;
    const setOverride = (value?: boolean) =>
      setPinState((current) => {
        const values = {
          ...(current.source === serverAgents ? current.values : {}),
        };
        if (value === undefined) delete values[item.id];
        else values[item.id] = value;
        return { source: serverAgents, values };
      });
    setOverride(pinned);
    const formData = new FormData();
    formData.set("workspace", slug);
    formData.set("agentId", item.id);
    formData.set("pinned", String(pinned));
    try {
      await pinAgentAction(formData);
      router.refresh();
    } catch {
      setOverride();
    }
  }

  function agentIssueLabel(issue: AgentSidebarIssue) {
    switch (issue.kind) {
      case "notConfigured":
        return t("agentIssueNotConfigured");
      case "sandboxFailed":
        return t("agentIssueSandboxFailed", { name: issue.name });
      case "sandboxSetup":
        return t("agentIssueSandboxSetup", { name: issue.name });
      case "waitingUser":
        return t("agentIssueWaitingUser", { title: issue.title });
    }
  }

  /** Opens the place where the issue is fixed: a waiting session or the relevant settings section. */
  function resolveAgentIssue(item: WorkAgent, issue: AgentSidebarIssue) {
    if (issue.kind === "waitingUser") {
      router.push(workHref(slug, issue.sessionId));
      return;
    }
    router.push(
      agentSettingsHref(
        slug,
        item.id,
        workReturnTo,
        issue.kind === "notConfigured" ? "agent" : "sandboxes",
      ),
    );
  }

  function agentStatusTooltip(status: ReturnType<typeof agentSidebarStatus>) {
    return (
      <div className="max-w-64 space-y-1 text-left">
        {status.issues.length ? (
          <>
            <p className="font-medium">
              {t("agentIssuesTitle", { count: status.issues.length })}
            </p>
            <ul className="space-y-0.5">
              {status.issues.map((issue) => (
                <li
                  key={`${issue.kind}:${"sessionId" in issue ? issue.sessionId : "name" in issue ? issue.name : ""}`}
                >
                  · {agentIssueLabel(issue)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {status.running ? (
          <p>{t("agentRunningCount", { count: status.running })}</p>
        ) : null}
      </div>
    );
  }

  function setAllAgentSections(collapsed: boolean) {
    if (sidebarSearch.trim()) {
      setSearchExpandedResources({
        query: sidebarSearch.trim(),
        ids: collapsed ? [] : sidebarFolderIds(filteredSidebarResources),
      });
      return;
    }
    setExpandedAgents(
      Object.fromEntries(
        agents.flatMap((item) => [
          [item.id, !collapsed],
          [`a2a:${item.id}`, !collapsed],
          [`channel:${item.id}`, !collapsed],
          [`trigger:${item.id}`, !collapsed],
        ]),
      ),
    );
    setGroupPreferences((current) => {
      if (!current.groups.length) return current;
      return {
        ...current,
        collapsed: Object.fromEntries([
          ...current.groups.map((group) => [group.id, collapsed]),
          [UNGROUPED_SIDEBAR_GROUP_ID, collapsed],
        ]),
      };
    });
  }

  function saveAgentGroup(name: string) {
    if (!groupEditor) return;
    setGroupPreferences((current) => {
      if (groupEditor.id) {
        return {
          ...current,
          groups: current.groups.map((group) =>
            group.id === groupEditor.id ? { ...group, name } : group,
          ),
        };
      }
      const id = createSidebarGroupId();
      return {
        ...current,
        groups: [...current.groups, { id, name }],
        collapsed: { ...current.collapsed, [id]: false },
      };
    });
    setGroupEditor(null);
  }

  function deleteAgentGroup(groupId: string) {
    const group = groupPreferences.groups.find((item) => item.id === groupId);
    if (
      !group ||
      !window.confirm(t("deleteGroupConfirm", { name: group.name }))
    )
      return;
    setGroupPreferences((current) => {
      const assignments = Object.fromEntries(
        Object.entries(current.assignments).filter(
          ([, assignedGroupId]) => assignedGroupId !== groupId,
        ),
      );
      const collapsed = { ...current.collapsed };
      delete collapsed[groupId];
      return {
        ...current,
        groups: current.groups.filter((item) => item.id !== groupId),
        assignments,
        collapsed,
      };
    });
  }

  const running = Boolean(selected && ACTIVE_STATUSES.has(selected.status));
  const canSend =
    !sessionReadOnly &&
    !unappliedDraft &&
    (selected
      ? MESSAGEABLE_STATUSES.has(selected.status)
      : Boolean(
          agent?.ready && isExecutableAgentRuntimeKind(agent.runtimeKind),
        ));
  const localCommand = Boolean(parseRuntimeCommand(draft, commandRuntimeKind));

  function togglePanel(panel: WorkPanel) {
    if (panel === "screen") {
      setScreenControlRequest({ scope: composerScope, value: 0 });
    }
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1280px)").matches
    ) {
      if (panel === "screen") setMobilePanel(null);
      setDesktopPanel((current) => (current === panel ? null : panel));
      return;
    }
    if (panel === "screen") setDesktopPanel(null);
    setMobilePanel(panel);
  }

  const onSidebarScroll = useSidebarScroll();

  return (
    <SubagentConversationScope.Provider
      value={{ slug, agentId: controlAgent?.id ?? agentId }}
    >
      <ChatApp
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        openMobile={mobilePane === "sessions"}
        onOpenMobileChange={(open) => setMobilePane(open ? "sessions" : "work")}
        className="relative flex h-full min-w-0"
      >
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <AnimatedSidebar
            ariaLabel={tAgents("agents")}
            collapsible="offcanvas"
            className="h-full shrink-0"
            panelClassName="h-full min-h-0 bg-muted/30"
          >
            <AnimatedSidebarContent className="gap-3 overflow-hidden px-3 py-4">
              <AnimatedSidebarGroup className="min-h-0 flex-1 p-0">
                <SidebarToolbar
                  title={tAgents("agents")}
                  searchLabel={t("search")}
                  searchPlaceholder={common("search")}
                  search={sidebarSearch}
                  onSearchChange={setSidebarSearch}
                  addLabel={tAgents("newAgent")}
                  onAdd={() =>
                    router.push(
                      `/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`,
                    )
                  }
                  moreLabel={t("listOptions")}
                  moreOpen={listOptionsOpen}
                  onMoreOpenChange={setListOptionsOpen}
                  hasItems={agents.length > 0}
                  expandLabel={t("expandAll")}
                  collapseLabel={t("collapseAll")}
                  newGroupLabel={t("newGroup")}
                  onExpandAll={() => setAllAgentSections(false)}
                  onCollapseAll={() => setAllAgentSections(true)}
                  onNewGroup={() => setGroupEditor({ id: null, name: "" })}
                />
                <AnimatedSidebarGroupContent
                  onScroll={onSidebarScroll}
                  className="sidebar-scroll min-h-0 flex-1 !w-auto -mr-3 overflow-y-auto overscroll-contain pr-3"
                >
                  {filteredSidebarResources.length ? (
                    <AISidebar
                      items={filteredSidebarResources}
                      activeId={activeResourceId}
                      renderAfterRow={(resource) => {
                        if (sidebarSearch.trim()) return null;
                        const roots = sidebarResources.flatMap((item) =>
                          item.id.startsWith("group:")
                            ? (item.children ?? [])
                            : [item],
                        );
                        const conversationGroup = roots
                          .flatMap((item) => item.children ?? [])
                          .find(
                            (item) =>
                              (item.id.startsWith("channel-group:") ||
                                item.id.startsWith("trigger-group:")) &&
                              item.children?.at(-1)?.id === resource.id,
                          );
                        if (conversationGroup) {
                          const isTriggerGroup =
                            conversationGroup.id.startsWith("trigger-group:");
                          const kind = isTriggerGroup ? "trigger" : "channel";
                          const id = conversationGroup.id.slice(
                            `${kind}-group:`.length,
                          );
                          const entry = visibleAgents.find(
                            ({ agent }) => agent.id === id,
                          );
                          const count = isTriggerGroup
                            ? entry?.triggers.length
                            : entry?.channels.length;
                          if (!entry || !count || count <= 5) return null;
                          const key = `${kind}:${id}`;
                          const expanded = Boolean(fullConversationLists[key]);
                          return (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-label={`${expanded ? t("collapseAll") : t("expandAll")} ${entry.agent.name} · ${t(isTriggerGroup ? "triggerGroup" : "channelGroup")}`}
                              onClick={() =>
                                setFullConversationLists((current) => ({
                                  ...current,
                                  [key]: !current[key],
                                }))
                              }
                              className="ml-14 self-start rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              {expanded ? t("collapseAll") : t("expandAll")}
                            </button>
                          );
                        }
                        if (resource.id.startsWith("a2a:")) {
                          const entry = visibleAgents.find((item) =>
                            item.a2aContexts.some(
                              (context) =>
                                `a2a:${context.contextId}` === resource.id,
                            ),
                          );
                          if (!entry) return null;
                          const id = entry.agent.id;
                          const group = roots
                            .find((item) => item.id === `agent:${id}`)
                            ?.children?.find(
                              (item) => item.id === `a2a-group:${id}`,
                            );
                          if (group?.children?.at(-1)?.id !== resource.id)
                            return null;
                          const expanded = fullConversationLists[`a2a:${id}`];
                          const page = a2a.pages[id];
                          return (
                            <div className="ml-14 flex flex-wrap gap-1">
                              {entry.a2aContexts.length > 5 ? (
                                <button
                                  type="button"
                                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label={`${expanded ? t("collapseAll") : t("expandAll")} ${t("a2a.group")}`}
                                  onClick={() =>
                                    setFullConversationLists((current) => ({
                                      ...current,
                                      [`a2a:${id}`]: !current[`a2a:${id}`],
                                    }))
                                  }
                                >
                                  {expanded ? t("collapseAll") : t("expandAll")}
                                </button>
                              ) : null}
                              {(expanded || entry.a2aContexts.length <= 5) &&
                              page?.nextCursor ? (
                                <button
                                  type="button"
                                  disabled={page.loading}
                                  aria-busy={page.loading}
                                  onClick={() => a2a.loadMore(id)}
                                  className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                  {t("a2a.loadMore")}
                                </button>
                              ) : null}
                              {page?.failed ? (
                                <span
                                  role="alert"
                                  className="px-2 py-1.5 text-xs text-destructive"
                                >
                                  {t("a2a.loadFailed")}
                                </span>
                              ) : null}
                            </div>
                          );
                        }
                        const parent = roots.find(
                          (item) =>
                            item.children
                              ?.filter((child) => child.kind !== "folder")
                              .at(-1)?.id === resource.id,
                        );
                        if (!parent) return null;
                        const id = parent.id.slice("agent:".length);
                        const entry = visibleAgents.find(
                          ({ agent }) => agent.id === id,
                        );
                        if (
                          !entry ||
                          entry.sessions.length + entry.chats.length <= 5
                        )
                          return null;
                        return (
                          <button
                            type="button"
                            aria-label={`${fullConversationLists[id] ? t("collapseAll") : t("expandAll")} ${entry.agent.name}`}
                            onClick={() =>
                              setFullConversationLists((current) => ({
                                ...current,
                                [id]: !current[id],
                              }))
                            }
                            className="ml-10 self-start rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {fullConversationLists[id]
                              ? t("collapseAll")
                              : t("expandAll")}
                          </button>
                        );
                      }}
                      ariaLabel={tAgents("agents")}
                      className={`px-0 [&_[role=treeitem]]:rounded-lg [&_[role=treeitem]]:min-h-10 [&_[aria-selected=true]]:bg-muted [&_[role=treeitem]>span[aria-hidden=true]:empty]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:empty]:w-0 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:w-0 ${sidebarHoverActionsClassName}`}
                      expandedIds={expandedResourceIds}
                      onExpandedIdsChange={persistExpandedResources}
                      onActiveChange={(id) => {
                        setDraftSelectionKey(null);
                        setMobilePane("work");
                        const [kind, resourceId] = id.split(":", 2);
                        if (kind === "session")
                          router.push(workHref(slug, resourceId));
                        if (kind === "conversation")
                          router.push(
                            `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversations.find((item) => item.id === resourceId)?.agentId ?? activeAgentId)}&c=${encodeURIComponent(resourceId)}`,
                          );
                        if (kind === "a2a") {
                          const entry = visibleAgents.find((item) =>
                            item.a2aContexts.some(
                              (context) => context.contextId === resourceId,
                            ),
                          );
                          const context = entry?.a2aContexts.find(
                            (item) => item.contextId === resourceId,
                          );
                          const taskId = context?.tasks.at(-1)?.taskId;
                          if (entry && taskId)
                            router.push(
                              `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(entry.agent.id)}&a2a=${encodeURIComponent(taskId)}`,
                            );
                        }
                      }}
                      onMove={moveSidebarResource}
                      onRename={(resource, label) => {
                        if (
                          !resource.id.startsWith("group:") ||
                          resource.id === "group:ungrouped"
                        )
                          return;
                        const id = resource.id.slice("group:".length);
                        setGroupPreferences((current) => ({
                          ...current,
                          groups: current.groups.map((group) =>
                            group.id === id ? { ...group, name: label } : group,
                          ),
                        }));
                      }}
                      renderActions={(resource) => {
                        const [kind, id] = resource.id.split(":", 2);
                        if (kind === "a2a") {
                          const context = visibleAgents
                            .flatMap((entry) => entry.a2aContexts)
                            .find((item) => item.contextId === id);
                          const state = a2aStateKey(
                            context?.state ?? "TASK_STATE_UNSPECIFIED",
                          );
                          return (
                            <span className="sr-only">
                              {taskStates.has(`states.${state}`)
                                ? taskStates(`states.${state}`)
                                : state}
                            </span>
                          );
                        }
                        const itemAgent =
                          kind === "agent"
                            ? agents.find((item) => item.id === id)
                            : null;
                        if (!itemAgent) return null;
                        const pinButton = (
                          <button
                            type="button"
                            draggable={false}
                            aria-pressed={itemAgent.pinned}
                            data-sidebar-reveal={
                              itemAgent.pinned ? undefined : ""
                            }
                            aria-label={`${itemAgent.pinned ? tAgents("unpinAgent") : tAgents("pinAgent")} ${itemAgent.name}`}
                            title={
                              itemAgent.pinned
                                ? tAgents("unpinAgent")
                                : tAgents("pinAgent")
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleAgentPin(itemAgent);
                            }}
                            className={cx(
                              "grid size-7 shrink-0 place-items-center rounded-lg outline-none transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                              itemAgent.pinned
                                ? "text-foreground opacity-100"
                                : "text-muted-foreground opacity-0",
                            )}
                          >
                            <Pin
                              aria-hidden="true"
                              className={cx(
                                "size-3.5 rotate-45",
                                itemAgent.pinned && "fill-current",
                              )}
                            />
                          </button>
                        );
                        const status = agentSidebarStatus(itemAgent, items);
                        const firstIssue = status.issues[0];
                        const resolveButton = firstIssue ? (
                          <Tooltip
                            content={
                              <div className="space-y-1">
                                {agentStatusTooltip(status)}
                                <p className="text-muted-foreground">
                                  {t("agentResolveIssue", {
                                    issue: agentIssueLabel(firstIssue),
                                  })}
                                </p>
                              </div>
                            }
                            side="right"
                          >
                            <button
                              type="button"
                              draggable={false}
                              aria-label={`${t("agentIssuesTitle", { count: status.issues.length })}: ${agentIssueLabel(firstIssue)}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                resolveAgentIssue(itemAgent, firstIssue);
                              }}
                              className={cx(
                                "grid size-7 shrink-0 place-items-center rounded-lg outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
                                status.tone === "error"
                                  ? "text-destructive"
                                  : "text-warning",
                              )}
                            >
                              <CircleAlert
                                aria-hidden="true"
                                className="size-3.5"
                              />
                            </button>
                          </Tooltip>
                        ) : null;
                        if (!itemAgent.supportsWork)
                          return (
                            <>
                              {resolveButton}
                              {pinButton}
                            </>
                          );
                        return (
                          <>
                            {resolveButton}
                            {pinButton}
                            <button
                              type="button"
                              draggable={false}
                              data-sidebar-reveal=""
                              aria-label={`${t("newWork")} ${itemAgent.name}`}
                              title={t("newWork")}
                              onClick={(event) => {
                                event.stopPropagation();
                                startNewWork(itemAgent.id);
                              }}
                              className="grid size-7 shrink-0 place-items-center rounded-lg outline-none opacity-0 transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
                            >
                              <MessageSquarePlus
                                aria-hidden="true"
                                className="size-3.5"
                              />
                            </button>
                          </>
                        );
                      }}
                      renderIcon={(resource) => {
                        const [kind, id] = resource.id.split(":", 2);
                        if (kind === "a2a") {
                          const context = visibleAgents
                            .flatMap((entry) => entry.a2aContexts)
                            .find((item) => item.contextId === id);
                          const state = a2aStateKey(
                            context?.state ?? "TASK_STATE_UNSPECIFIED",
                          );
                          return (
                            <Tooltip
                              content={
                                taskStates.has(`states.${state}`)
                                  ? taskStates(`states.${state}`)
                                  : state
                              }
                              side="right"
                            >
                              <Circle
                                data-sidebar-dot=""
                                className={cx(
                                  "size-2 fill-current",
                                  ["failed", "rejected", "canceled"].includes(
                                    state,
                                  )
                                    ? "text-destructive"
                                    : [
                                          "input-required",
                                          "auth-required",
                                        ].includes(state)
                                      ? "text-warning"
                                      : state === "completed"
                                        ? "text-emerald-500"
                                        : "text-primary",
                                )}
                              />
                            </Tooltip>
                          );
                        }
                        if (kind === "agent") {
                          const itemAgent = agents.find(
                            (item) => item.id === id,
                          );
                          const status = agentSidebarStatus(itemAgent, items);
                          const { tone } = status;
                          const avatar = (
                            <span className="relative grid size-5 place-items-center rounded-md bg-muted text-[10px] font-semibold text-foreground ring-1 ring-border">
                              {itemAgent?.name
                                .slice(0, 1)
                                .toLocaleUpperCase() || (
                                <Bot className="size-3.5" />
                              )}
                              {tone ? (
                                <span
                                  className={cx(
                                    "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-background",
                                    tone === "error"
                                      ? "bg-destructive"
                                      : tone === "warning"
                                        ? "bg-warning"
                                        : "bg-primary",
                                  )}
                                />
                              ) : null}
                            </span>
                          );
                          return tone ? (
                            <Tooltip
                              content={agentStatusTooltip(status)}
                              side="right"
                            >
                              {avatar}
                            </Tooltip>
                          ) : (
                            avatar
                          );
                        }
                        if (kind === "session") {
                          const item = items.find(
                            (session) => session.id === id,
                          );
                          const tone = sidebarIssueTone(item?.status ?? "");
                          return tone ? (
                            <Circle
                              data-sidebar-dot=""
                              className={cx(
                                "size-2 fill-current",
                                tone === "error"
                                  ? "text-destructive"
                                  : tone === "warning"
                                    ? "text-warning"
                                    : "text-primary",
                              )}
                            />
                          ) : (
                            false
                          );
                        }
                        // Conversations show no icon; `false` suppresses the sidebar default.
                        if (kind === "conversation") return false;
                        return <Folder className="size-4" />;
                      }}
                      renderMenu={(resource, controls) => {
                        const [kind, id] = resource.id.split(":", 2);
                        const action = (label: string, run: () => void) => (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              controls.close();
                              run();
                            }}
                            className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-xs text-foreground hover:bg-muted"
                          >
                            {label}
                          </button>
                        );
                        if (kind === "group" && id !== "ungrouped")
                          return (
                            <>
                              {action(t("renameGroup"), controls.rename)}
                              {action(t("deleteGroup"), () =>
                                deleteAgentGroup(id),
                              )}
                            </>
                          );
                        if (kind === "agent") {
                          const itemAgent = agents.find(
                            (item) => item.id === id,
                          );
                          if (!itemAgent) return null;
                          return (
                            <>
                              {action(tAgents("configureAgent"), () =>
                                router.push(
                                  agentSettingsHref(
                                    slug,
                                    itemAgent.id,
                                    workReturnTo,
                                  ),
                                ),
                              )}
                              {itemAgent.supportsWork
                                ? action(t("newWork"), () =>
                                    startNewWork(itemAgent.id),
                                  )
                                : null}
                              {action(tAgents("chat"), () =>
                                router.push(
                                  `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(itemAgent.id)}`,
                                ),
                              )}
                              {action(tAgents("deleteAgent"), () =>
                                setDeleteAgentTarget(itemAgent),
                              )}
                            </>
                          );
                        }
                        if (kind === "session") {
                          const item = items.find(
                            (session) => session.id === id,
                          );
                          if (!item) return null;
                          return (
                            <>
                              {item.agentId && item.conversationId
                                ? action(t("exportConversation"), () =>
                                    setExportConversationTarget({
                                      id: item.conversationId,
                                      agentId: item.agentId,
                                      nativeAvailable:
                                        item.readOnly === false &&
                                        item.runtimeKind === "pi-sdk" &&
                                        Boolean(item.agentRevisionId) &&
                                        !item.legacyRevisionUnresolved,
                                    }),
                                  )
                                : null}
                              {DELETABLE_STATUSES.has(item.status)
                                ? action(t("deleteConversation"), () => {
                                    setDeleteConversationError("");
                                    setDeleteConversationTarget({
                                      id: item.conversationId,
                                      agentId: item.agentId,
                                      title: item.title,
                                      source: null,
                                      triggerId: null,
                                      workSessionId: item.id,
                                    });
                                  })
                                : null}
                            </>
                          );
                        }
                        if (kind === "conversation") {
                          const target = conversations.find(
                            (item) => item.id === id,
                          );
                          if (!target) return null;
                          return (
                            <>
                              {target.agentId &&
                              target.id &&
                              target.exportable !== false
                                ? action(t("exportConversation"), () =>
                                    setExportConversationTarget({
                                      id: target.id,
                                      agentId: target.agentId,
                                      nativeAvailable:
                                        target.readOnly === false,
                                    }),
                                  )
                                : null}
                              {!target.source &&
                              !target.title?.startsWith("msg:")
                                ? action(tAgents("deleteConversation"), () => {
                                    setDeleteConversationError("");
                                    setDeleteConversationTarget(target);
                                  })
                                : null}
                            </>
                          );
                        }
                        return null;
                      }}
                    />
                  ) : (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {sidebarSearch.trim()
                        ? t("noSearchResults")
                        : tAgents("noAgentsYet")}
                    </p>
                  )}
                </AnimatedSidebarGroupContent>
              </AnimatedSidebarGroup>
            </AnimatedSidebarContent>
            <AnimatedSidebarRail />
          </AnimatedSidebar>

          <AnimatedSidebarInset className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
              <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <ChatAppSidebarTrigger
                    openLabel={t("showSidebar")}
                    closeLabel={t("hideSidebar")}
                  >
                    <PanelLeft className="size-4" />
                  </ChatAppSidebarTrigger>
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {viewingA2A
                        ? t("a2a.title")
                        : conversation?.title ||
                          selected?.title ||
                          selected?.task ||
                          t("untitledSession")}
                    </p>
                    {controlAgent ? (
                      <span className="hidden max-w-40 truncate rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-block">
                        {controlAgent.name}
                      </span>
                    ) : null}
                    {channelConversation && conversation?.modelOverride ? (
                      <span
                        className="max-w-48 truncate rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
                        title={
                          conversation.modelOverride.providerName ?? undefined
                        }
                      >
                        {tChannels("sessionModelOverride", {
                          model: conversation.modelOverride.model,
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {completionNotificationControl}
                  {controlSandbox || conversationWorkspace ? (
                    <>
                      <Button
                        type="button"
                        onClick={() => togglePanel("files")}
                        aria-label={tSandboxes("files")}
                        title={tSandboxes("files")}
                        aria-pressed={desktopPanel === "files"}
                        variant="ghost"
                        size="icon"
                      >
                        <Folder className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        disabled={sessionReadOnly}
                        onClick={() => togglePanel("terminal")}
                        aria-label={tSandboxes("terminal")}
                        title={tSandboxes("terminal")}
                        aria-pressed={desktopPanel === "terminal"}
                        variant="ghost"
                        size="icon"
                      >
                        <TerminalSquare className="size-4" />
                      </Button>
                      {hasScreen ? (
                        <Button
                          type="button"
                          onClick={() => togglePanel("screen")}
                          aria-label={tSandboxes("screen")}
                          title={tSandboxes("screen")}
                          aria-pressed={
                            desktopPanel === "screen" ||
                            mobilePanel === "screen"
                          }
                          variant="ghost"
                          size="icon"
                        >
                          <Monitor className="size-4" />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </header>
              {(selected || conversation) && sessionReadOnly ? (
                <p
                  role="status"
                  className="border-b border-border px-4 py-3 text-sm text-muted-foreground"
                >
                  {t("sessionHistoryReadOnly")}
                </p>
              ) : null}
              {selected &&
              !sessionReadOnly &&
              controlAgent &&
              selected.agentRevisionVersion &&
              controlAgent.currentRevisionVersion &&
              selected.agentRevisionVersion <
                controlAgent.currentRevisionVersion ? (
                <RevisionUpgradeNotice
                  url={`/api/v1/agents/${controlAgent.id}/conversations/${selected.conversationId}/revision`}
                  fromVersion={selected.agentRevisionVersion}
                  targetVersion={controlAgent.currentRevisionVersion}
                  disabled={selectedActive || Boolean(busy) || composerPending}
                  onUpgraded={() => {
                    void refreshSelected();
                    router.refresh();
                  }}
                />
              ) : null}
              {conversation &&
              channelConversation &&
              !sessionReadOnly &&
              controlAgent &&
              conversation.agentRevisionVersion &&
              controlAgent.currentRevisionVersion &&
              conversation.agentRevisionVersion <
                controlAgent.currentRevisionVersion ? (
                <RevisionUpgradeNotice
                  url={`/api/v1/agents/${conversation.agentId}/conversations/${conversation.id}/revision`}
                  fromVersion={conversation.agentRevisionVersion}
                  targetVersion={controlAgent.currentRevisionVersion}
                  disabled={
                    conversationBusy || Boolean(busy) || composerPending
                  }
                  onUpgraded={() => router.refresh()}
                />
              ) : null}

              {observingConversation ? (
                <div className="mx-auto w-full max-w-3xl px-4 py-2 sm:px-6">
                  <LiveOutputStatus connection={conversationLive.connection} />
                </div>
              ) : null}
              {viewingA2A ? (
                a2a.context ? (
                  <A2AContextView
                    key={`${slug}:${a2a.context.contextId}`}
                    slug={slug}
                    context={a2a.context}
                  />
                ) : (
                  <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-4 py-6 sm:px-6">
                    <p
                      role={
                        a2a.selectionStatus === "loading" ? "status" : "alert"
                      }
                      className="text-sm text-muted-foreground"
                    >
                      {t(
                        a2a.selectionStatus === "loading"
                          ? "a2a.loading"
                          : a2a.selectionStatus === "missing"
                            ? "a2a.unavailable"
                            : "a2a.loadFailed",
                      )}
                    </p>
                    {a2a.selectionStatus !== "loading" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={a2a.refreshSelection}
                      >
                        {t("executionRefresh")}
                      </Button>
                    ) : null}
                  </div>
                )
              ) : (
                <>
                  {conversation &&
                  !sessionReadOnly &&
                  !channelConversation &&
                  controlAgent ? (
                    <AgentConversation
                      key={conversation.id}
                      activeConversationId={conversation.id}
                      agentId={controlAgent.id}
                      agentName={controlAgent.name}
                      settingsHref={agentSettingsHref(
                        slug,
                        controlAgent.id,
                        workReturnTo,
                      )}
                      composerNotice={(
                        setEditorText,
                        widgetTarget,
                        renderedActivityIds,
                      ) => (
                        <ConversationExecution
                          key={`${controlAgent.id}:${conversation.id}`}
                          endpoint={`/api/v1/agents/${encodeURIComponent(controlAgent.id)}/conversations/${encodeURIComponent(conversation.id)}/execution`}
                          toolApprovalEndpoint={approvalEndpoint}
                          toolApprovalParts={approvalParts}
                          showStatus={false}
                          showActivities={false}
                          active={conversationBusy}
                          onSetEditorText={setEditorText}
                          belowEditorElement={widgetTarget}
                          renderedActivityIds={renderedActivityIds}
                          className="mb-3"
                          onChange={() => router.refresh()}
                          onOpenScreen={hasScreen ? openScreen : undefined}
                          onTakeoverRequest={openTakeoverScreen}
                          onTakeoverAnswered={releaseScreenControl}
                        />
                      )}
                      ready={!sessionReadOnly}
                      runtimeKind={conversation.runtimeKind ?? null}
                      agentRevisionVersion={conversation.agentRevisionVersion}
                      currentRevisionVersion={
                        controlAgent.currentRevisionVersion
                      }
                      mcpToolsUpdated={controlAgent.mcpToolsUpdated}
                      modelName={conversation.modelName}
                      modelOverride={modelChoices[composerScope] ?? null}
                      modelPicker={
                        <ComposerModelSelect
                          providers={providers}
                          defaultSelection={defaultModelSelection}
                          value={modelChoices[composerScope] ?? null}
                          onChange={(value) =>
                            setModelChoices((choices) => ({
                              ...choices,
                              [composerScope]: value,
                            }))
                          }
                        />
                      }
                      initialMessages={
                        conversation.messages.filter(
                          (message) => !messageCompaction(message),
                        ) as AgentUIMessage[]
                      }
                      initialReasoningEffort={
                        conversation.reasoningEffort ?? "default"
                      }
                      reasoningAvailable={reasoningAvailable}
                      inheritedReasoningEffort={
                        controlAgent.reasoningEffort ?? null
                      }
                      creatingConversation={false}
                      ensureConversation={async () => conversation.id}
                      attachmentUploadUrl={`/api/v1/workspaces/${workspaceId}/attachments`}
                      mcpPromptApiPath={`/api/v1/agents/${controlAgent.id}/prompts`}
                      mcpResourceApiPath={`/api/v1/agents/${controlAgent.id}/composer`}
                      onBusyChange={setConversationBusy}
                      onConversationChanged={() => router.refresh()}
                    />
                  ) : (
                    <MessageScroller
                      key={selected?.id ?? conversation?.id ?? "new"}
                      label={t("title")}
                      data-ui="work.transcript"
                      busy={
                        selectedActive || Boolean(conversationOutput?.active)
                      }
                      followOutput={followingOutput}
                      onFollowChange={setFollowingOutput}
                      navigation="rail"
                      className={
                        selected || conversation
                          ? "min-h-0 flex-1"
                          : "mt-auto min-h-0 flex-none"
                      }
                    >
                      {selected || conversation ? (
                        <>
                          <WorkTranscript
                            workspaceSlug={slug}
                            treeActionsEnabled={Boolean(
                              selected &&
                                !sessionReadOnly &&
                                selected.runtimeKind === "pi-sdk",
                            )}
                            treeActionsDisabled={
                              selectedActive ||
                              Boolean(busy) ||
                              composerPending ||
                              !MESSAGEABLE_STATUSES.has(selected?.status ?? "")
                            }
                            treeActionPending={busy === "tree"}
                            onTreeAction={mutateConversationTree}
                            agentName={controlAgent?.name ?? t("agent")}
                            agentId={conversation?.agentId ?? selected?.agentId}
                            conversationId={
                              conversation?.id ?? selected?.conversationId
                            }
                            modelName={
                              conversation?.modelOverride?.model ??
                              conversation?.modelName ??
                              selected?.modelName ??
                              null
                            }
                            messages={
                              conversationAccessRevoked
                                ? []
                                : (conversation?.messages ??
                                  selected?.messages ??
                                  [])
                            }
                            streamText={streamText}
                            streamActivities={streamActivities}
                            streamBudgetWarning={streamBudgetWarning}
                            streamRuleTriggers={streamRuleTriggers}
                            streamStartedAt={streamStartedAt}
                            streamRuntimeKind={streamRuntimeKind}
                            streamModelName={streamModelName}
                            executionStage={executionStage}
                            sessionStartedAt={selected?.startedAt}
                            sessionCompletedAt={selected?.completedAt}
                            streaming={selectedActive}
                          />
                          {observingConversation &&
                          !conversationAccessRevoked &&
                          conversationOutput &&
                          !conversationOutputPersisted ? (
                            <div className="mx-auto w-full max-w-3xl px-4 pb-8 sm:px-6">
                              <LiveOutputView output={conversationOutput} />
                            </div>
                          ) : null}
                          {selected?.artifacts.length ? (
                            <section className="mx-auto w-full max-w-3xl px-4 py-5">
                              <p className="flex items-center gap-2 text-xs font-semibold">
                                <FileOutput className="size-4" />
                                {t("artifacts")}
                              </p>
                              <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                                {selected.artifacts.map((artifact) => (
                                  <li key={artifact}>{artifact}</li>
                                ))}
                              </ul>
                            </section>
                          ) : null}
                        </>
                      ) : (
                        <div className="flex items-center justify-center px-6 pb-7 pt-10 text-center">
                          <div className="max-w-lg">
                            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground ring-1 ring-border/50">
                              <Bot className="size-6" />
                            </span>
                            {agent ? (
                              <p className="mt-4 text-sm font-medium text-muted-foreground">
                                {agent.name}
                              </p>
                            ) : null}
                            <h2 className="mt-2 text-2xl font-medium tracking-tight sm:text-3xl">
                              {t("emptyTitle")}
                            </h2>
                            {agent?.description &&
                            agent.description.trim() !== agent.name.trim() ? (
                              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                                {agent.description}
                              </p>
                            ) : null}
                            {agent?.mcpToolsUpdated ? (
                              <McpToolsUpdatedNote {...agent.mcpToolsUpdated} />
                            ) : null}
                          </div>
                        </div>
                      )}
                      {visibleError && !configurationError ? (
                        <div
                          role="alert"
                          className="mx-auto my-4 w-[calc(100%_-_2rem)] max-w-[736px] rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
                        >
                          {runtimeError ? runtimeError.text : visibleError}
                          {runtimeError?.code === "PI_MCP_TOOLS_UNAVAILABLE" &&
                          controlAgent ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="ml-3 rounded-full"
                              onClick={() =>
                                router.push(
                                  agentSettingsHref(
                                    slug,
                                    controlAgent.id,
                                    workReturnTo,
                                    "mcp",
                                  ),
                                )
                              }
                            >
                              {tAgents("configureAgent")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </MessageScroller>
                  )}
                </>
              )}
              {conversation &&
              channelConversation &&
              !conversationAccessRevoked ? (
                <ConversationExecution
                  key={`${conversation.agentId}:${conversation.id}`}
                  endpoint={`/api/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversation.id)}/execution`}
                  toolApprovalEndpoint={approvalEndpoint}
                  toolApprovalParts={approvalParts}
                  showStatus
                  showActivities={false}
                  onBusyChange={setConversationBusy}
                  renderedActivityIds={renderedHookIds}
                  settingsHref={agentSettingsHref(
                    slug,
                    conversation.agentId,
                    workReturnTo,
                    "mcp",
                  )}
                  className={conversationComposerDockClassName}
                  onChange={() => router.refresh()}
                  onOpenScreen={hasScreen ? openScreen : undefined}
                  onTakeoverRequest={openTakeoverScreen}
                  onTakeoverAnswered={releaseScreenControl}
                />
              ) : null}
              {providers.length > 0 && unappliedDraft && agent ? (
                <div
                  role="status"
                  className="mx-auto mb-2 flex w-[calc(100%_-_2rem)] max-w-[736px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm"
                >
                  <p className="text-muted-foreground">
                    {t("agentDraftUnapplied")}
                  </p>
                  <Button
                    onClick={() =>
                      router.push(
                        agentSettingsHref(slug, agent.id, workReturnTo),
                      )
                    }
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                  >
                    {t("agentDraftReview")}
                  </Button>
                </div>
              ) : null}
              {!providers.length ? (
                <ModelProviderNotice
                  slug={slug}
                  className="mx-auto mb-2 w-[calc(100%_-_2rem)] max-w-[736px]"
                />
              ) : showConfigurationNotice && controlAgent ? (
                <div
                  role="alert"
                  className="mx-auto mb-2 flex w-[calc(100%_-_2rem)] max-w-[736px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm"
                >
                  <span className="text-muted-foreground">
                    {t("configureAgent")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() =>
                      router.push(
                        agentSettingsHref(slug, controlAgent.id, workReturnTo),
                      )
                    }
                  >
                    {tAgents("configureAgent")}
                  </Button>
                </div>
              ) : null}

              {!viewingA2A &&
                !conversation &&
                (!sessionReadOnly || selectedActive) && (
                  <div
                    className={`${conversationComposerDockClassName} ${!selected ? "mb-auto before:hidden" : ""} ${showConfigurationNotice || unappliedDraft ? "before:hidden" : ""}`}
                  >
                    <div>
                      {selected && !sessionReadOnly ? (
                        <ConversationExecution
                          key={selected.id}
                          endpoint={`/api/v1/workspaces/${encodeURIComponent(slug)}/work-sessions/${encodeURIComponent(selected.id)}/ui`}
                          toolApprovalEndpoint={approvalEndpoint}
                          toolApprovalParts={approvalParts}
                          showStatus={false}
                          showActivities={false}
                          active={selectedActive}
                          onSetEditorText={setDraft}
                          belowEditorElement={belowEditorElement}
                          renderedActivityIds={renderedHookIds}
                          onChange={() => void refreshSelected()}
                          onOpenScreen={hasScreen ? openScreen : undefined}
                          onTakeoverRequest={openTakeoverScreen}
                          onTakeoverAnswered={releaseScreenControl}
                          className="mb-3"
                        />
                      ) : null}
                      <AgentMessageQueueView
                        queue={messageQueue.queue}
                        onClear={() => void messageQueue.clear()}
                        disabled={
                          messageQueue.pending ||
                          messageQueue.forbidden ||
                          sessionReadOnly
                        }
                      />
                      <WorkComposer
                        key={composerScope}
                        agentId={controlAgent?.id}
                        sandboxId={controlSandbox?.id}
                        workSessionId={selected?.id}
                        conversationId={selected?.conversationId}
                        commands={commands}
                        draft={draft}
                        onDraftChange={setDraft}
                        attachments={attachments}
                        onAttachmentsChange={setAttachments}
                        references={references}
                        onReferencesChange={(items) =>
                          setReferenceSelection({ scope: composerScope, items })
                        }
                        supportsAttachments={
                          !sessionReadOnly &&
                          (selected
                            ? controlSandbox?.kind
                            : activeSandbox?.kind) === "docker"
                        }
                        onError={setError}
                        onPendingChange={setComposerPending}
                        waitingQuestion={selected?.waitingQuestion}
                        toolbarStart={null}
                        disabled={
                          sessionReadOnly ||
                          unappliedDraft ||
                          Boolean(busy) ||
                          messageQueue.forbidden ||
                          (!canSend && !selectedActive && !localCommand) ||
                          composerPending
                        }
                        loading={running && !messageQueue.fallback}
                        onRunningSubmit={
                          selectedActive && !messageQueue.fallback
                            ? (mode) => void sendQueuedMessage(mode)
                            : undefined
                        }
                        queuePending={messageQueue.pending}
                        onStop={
                          selected && busy !== "cancel"
                            ? () => void postAction("cancel")
                            : undefined
                        }
                        onSubmit={() => void sendMessage()}
                        toolbarEnd={
                          <>
                            <ConversationContextUsage
                              busy={running}
                              usage={contextUsage}
                            />
                            <ComposerModelSelect
                              providers={providers}
                              defaultSelection={defaultModelSelection}
                              value={modelChoices[composerScope] ?? null}
                              onChange={(value) =>
                                setModelChoices((choices) => ({
                                  ...choices,
                                  [composerScope]: value,
                                }))
                              }
                            />
                            {reasoningAvailable && (
                              <ReasoningEffortControl
                                value={reasoningEffort}
                                inherited={
                                  controlAgent?.reasoningEffort ?? null
                                }
                                disabled={
                                  sessionReadOnly ||
                                  unappliedDraft ||
                                  Boolean(busy) ||
                                  running ||
                                  composerPending
                                }
                                onChange={(value) =>
                                  setReasoningChoices((choices) => ({
                                    ...choices,
                                    [composerScope]: value,
                                  }))
                                }
                              />
                            )}
                          </>
                        }
                      />
                      <div
                        ref={setBelowEditorElement}
                        className="space-y-3 empty:hidden"
                      />
                      {!selected && agent?.ready && !sandboxOptions.length ? (
                        <p className="px-3 pt-3 text-center text-[11px] text-muted-foreground">
                          {t("attachSandbox")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}
            </main>
          </AnimatedSidebarInset>

          {workspacePanelOpen ? (
            <aside className="hidden w-96 shrink-0 min-h-0 overflow-hidden bg-background xl:block">
              {desktopPanel === "screen" && controlSandbox && hasScreen ? (
                <SandboxScreen
                  key={controlSandbox.id}
                  workspace={slug}
                  sandboxId={controlSandbox.id}
                  displays={displays}
                  running={controlSandbox.running}
                  controlRequest={controlRequest}
                  releaseRequest={screenReleaseRequest}
                />
              ) : controlSandbox && !workspacePending ? (
                <SandboxConsole
                  key={`${conversation?.id ?? selected?.id ?? "new"}:${controlSandbox.id}`}
                  compact
                  filesOnly={desktopPanel === "files"}
                  readOnly={sessionReadOnly}
                  terminalOnly={desktopPanel === "terminal"}
                  deploymentId={controlSandbox.deploymentId}
                  running={controlSandbox.running}
                  initialPath={activeWorkingDirectory}
                  initialEntries={[]}
                  terminalLabel={controlSandbox.name}
                  terminalSubtitle={t("sandboxSubtitle")}
                  workspaceRoot={controlWorkspaceRoot}
                  rpcApiBase={workspaceRpcApiBase}
                  terminalApiBase={workspaceTerminalApiBase}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Boxes className="mr-2 size-4" />
                  {workspaceUnavailableLabel}
                </div>
              )}
            </aside>
          ) : null}
        </div>

        {!viewingA2A &&
        mobilePanel &&
        (mobilePanel !== "screen" || hasScreen) ? (
          <CenterMorphModal
            open={Boolean(mobilePanel)}
            onOpenChange={(open) => {
              if (!open) setMobilePanel(null);
            }}
          >
            <CenterMorphModalContent
              ariaLabel={
                mobilePanel === "files"
                  ? tSandboxes("files")
                  : mobilePanel === "screen"
                    ? tSandboxes("screen")
                    : tSandboxes("terminal")
              }
              closeButtonLabel={t("closeWorkspace")}
              className="flex h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col"
            >
              <DialogHeader
                title={
                  mobilePanel === "files"
                    ? tSandboxes("files")
                    : mobilePanel === "screen"
                      ? tSandboxes("screen")
                      : tSandboxes("terminal")
                }
                icon={
                  mobilePanel === "files" ? (
                    <Folder className="size-4" />
                  ) : mobilePanel === "screen" ? (
                    <Monitor className="size-4" />
                  ) : (
                    <TerminalSquare className="size-4" />
                  )
                }
              />
              <div className="min-h-0 flex-1 overflow-hidden">
                {mobilePanel === "screen" && controlSandbox && hasScreen ? (
                  <SandboxScreen
                    key={controlSandbox.id}
                    workspace={slug}
                    sandboxId={controlSandbox.id}
                    displays={displays}
                    running={controlSandbox.running}
                    controlRequest={controlRequest}
                    releaseRequest={screenReleaseRequest}
                  />
                ) : controlSandbox && !workspacePending ? (
                  <SandboxConsole
                    key={`${conversation?.id ?? selected?.id ?? "new"}:${controlSandbox.id}`}
                    compact
                    filesOnly={mobilePanel === "files"}
                    readOnly={sessionReadOnly}
                    terminalOnly={mobilePanel === "terminal"}
                    deploymentId={controlSandbox.deploymentId}
                    running={controlSandbox.running}
                    initialPath={activeWorkingDirectory}
                    initialEntries={[]}
                    terminalLabel={controlSandbox.name}
                    terminalSubtitle={t("sandboxSubtitle")}
                    workspaceRoot={controlWorkspaceRoot}
                    rpcApiBase={workspaceRpcApiBase}
                    terminalApiBase={workspaceTerminalApiBase}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    <Boxes className="mr-2 size-4" />
                    {workspaceUnavailableLabel}
                  </div>
                )}
              </div>
            </CenterMorphModalContent>
          </CenterMorphModal>
        ) : null}

        <SidebarGroupDialog
          initialName={groupEditor?.name ?? ""}
          open={Boolean(groupEditor)}
          title={t(groupEditor?.id ? "renameGroup" : "newGroup")}
          nameLabel={t("groupName")}
          placeholder={t("groupNamePlaceholder")}
          cancelLabel={common("cancel")}
          submitLabel={groupEditor?.id ? common("save") : common("create")}
          onClose={() => setGroupEditor(null)}
          onSubmit={saveAgentGroup}
        />

        <ConversationExportDialog
          key={exportConversationTarget?.id ?? "closed"}
          target={exportConversationTarget}
          onClose={() => setExportConversationTarget(null)}
        />

        <CenterMorphModal
          open={Boolean(deleteConversationTarget)}
          onOpenChange={(open) => {
            if (!open && !deleteConversationPending)
              setDeleteConversationTarget(null);
          }}
        >
          <CenterMorphModalContent
            ariaLabel={
              deleteConversationTarget?.workSessionId
                ? t("deleteConversation")
                : tAgents("deleteConversation")
            }
            closeButtonLabel={tAgents("close")}
            className="max-w-md"
          >
            <DialogHeader
              title={
                deleteConversationTarget?.workSessionId
                  ? t("deleteConversation")
                  : tAgents("deleteConversation")
              }
            />
            <DialogBody>
              <p className="text-sm text-muted-foreground">
                {deleteConversationTarget?.workSessionId
                  ? t("deleteConversationDescription")
                  : tAgents("deleteConversationDescription")}
              </p>
              {deleteConversationError ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {deleteConversationError}
                </p>
              ) : null}
            </DialogBody>
            <form
              action={async (formData) => {
                if (!deleteConversationTarget || deleteConversationPending)
                  return;
                const target = deleteConversationTarget;
                setDeleteConversationPending(true);
                setDeleteConversationError("");
                try {
                  if (target.workSessionId) {
                    await deleteWorkConversation({
                      ...target,
                      workSessionId: target.workSessionId,
                    });
                  } else {
                    const result = await deleteConversationAction(formData);
                    if (result.error) setDeleteConversationError(result.error);
                  }
                } catch (cause) {
                  unstable_rethrow(cause);
                  setDeleteConversationError(
                    cause instanceof Error
                      ? cause.message
                      : operationsT("failed"),
                  );
                } finally {
                  setDeleteConversationPending(false);
                }
              }}
            >
              <input type="hidden" name="workspace" value={slug} />
              <input
                type="hidden"
                name="agentId"
                value={deleteConversationTarget?.agentId ?? ""}
              />
              <input
                type="hidden"
                name="conversationId"
                value={deleteConversationTarget?.id ?? ""}
              />
              <DialogFooter cancel={<DialogCancel />}>
                <SubmitButton
                  size="md"
                  variant="primary"
                  className="bg-destructive text-white hover:bg-destructive/90"
                  pendingLabel={tAgents("deleting")}
                  error={deleteConversationError}
                  flash={false}
                >
                  {tAgents("confirmDelete")}
                </SubmitButton>
              </DialogFooter>
            </form>
          </CenterMorphModalContent>
        </CenterMorphModal>

        <CenterMorphModal
          open={Boolean(deleteAgentTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteAgentTarget(null);
          }}
        >
          <CenterMorphModalContent
            ariaLabel={tAgents("deleteAgent")}
            closeButtonLabel={tAgents("close")}
            className="max-w-md"
          >
            <DialogHeader title={tAgents("deleteAgent")} />
            <DialogBody>
              <p className="text-sm text-muted-foreground">
                {tAgents(
                  "deleteThisAgentAndItsSandboxesAndAllItsConversations",
                )}
              </p>
            </DialogBody>
            <form action={deleteAgentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input
                type="hidden"
                name="agentId"
                value={deleteAgentTarget?.id ?? ""}
              />
              <input
                type="hidden"
                name="returnTo"
                value={`/app/${slug}/work`}
              />
              <DialogFooter cancel={<DialogCancel />}>
                <SubmitButton
                  size="md"
                  variant="primary"
                  className="bg-destructive text-white hover:bg-destructive/90"
                  pendingLabel={tAgents("deleting")}
                >
                  {tAgents("confirmDelete")}
                </SubmitButton>
              </DialogFooter>
            </form>
          </CenterMorphModalContent>
        </CenterMorphModal>
      </ChatApp>
    </SubagentConversationScope.Provider>
  );
}
