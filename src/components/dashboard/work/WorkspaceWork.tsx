"use client";
import { SidebarToolbar } from "@/components/dashboard/SidebarToolbar";
import { useSidebarScroll } from "@/components/dashboard/useSidebarScroll";

import { Button } from "@/components/motion/button";

import { useRouter } from "next/navigation";
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
  Pin,
  PanelLeft,
  TerminalSquare,
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
import { AgentPromptProvenance } from "@/components/dashboard/agents/AgentPromptProvenance";
import {
  ConversationContextUsage,
  conversationComposerDockClassName,
} from "@/components/dashboard/ConversationComposer";
import { WorkComposer } from "./WorkComposer";
import { ConversationExecution } from "./ConversationExecution";
import { createWorkCompletionTransition } from "./completion-transition";
import { useWorkCompletionNotification } from "./useWorkCompletionNotification";
import {
  ComposerModelSelect,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/ComposerModelSelect";
import type { ComposerReference } from "@/lib/work/composer-types";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { SidebarGroupDialog } from "@/components/dashboard/SidebarGroupDialog";
import { sidebarHoverActionsClassName } from "@/components/dashboard/sidebarHoverActions";
import {
  AssistantMarkdown,
  ConversationMessageShell,
  conversationUserBubbleClassName,
  ConversationActivity,
  ToolPayload,
  toolOutputText,
  toolResultUnboundedHeight,
} from "@/components/dashboard/ConversationMessage";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
  MessageGroup,
} from "@/components/agents/message";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { MessageScroller } from "@/components/agents/message-scroller";
import { ToolResult } from "@/components/agents/tool-result";
import { SandboxConsole } from "@/components/dashboard/sandboxes/SandboxConsole";
import { resolveContextUsage } from "@/lib/context-usage";
import { deleteAgentAction, pinAgentAction } from "@/lib/agents/actions";
import type { ReasoningEffort } from "@/lib/agents/constants";
import {
  SubagentActivity,
  type SubagentSource,
} from "../agents/SubagentActivity";
import { HookActivity, HookActivitySchema } from "../agents/HookActivity";
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
  input?: unknown;
  output?: unknown;
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
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  source?: SubagentSource;
};

type WorkMessage = {
  id: string;
  role: string;
  createdAt?: string;
  parts: WorkPart[];
};
type ConversationSummary = {
  id: string;
  agentId: string;
  title?: string | null;
  source: ParsedMessagingSession | null;
};
type ConversationDetail = ConversationSummary & {
  sandbox?: WorkItem["sandbox"];
  runtimeKind?: string;
  modelName?: string | null;
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
  channels: Array<ConversationSummary & { label: string }>;
};
type WorkTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  approvalWaitMs?: number;
  runtimeKind?: string;
  modelName?: string;
};

type WorkPanel = "files" | "terminal";

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
const ARCHIVABLE_STATUSES = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];
const EMPTY_EXPANDED_AGENTS: Record<string, boolean> = {};
const UNGROUPED_SIDEBAR_GROUP_ID = "__ungrouped__";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
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

function runtimeLabel(kind: string | null | undefined): string {
  if (kind === "pi-sdk") return "Pi";
  if (kind === "omp") return "OMP";
  if (kind === "claude-code") return "Claude Code";
  if (kind === "dsh") return "DeepSeek Harness";
  return kind === "pi" ? "Pi" : "—";
}

