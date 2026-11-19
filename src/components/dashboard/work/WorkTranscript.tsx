"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Bot,
  Clock3,
  FileText,
  FileX,
  GitBranch,
  Minimize2,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/motion/button";
import { notify } from "@/components/dashboard/Toaster";
import { isDeletedAttachment } from "@/components/dashboard/attachment-deleted";
import { AgentMessageFeedback } from "@/components/dashboard/agents/AgentMessageFeedback";
import { AgentPromptProvenance } from "@/components/dashboard/agents/AgentPromptProvenance";
import { ConversationComposer } from "@/components/dashboard/ConversationComposer";
import { ConversationContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import { CopyButton } from "@/components/dashboard/CopyButton";
import {
  AssistantMarkdown,
  ConversationMessageShell,
  ConversationBudgetWarnings,
  conversationUserBubbleClassName,
} from "@/components/dashboard/ConversationMessage";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
} from "@/components/dashboard/dialog";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
  MessageGroup,
} from "@/components/agents/message";
import { StreamingResponse } from "@/components/agents/streaming-response";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  ADVISOR_SUGGESTIONS_PART,
  AdvisorSuggestionsSchema,
} from "@/lib/agents/advisor";
import type { BudgetWarning } from "@/lib/agents/budget-warning";
import {
  isConversationControl,
  messageCompaction,
} from "@/lib/agents/conversation-context";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import { COMMAND_RESULT_PART } from "@/lib/agents/runtime-commands";
import type { StreamRuleTrigger } from "@/lib/agents/stream-rules";
import {
  AGENT_TURN_TIMELINE_PART,
  agentTimelineDisplayParts,
} from "@/lib/agents/turn-timeline";
import { resolveContextUsage } from "@/lib/context-usage";
import { formatContentDuration as formatWorkDuration } from "@/lib/conversation/content-blocks";
import { liveTurnParts } from "@/lib/conversation/content-projection";
import { WorkTurnTrace } from "./WorkTurnTrace";
import type {
  WorkActivity,
  WorkMessage,
  WorkPart,
  WorkTreeAction,
} from "./work-types";

const executionStageKeys = {
  queued: "executionQueued",
  preparing: "executionPreparing",
  "waiting-model": "executionWaitingModel",
  generating: "executionGenerating",
  "tool-running": "executionToolRunning",
} as const;

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

/** Work turns record `data-work-timing`; channel, chat and trigger replies record a turn timeline. */
function messageWorkTiming(message: WorkMessage): WorkTiming | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (
      part?.type !== "data-work-timing" &&
      part?.type !== AGENT_TURN_TIMELINE_PART
    )
      continue;
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

/** A deleted attachment keeps its message slot but no longer downloads. */
function WorkAttachmentLink({
  url,
  name,
  mediaType,
}: {
  url: string;
  name: string;
  mediaType?: string;
}) {
  const t = useTranslations("filePreview");
  const [deleted, setDeleted] = useState(false);
  const image = mediaType?.startsWith("image/");
  if (deleted)
    return (
      <span className="inline-flex min-w-0 max-w-56 flex-nowrap items-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
        <FileX aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate line-through">{name}</span>
        <span className="shrink-0">{t("deleted")}</span>
      </span>
    );
  return (
    <a
      href={url}
      download={name}
      onClick={async (event) => {
        if (!url.startsWith("/api/v1/attachments/")) return;
        event.preventDefault();
        if (await isDeletedAttachment(url)) {
          setDeleted(true);
          notify(t("deletedNotice"), { severity: "warning" });
          return;
        }
        const download = document.createElement("a");
        download.href = url;
        download.download = name;
        download.click();
      }}
      className={`inline-flex min-w-0 max-w-56 items-center gap-1.5 rounded-lg bg-muted/70 px-2 py-1.5 text-xs text-foreground hover:bg-muted ${image ? "flex-wrap" : "flex-nowrap"}`}
    >
      {image ? (
        // biome-ignore lint/performance/noImgElement: Authorized attachment URLs and base64 data must render directly without the Next image optimizer or layout sizing changes.
        <img
          src={url}
          alt={name}
          className="max-h-48 w-full object-contain"
          onError={() => {
            void isDeletedAttachment(url).then(
              (gone) => gone && setDeleted(true),
            );
          }}
        />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </a>
  );
}

export function WorkTranscript({
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
            // The live turn uses the stored record vocabulary of the reply it becomes.
            parts: liveTurnParts({
              text: streamText,
              activities: streamActivities,
              budgetWarning: streamBudgetWarning,
              streamRuleTriggers,
              startedAt: streamStartedAt,
              runtimeKind: streamRuntimeKind,
              modelName: streamModelName,
            }) as WorkPart[],
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
          // Entry replies keep their process in the timeline; the trace reads it as steps.
          const traceParts = agentTimelineDisplayParts(message.parts);
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
          // A reply's own files are content blocks; these are the user's uploads.
          const fileParts = message.parts.filter(
            (part): part is WorkPart & { url: string } =>
              message.role === "user" &&
              part.type === "file" &&
              typeof part.url === "string" &&
              (part.url.startsWith("/api/v1/attachments/") ||
                /^data:[\w.+-]+\/[\w.+-]+;base64,/.test(part.url)),
          );
          const attachmentLinks = fileParts.length ? (
            <div className="flex max-w-full flex-wrap gap-1.5">
              {fileParts.map((part, index) => (
                <WorkAttachmentLink
                  // biome-ignore lint/suspicious/noArrayIndexKey: Streamed attachment parts are append-only; retain their positional identity, including duplicate URLs.
                  key={`${part.url}-${index}`}
                  url={part.url}
                  name={part.filename ?? agentsT("attachment")}
                  mediaType={part.mediaType}
                />
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
                    <ConversationContentBlocks
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
                    parts={traceParts}
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