function formatWorkDuration(durationMs: number | undefined): string | null {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
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

function workToolLabel(
  part: Pick<WorkPart, "deploymentName" | "originalToolName" | "toolName">,
): string {
  if (part.deploymentName && part.originalToolName)
    return `${part.deploymentName} · ${part.originalToolName}`;
  return part.originalToolName ?? part.toolName ?? "Tool";
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

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 20_000
      ? `${text.slice(0, 20_000)}\n[truncated]`
      : text;
  } catch {
    return String(value);
  }
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
  agentName,
  modelName: fallbackModelName,
  messages,
  streamText,
  streamActivities,
  streamStartedAt,
  streamRuntimeKind,
  streamModelName,
  executionStage,
  sessionStartedAt,
  sessionCompletedAt,
  streaming,
}: {
  agentName: string;
  modelName?: string | null;
  messages: WorkMessage[];
  streamText: string;
  streamActivities: WorkActivity[];
  streamStartedAt?: number;
  streamRuntimeKind?: string;
  streamModelName?: string;
  executionStage: AgentExecutionStage;
  sessionStartedAt?: string | null;
  sessionCompletedAt?: string | null;
  streaming: boolean;
}) {
  const t = useTranslations("console.work");
  const agentsT = useTranslations("console.agents");
  const common = useTranslations("common");
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";
  const streamPersisted =
    streamStartedAt !== undefined &&
    messages.some(
      (message) =>
        (message.role === "assistant" || isConversationControl(message)) &&
        messageWorkTiming(message)?.startedAt === streamStartedAt,
    );
  const transcript =
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
              ...streamActivities.map((activity): WorkPart => {
                if (activity.type === "tool") {
                  return {
                    type: "work-tool",
                    source: activity.source,
                    toolCallId: activity.toolCallId,
                    toolName: activity.toolName,
                    deploymentName: activity.deploymentName,
                    originalToolName: activity.originalToolName,
                    durationMs: activity.durationMs,
                    input: activity.input,
                    output: activity.output,
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
                  };
                }
                return {
                  type: "work-runtime",
                  source: activity.source,
                  runtimeKind: activity.runtimeKind,
                  status: activity.status,
                };
              }),
              ...(streamText ? [{ type: "text", text: streamText }] : []),
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
    <MessageGroup
      spacing="default"
      className="mx-auto w-full max-w-3xl gap-6 px-4 py-8 sm:px-6"
    >
      {transcript.map((message, messageIndex) => {
        if (messageCompaction(message))
          return <CompactionNote key={message.id} message={message} />;
        const isStreamingMessage = message.id === "work-stream";
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
            .join("\n") ||
          (typeof commandResult?.text === "string" ? commandResult.text : "");
        const text =
          message.role === "user"
            ? displayMessagingUserText(rawText)
            : isStreamingMessage
              ? rawText
              : rawText.trim();
        const hookRecords = message.parts.flatMap((part) => {
          if (
            part.type !== "hook-activity" &&
            part.type !== "data-hook-activity"
          )
            return [];
          const parsed = HookActivitySchema.safeParse(part.data);
          return parsed.success ? [parsed.data] : [];
        });
        const processParts = message.parts
          .filter(
            (part) =>
              part.type === "reasoning" ||
              part.type === "work-tool" ||
              (part.type === "work-runtime" &&
                (part.status === "failed" || part.status === "cancelled")),
          )
          .map(
            (part): WorkPart =>
              !isStreamingMessage && part.status === "running"
                ? {
                    ...part,
                    status:
                      part.type === "reasoning" ? "completed" : "cancelled",
                  }
                : part,
          );
        const visibleProcessParts = processParts.filter(
          (part) =>
            part.type !== "work-runtime" ||
            !isStreamingMessage ||
            part.status !== "running",
        );
        const processFailed = visibleProcessParts.some(
          (part) => part.isError || part.status === "failed",
        );
        const processCancelled = visibleProcessParts.some(
          (part) => part.status === "cancelled",
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
                      @{part.reference.label}
                    </summary>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                      {part.text}
                    </pre>
                  </details>
                ) : null,
              )}
            {message.role !== "user" &&
            (isStreamingMessage || visibleProcessParts.length) ? (
              <div data-ui="work-process" className="w-full">
                <ConversationActivity
                  status={isStreamingMessage ? "working" : "complete"}
                  defaultOpen={processFailed || processCancelled}
                  collapseOnComplete={!processFailed && !processCancelled}
                  activeLabel={
                    <>
                      {t(executionStageKeys[executionStage])}{" "}
                      <WorkElapsed
                        timing={messageTiming}
                        live
                        dataUi="work-process-duration"
                      />
                    </>
                  }
                  summary={
                    <>
                      {isStreamingMessage
                        ? t(executionStageKeys[executionStage])
                        : processFailed
                          ? t("processFailed")
                          : processCancelled
                            ? t("processCancelled")
                            : t("processed")}{" "}
                      <WorkElapsed
                        timing={messageTiming}
                        live={isStreamingMessage}
                        dataUi="work-process-duration"
                      />
                    </>
                  }
                  items={visibleProcessParts.map((part, index) => ({
                    id: part.toolCallId ?? `${message.id}:${index}`,
                    type: "text" as const,
                    content: part.source ? (
                      <SubagentActivity
                        value={{
                          ...part,
                          type:
                            part.type === "reasoning" ? "reasoning" : "tool",
                        }}
                      />
                    ) : part.type === "reasoning" ? (
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {part.status === "running"
                            ? t("thinking")
                            : t("thought")}
                        </p>
                        <pre className="whitespace-pre-wrap break-words text-xs">
                          {part.text}
                        </pre>
                      </div>
                    ) : part.type === "work-runtime" ? (
                      <p className="text-xs text-muted-foreground">
                        {part.status === "cancelled"
                          ? t("runtimeCancelled", {
                              runtime: runtimeLabel(part.runtimeKind),
                            })
                          : runtimeLabel(part.runtimeKind)}
                      </p>
                    ) : (
                      <ToolResult
                        className="rounded-xl border-border/60 bg-background"
                        tool={workToolLabel(part)}
                        title={
                          part.status === "running"
                            ? t("toolRunning")
                            : part.isError || part.status === "failed"
                              ? t("toolFailed")
                              : part.status === "cancelled"
                                ? t("toolCancelled")
                                : t("toolCompleted")
                        }
                        status={
                          part.isError || part.status === "failed"
                            ? "error"
                            : part.status === "cancelled"
                              ? "cancelled"
                              : part.status === "running"
                                ? "running"
                                : "success"
                        }
                        meta={formatWorkDuration(part.durationMs)}
                        defaultOpen={
                          part.status === "running" ||
                          part.isError ||
                          part.status === "failed"
                        }
                        copyText={
                          part.output === undefined
                            ? undefined
                            : (toolOutputText(part.output) ??
                              formatValue(part.output))
                        }
                        maxHeight={toolResultUnboundedHeight}
                      >
                        <ToolPayload
                          label={agentsT("toolInput")}
                          language="json"
                        >
                          {formatValue(part.input)}
                        </ToolPayload>
                        {part.output !== undefined ? (
                          <ToolPayload
                            label={agentsT("toolOutput")}
                            language={
                              toolOutputText(part.output) !== undefined
                                ? "text"
                                : "json"
                            }
                          >
                            {toolOutputText(part.output) ??
                              formatValue(part.output)}
                          </ToolPayload>
                        ) : null}
                      </ToolResult>
                    ),
                  }))}
                />
              </div>
            ) : null}
            {hookRecords.map((hook) => (
              <HookActivity key={hook.id} value={hook} />
            ))}
            {text ? (
              message.role === "user" ? (
                <span className="whitespace-pre-wrap">{text}</span>
              ) : (
                <AssistantMarkdown text={text} streaming={isStreamingMessage} />
              )
            ) : null}
          </>
        );
        const showIdentity =
          messageIndex === 0 ||
          transcript[messageIndex - 1]?.role !== "assistant";
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
              <WorkElapsed
                timing={messageTiming}
                live={isStreamingMessage}
                dataUi="work-message-duration"
              />
            </div>
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
                copyText={text}
                announce={false}
                actionsClassName={actionVisibility}
              >
                {messageBody}
              </StreamingResponse>
            )}
            {message.role === "user" && text ? (
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
                <CopyButton
                  text={text}
                  label={common("copy")}
                  iconOnly
                  className={messageActionClassName}
                />
              </MessageFooter>
            ) : null}
          </ConversationMessageShell>
        );
      })}
    </MessageGroup>
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
  conversations = [],
  selectedConversation = null,
  hasChannels = false,
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
  conversations?: ConversationSummary[];
  selectedConversation?: ConversationDetail | null;
  hasChannels?: boolean;
  initialExpandedAgents?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const tChannels = useTranslations("console.agentMessaging");
  const operationsT = useTranslations("console.conversationOperations");
  const tSandboxes = useTranslations("console.sandboxes");
  const common = useTranslations("common");
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
  // Server lists are authoritative after navigation/refresh; optimistic
  // entries survive until the server returns them.
  const [syncedSessions, setSyncedSessions] = useState(sessions);
  if (syncedSessions !== sessions) {
    setSyncedSessions(sessions);
    setItems((current) => {
      const known = new Set(sessions.map((item) => item.id));
      return [
        ...current.filter((item) => item.optimistic && !known.has(item.id)),
        ...sessions,
      ];
    });
  }
  const [liveSelected, setLiveSelected] = useState<WorkItem | null>(null);
  const selectionKey = selectedConversation?.id ?? selectedWorkSessionId;
  const [draftSelectionKey, setDraftSelectionKey] = useState<string | null>(
    null,
  );
  if (draftSelectionKey && draftSelectionKey !== selectionKey)
    setDraftSelectionKey(null);
  const creatingMode = !selectionKey || draftSelectionKey === selectionKey;
  const conversation = creatingMode ? null : selectedConversation;
  const [conversationBusy, setConversationBusy] = useState(false);
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
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
    creatingMode || conversation
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
  const [groupEditor, setGroupEditor] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [modelChoices, setModelChoices] = useState<
    Record<string, ModelSelection | null>
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
  const [desktopPanel, setDesktopPanel] = useState<WorkPanel | null>(null);
  const [mobilePanel, setMobilePanel] = useState<WorkPanel | null>(null);
  const [streamOutput, setStreamOutput] = useState<{
    workSessionId: string;
    text: string;
    activities: WorkActivity[];
    startedAt?: number;
    runtimeKind?: string;
    modelName?: string;
    executionStage?: AgentExecutionStage;
  }>({ workSessionId: "", text: "", activities: [] });
  const agent = useMemo(
    () => agents.find((item) => item.id === agentId) ?? null,
    [agents, agentId],
  );
  const selectedAgent =
    selected || conversation
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
  const references =
    referenceSelection.scope === composerScope ? referenceSelection.items : [];
  const commandRuntimeKind = conversation
    ? (conversation.runtimeKind ?? "")
    : selected
      ? selected.runtimeKind
      : (controlAgent?.runtimeKind ?? "");
  const sessionReadOnly = conversation
    ? conversation.readOnly ||
      !isExecutableAgentRuntimeKind(conversation.runtimeKind)
    : selected
      ? selected.readOnly !== false ||
        !isExecutableAgentRuntimeKind(selected.runtimeKind)
      : !isExecutableAgentRuntimeKind(controlAgent?.runtimeKind);
  // Channel history is written by its channel; the console only observes it
  // and answers native extension dialogs.
  const channelConversation = Boolean(conversation?.source);
  const unappliedDraft = Boolean(
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
  const workReturnTo = conversation
    ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversation.agentId)}&c=${encodeURIComponent(conversation.id)}`
    : selected
      ? workHref(slug, selected.id)
      : `/app/${encodeURIComponent(slug)}/work`;
  const selectedStatus = selected?.status;
  const visibleError = error ?? selected?.error;
  const describeRuntimeError = useRuntimeErrorText();
  const runtimeError = describeRuntimeError(visibleError);
  const configurationError = /no configured model/i.test(visibleError ?? "");
  const showConfigurationNotice =
    configurationError ||
    (!selected && !conversation && agent && !agent.ready && !unappliedDraft);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes reset the existing provisioning poll.
  useEffect(() => {
    if (
      selected ||
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
    selected,
    conversation,
  ]);

  useEffect(() => {
    if ((!hasChannels && !conversation?.readOnly) || conversationBusy) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasChannels, conversation?.readOnly, conversationBusy, router]);

  const streamText =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.text
      : "";
  const streamActivities =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.activities
      : EMPTY_WORK_ACTIVITIES;
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
  const sessionModelName = conversation?.modelName ?? selected?.modelName;
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
  const workspacePanelOpen = Boolean(desktopPanel);

  const activeAgentId = conversation?.agentId ?? selected?.agentId ?? agentId;
  const visibleAgents = useMemo<WorkSidebarAgent[]>(
    () =>
      sortSidebarItems(agents, groupPreferences.entityOrder).map((item) => {
        const order = groupPreferences.conversationOrder?.[item.id];
        const agentSessions = sortSidebarItems(
          items.filter((session) => session.agentId === item.id),
          order,
        );
        const agentChannels = sortSidebarItems(
          conversations.filter((entry) => entry.agentId === item.id),
          order,
        ).map((entry) => {
          if (!entry.source)
            return { ...entry, label: entry.title || tAgents("newChat") };
          const { platform, chatId } = entry.source;
          const platformLabel = tChannels.has(`platforms.${platform}`)
            ? tChannels(`platforms.${platform}`)
            : platform;
          return { ...entry, label: `${platformLabel} · ${chatId}` };
        });
        return {
          agent: item,
          sessions: agentSessions,
          channels: agentChannels,
        };
      }),
    [
      agents,
      items,
      conversations,
      groupPreferences.entityOrder,
      groupPreferences.conversationOrder,
      tChannels,
      tAgents,
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
        ({ agent: itemAgent, sessions: agentSessions, channels }) => ({
          id: `agent:${itemAgent.id}`,
          label: itemAgent.name,
          kind: "project",
          children: [
            ...agentSessions.map((item) => ({
              id: `session:${item.id}`,
              label: item.title || item.task || t("untitled"),
              kind: "file" as const,
            })),
            ...channels.map((item) => ({
              id: `conversation:${item.id}`,
              label: item.label,
              kind: "bookmark" as const,
            })),
          ],
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
  }, [groupPreferences.groups.length, groupedAgents, t, visibleAgents]);
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
  const activeResourceId = conversation
    ? `conversation:${conversation.id}`
    : selected
      ? `session:${selected.id}`
      : null;

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
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
        executionStage?: AgentExecutionStage;
      }>(event);
      if (!next) return;
      completion.observe("snapshot", next);
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: next.text ?? "",
        activities: Array.isArray(next.activities) ? next.activities : [],
        executionStage: next.executionStage,
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
    });
    source.addEventListener("stage", (event) => {
      const next = payload<{ executionStage?: AgentExecutionStage }>(event);
      if (!next) return;
      setStreamOutput((current) => ({
        ...(current.workSessionId === selectedWorkSessionId
          ? current
          : { workSessionId: selectedWorkSessionId, text: "", activities: [] }),
        executionStage: next.executionStage,
      }));
    });
    source.addEventListener("delta", (event) => {
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
      const next = payload<{ activities?: WorkActivity[] }>(event);
      if (!Array.isArray(next?.activities)) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text:
          current.workSessionId === selectedWorkSessionId ? current.text : "",
        activities: next.activities ?? [],
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
    source.addEventListener("error", () => completion.disconnect());
    source.addEventListener("done", (event) => {
      if (disposed) return;
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
      setItems((current) => [
        {
          id: body.workSessionId as string,
          agentId,
          title: null,
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

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    if (sessionReadOnly || conversation || busy || running || composerPending)
      return;
    const input = draft.trim();
    if (!input) return;
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
    if (!canSend) return;
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

  async function archiveWork(id: string) {
    const response = await fetch(`/api/v1/work-sessions/${id}`, {
      method: "DELETE",
    });
    if (response.ok)
      window.location.assign(`/app/${encodeURIComponent(slug)}/work`);
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
    setExpandedAgents(
      Object.fromEntries(agents.map((item) => [item.id, !collapsed])),
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
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1280px)").matches
    ) {
      setDesktopPanel((current) => (current === panel ? null : panel));
      return;
    }
    setMobilePanel(panel);
  }

  const onSidebarScroll = useSidebarScroll();

  return (
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
                    key={JSON.stringify([
                      groupPreferences.collapsed,
                      expandedAgents,
                      sidebarSearch.trim(),
                    ])}
                    items={filteredSidebarResources}
                    activeId={activeResourceId}
                    ariaLabel={tAgents("agents")}
                    className={`px-0 [&_[role=treeitem]]:rounded-lg [&_[role=treeitem]]:min-h-10 [&_[aria-selected=true]]:bg-muted [&_[role=treeitem]>span[aria-hidden=true]:empty]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:empty]:w-0 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:w-0 ${sidebarHoverActionsClassName}`}
                    defaultExpandedIds={[
                      ...(sidebarSearch.trim()
                        ? filteredSidebarResources.flatMap((resource) => [
                            resource.id,
                            ...(resource.children?.map((child) => child.id) ??
                              []),
                          ])
                        : []),
                      ...groupPreferences.groups
                        .filter(
                          (group) => !groupPreferences.collapsed[group.id],
                        )
                        .map((group) => `group:${group.id}`),
                      ...(groupPreferences.collapsed[UNGROUPED_SIDEBAR_GROUP_ID]
                        ? []
                        : ["group:ungrouped"]),
                      ...visibleAgents
                        .filter(
                          ({ agent: itemAgent, channels }) =>
                            expandedAgents[itemAgent.id] ??
                            (itemAgent.id === activeAgentId ||
                              channels.length > 0),
                        )
                        .map(({ agent: itemAgent }) => `agent:${itemAgent.id}`),
                    ]}
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
                      if (kind === "agent") {
                        const itemAgent = agents.find((item) => item.id === id);
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
                        const item = items.find((session) => session.id === id);
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
                      // Second-level conversations show no icon; `false` suppresses the sidebar default.
                      if (kind === "conversation") return false;
                      return <Folder className="size-4" />;
                    }}
                    renderMenu={(resource, controls) => {
                      const [kind, id] = resource.id.split(":", 2);
                      const action = (label: string, run: () => void) => (
                        <button
                          type="button"
                          onClick={() => {
                            controls.close();
                            run();
                          }}
                          className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-xs text-foreground hover:bg-muted"
                        >
                          {label}
                        </button>
                      );
                      const moveActions = (
                        <>
                          {controls.moves.up
                            ? action("Move up", controls.moves.up)
                            : null}
                          {controls.moves.down
                            ? action("Move down", controls.moves.down)
                            : null}
                        </>
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
                        const itemAgent = agents.find((item) => item.id === id);
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
                            {moveActions}
                          </>
                        );
                      }
                      if (kind === "session") {
                        const item = items.find((session) => session.id === id);
                        return item && ARCHIVABLE_STATUSES.has(item.status) ? (
                          <>
                            {moveActions}
                            {action(t("archive"), () => void archiveWork(id))}
                          </>
                        ) : (
                          moveActions
                        );
                      }
                      if (kind === "conversation") return moveActions;
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
                    {conversation?.title ||
                      selected?.title ||
                      selected?.task ||
                      tAgents("newChat")}
                  </p>
                  {controlAgent ? (
                    <span className="hidden max-w-40 truncate rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-block">
                      {controlAgent.name}
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
                    showStatus={false}
                    active={conversationBusy}
                    onSetEditorText={setEditorText}
                    belowEditorElement={widgetTarget}
                    renderedActivityIds={renderedActivityIds}
                    className="mb-3"
                    onChange={() => router.refresh()}
                  />
                )}
                ready={!sessionReadOnly}
                runtimeKind={conversation.runtimeKind ?? null}
                agentRevisionVersion={conversation.agentRevisionVersion}
                currentRevisionVersion={controlAgent.currentRevisionVersion}
                mcpToolsUpdated={controlAgent.mcpToolsUpdated}
                modelName={conversation.modelName}
                modelOverride={modelChoices[composerScope] ?? null}
                modelPicker={
                  <ComposerModelSelect
                    providers={providers}
                    defaultSelection={
                      controlAgent.providerId && controlAgent.model
                        ? {
                            providerId: controlAgent.providerId,
                            model: controlAgent.model,
                          }
                        : null
                    }
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
                reasoningAvailable={false}
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
                busy={selectedActive}
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
                      agentName={controlAgent?.name ?? t("agent")}
                      modelName={
                        conversation?.modelName ?? selected?.modelName ?? null
                      }
                      messages={
                        conversation?.messages ?? selected?.messages ?? []
                      }
                      streamText={streamText}
                      streamActivities={streamActivities}
                      streamStartedAt={streamStartedAt}
                      streamRuntimeKind={streamRuntimeKind}
                      streamModelName={streamModelName}
                      executionStage={executionStage}
                      sessionStartedAt={selected?.startedAt}
                      sessionCompletedAt={selected?.completedAt}
                      streaming={selectedActive}
                    />
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
            {conversation && channelConversation ? (
              <ConversationExecution
                key={`${conversation.agentId}:${conversation.id}`}
                endpoint={`/api/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversation.id)}/execution`}
                showStatus
                renderedActivityIds={renderedHookIds}
                settingsHref={agentSettingsHref(
                  slug,
                  conversation.agentId,
                  workReturnTo,
                  "mcp",
                )}
                className={conversationComposerDockClassName}
                onChange={() => router.refresh()}
              />
            ) : null}
            {unappliedDraft && agent ? (
              <div
                role="status"
                className="mx-auto mb-2 flex w-[calc(100%_-_2rem)] max-w-[736px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm"
              >
                <p className="text-muted-foreground">
                  {t("agentDraftUnapplied")}
                </p>
                <Button
                  onClick={() =>
                    router.push(agentSettingsHref(slug, agent.id, workReturnTo))
                  }
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                >
                  {t("agentDraftReview")}
                </Button>
              </div>
            ) : null}
            {showConfigurationNotice && controlAgent ? (
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

            {!conversation && (!sessionReadOnly || selectedActive) && (
              <div
                className={`${conversationComposerDockClassName} ${!selected ? "mb-auto before:hidden" : ""} ${showConfigurationNotice || unappliedDraft ? "before:hidden" : ""}`}
              >
                <div>
                  {selected && !sessionReadOnly ? (
                    <ConversationExecution
                      key={selected.id}
                      endpoint={`/api/v1/workspaces/${encodeURIComponent(slug)}/work-sessions/${encodeURIComponent(selected.id)}/ui`}
                      showStatus={false}
                      showActivities={false}
                      active={selectedActive}
                      onSetEditorText={setDraft}
                      belowEditorElement={belowEditorElement}
                      renderedActivityIds={renderedHookIds}
                      onChange={() => void refreshSelected()}
                      className="mb-3"
                    />
                  ) : null}
                  <WorkComposer
                    key={composerScope}
                    agentId={controlAgent?.id}
                    sandboxId={controlSandbox?.id}
                    workSessionId={selected?.id}
                    conversationId={selected?.conversationId}
                    commands={commands}
                    runtimeKind={commandRuntimeKind}
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
                      running ||
                      (!canSend && !localCommand) ||
                      composerPending
                    }
                    loading={running}
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
                          defaultSelection={
                            controlAgent?.providerId && controlAgent.model
                              ? {
                                  providerId: controlAgent.providerId,
                                  model: controlAgent.model,
                                }
                              : null
                          }
                          value={modelChoices[composerScope] ?? null}
                          onChange={(value) =>
                            setModelChoices((choices) => ({
                              ...choices,
                              [composerScope]: value,
                            }))
                          }
                        />
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
            {controlSandbox && !workspacePending ? (
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

      {mobilePanel ? (
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
                : tSandboxes("terminal")
            }
            closeButtonLabel={t("closeWorkspace")}
            className="flex h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col"
          >
            <DialogHeader
              title={
                mobilePanel === "files"
                  ? tSandboxes("files")
                  : tSandboxes("terminal")
              }
              icon={
                mobilePanel === "files" ? (
                  <Folder className="size-4" />
                ) : (
                  <TerminalSquare className="size-4" />
                )
              }
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {controlSandbox && !workspacePending ? (
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
              {tAgents("deleteThisAgentAndItsSandboxesAndAllItsConversations")}
            </p>
          </DialogBody>
          <form action={deleteAgentAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input
              type="hidden"
              name="agentId"
              value={deleteAgentTarget?.id ?? ""}
            />
            <input type="hidden" name="returnTo" value={`/app/${slug}/work`} />
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
  );
}
