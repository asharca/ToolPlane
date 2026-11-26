"use client";

import { useAgentUiLabels } from "../agent-ui-labels";
import { Button } from "@/components/motion/button";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import {
  ManageFilesButton,
  STORAGE_QUOTA_EXCEEDED,
} from "@/components/dashboard/ManageFilesButton";
import { notify } from "@/components/dashboard/Toaster";
import { AgentMessageFeedback } from "./AgentMessageFeedback";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RevisionUpgradeNotice,
  McpToolsUpdatedNote,
} from "@/components/dashboard/RevisionUpgradeNotice";
import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
  MessageGroup,
  MessageTyping,
} from "@/components/agents/message";
import { MessageScroller } from "@/components/agents/message-scroller";
import {
  ConversationComposer as PromptInput,
  conversationComposerDockClassName,
} from "@/components/dashboard/ConversationComposer";
import {
  ConversationMessageShell,
  conversationUserBubbleClassName,
} from "@/components/dashboard/ConversationMessage";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import {
  ComposerDropOverlay,
  ScrollToBottomButton,
  useComposerFileDrop,
} from "@/components/dashboard/ConversationUxPrimitives";
import {
  AgentMessageQueueView,
  useAgentMessageQueue,
  type QueueMode,
} from "@/components/dashboard/AgentMessageQueue";
import { useLiveTaskOutput } from "@/components/dashboard/work/useLiveTaskOutput";
import { LiveOutputView } from "@/components/dashboard/work/LiveOutputView";
import { ConversationContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import { WorkTurnTrace } from "@/components/dashboard/work/WorkTurnTrace";
import { formatContentDuration } from "@/lib/conversation/content-blocks";
import {
  AGENT_TURN_TIMELINE_PART,
  parseAgentTurnTimeline,
} from "@/lib/agents/turn-timeline";
import {
  buildErrorFeedbackHref,
  captureAndStoreErrorFeedback,
} from "@/lib/feedback/error-capture";
import { apiRequest } from "@/lib/client/api";
import {
  DisplayError,
  displayErrorText,
} from "@/components/dashboard/display-error";
import { ConversationTools } from "./AgentConversationTools";
import {
  useAgentAttachments,
  type DraftAttachment,
} from "./useAgentAttachments";
import { CopyButton } from "@/components/dashboard/CopyButton";

import { AgentPromptProvenance } from "@/components/dashboard/agents/AgentPromptProvenance";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type CreateUIMessage } from "ai";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Pencil,
  RotateCcw,
} from "lucide-react";

import { ConversationContextUsage } from "@/components/dashboard/ConversationComposer";
import { resolveContextUsage } from "@/lib/context-usage";
import type { ChatBranchNavigation } from "@/lib/chat/branches";
import type { ReasoningEffort, ReasoningLevel } from "@/lib/agents/constants";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import {
  expandAssistantMessages,
  type AgentUIMessage,
} from "@/lib/agents/message-segments";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
} from "@/lib/agents/runtime-commands";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { ADVISOR_SUGGESTIONS_PART } from "@/lib/agents/advisor";

type DraftSnapshot = {
  text: string;
  attachments: DraftAttachment[];
};

function mergeDraftText(current: string, restored: string) {
  if (!restored) return current;
  if (!current) return restored;
  if (current === restored || current.startsWith(`${restored}\n`))
    return current;
  return `${restored}\n${current}`;
}

export function AgentConversation({
  workspaceSlug,
  activeConversationId,
  agentId,
  agentName,
  settingsHref,
  allowEdit = false,
  allowRegenerate = true,
  apiPath,
  attachmentUploadUrl,
  branchBusy = false,
  branchNavigation = [],
  composerNotice,
  contextBaseText,
  contextWindow,
  contextWindowEstimated = true,
  creatingConversation,
  ensureConversation,
  includeConversationIdInBody = true,
  initialReasoningEffort = "default",
  initialMessages,
  modelName,
  modelPicker,
  modelOverride,
  mcpPromptApiPath,
  mcpResourceApiPath,
  onBranchChange,
  onBusyChange,
  onConversationChanged,
  onNewConversation,
  onStartBranch,
  ready: configuredReady,
  reasoningAvailable = false,
  inheritedReasoningEffort = null,
  runtimeKind,
  readOnly: configuredReadOnly = false,
  agentRevisionVersion,
  currentRevisionVersion,
  mcpToolsUpdated,
  supportsAttachments,
  serverManaged = false,
  webSearchAvailable,
  workSessionId,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  settingsHref?: string;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  apiPath?: string;
  attachmentUploadUrl?: string;
  branchBusy?: boolean;
  branchNavigation?: ChatBranchNavigation[];
  /** Rendered above the composer; native editor events can update its draft. */
  composerNotice?:
    | ReactNode
    | ((
        setEditorText: (text: string) => void,
        belowEditorElement: HTMLDivElement | null,
        renderedActivityIds: readonly string[],
      ) => ReactNode);
  contextBaseText?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  includeConversationIdInBody?: boolean;
  initialReasoningEffort?: ReasoningEffort;
  initialMessages: AgentUIMessage[];
  modelName?: string | null;
  modelPicker?: ReactNode;
  modelOverride?: { providerId: string; model: string } | null;
  mcpPromptApiPath?: string;
  mcpResourceApiPath?: string;
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onConversationChanged?: () => void | Promise<void>;
  onNewConversation?: () => void | Promise<void>;
  onStartBranch?: (messageId: string) => void | Promise<void>;
  ready: boolean;
  reasoningAvailable?: boolean;
  inheritedReasoningEffort?: ReasoningLevel | null;
  runtimeKind: string | null;
  readOnly?: boolean;
  agentRevisionVersion?: number | null;
  currentRevisionVersion?: number;
  mcpToolsUpdated?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  } | null;
  supportsAttachments?: boolean;
  serverManaged?: boolean;
  webSearchAvailable?: boolean;
  workSessionId?: string;
  workspaceSlug?: string;
}) {
  const router = useRouter();
  const t = useTranslations("console.agents");
  const agentUi = useAgentUiLabels();
  const common = useTranslations("common");
  const work = useTranslations("console.work");
  const chatAssistants = useTranslations("console.chatAssistants");
  const commandsT = useTranslations("console.runtimeCommands");
  const readOnly = configuredReadOnly || runtimeKind === "omp";
  const ready =
    configuredReady &&
    !readOnly &&
    (serverManaged || isExecutableAgentRuntimeKind(runtimeKind));
  const sessionQuery = new URLSearchParams({
    ...(activeConversationId ? { conversationId: activeConversationId } : {}),
    ...(workSessionId ? { workSessionId } : {}),
  });
  const scopeApiPath = (path?: string) => {
    if (!path || (!activeConversationId && !workSessionId)) return undefined;
    const [pathname, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    for (const [key, value] of sessionQuery) params.set(key, value);
    return `${pathname}?${params}`;
  };
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const submittedHistoryLength = useRef(initialMessages.length);
  const {
    attachments,
    addAttachment,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    uploadAttachments,
    uploading: uploadingAttachments,
  } = useAgentAttachments(attachmentUploadUrl);
  const [commandBusy, setCommandBusy] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialReasoningEffort,
  );
  const { transport, getServerResponse } = useMemo(() => {
    let serverResponse: Promise<Response> | null = null;
    return {
      getServerResponse: () => serverResponse,
      transport: new DefaultChatTransport({
        api: apiPath ?? `/api/v1/agents/${agentId}/chat`,
        ...(serverManaged
          ? {
              fetch: (...args: Parameters<typeof fetch>) => {
                serverResponse = fetch(...args);
                return serverResponse;
              },
              prepareReconnectToStreamRequest: () => ({
                api: `${apiPath}/stream`,
              }),
            }
          : {}),
        ...(!includeConversationIdInBody
          ? {
              prepareSendMessagesRequest: ({
                body,
                messageId,
                messages,
                trigger,
              }) => ({
                body: {
                  ...body,
                  messageId,
                  messages: messages.slice(-1),
                  trigger,
                },
              }),
            }
          : {}),
      }),
    };
  }, [agentId, apiPath, includeConversationIdInBody, serverManaged]);
  const chat = useChat<AgentUIMessage>({
    transport,
    resume: serverManaged,
    messages: initialMessages,
    onData: (part) => {
      const data = part as { type: string; data: unknown };
      if (data.type === "data-agent-message-queue")
        messageQueue.observe(data.data);
    },
    onFinish: () => {
      void onConversationChanged?.();
    },
  });
  const stopLocalChat = chat.stop;
  const stop = useCallback(async () => {
    if (!serverManaged) {
      await stopLocalChat();
      return;
    }
    if (!apiPath) return;
    // The turn ID header arrives with the streaming response the transport opened.
    const response = await getServerResponse()?.catch(() => null);
    const turnId = response?.headers.get("X-Chat-Turn-Id");
    if (!turnId) {
      await stopLocalChat();
      return;
    }
    const stopped = await apiRequest(apiPath, {
      method: "DELETE",
      json: { turnId },
    });
    // On success, keep observing until the server settles and persists the stopped turn.
    if (!stopped.ok) setSubmitError(stopped.message ?? work("processFailed"));
  }, [apiPath, getServerResponse, serverManaged, stopLocalChat, work]);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming";
  const describeRuntimeError = useRuntimeErrorText();
  // The SDK error's text is matched against known failure codes, never shown raw.
  const chatErrorCode = chat.error?.message;
  const runtimeError = describeRuntimeError(submitError || chatErrorCode);
  const configurationError = /no configured model/i.test(
    submitError || chatErrorCode || "",
  );
  const busy = chatBusy || commandBusy || submitting;
  const nativeLive = useLiveTaskOutput({
    url:
      !serverManaged && runtimeKind === "pi-sdk" && activeConversationId
        ? `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(activeConversationId)}/events`
        : null,
    onSnapshot: (output) =>
      messageQueue.observe(
        output?.messageQueue ?? { messages: [], pendingMessageCount: 0 },
      ),
    onTranscriptChange: () => {
      void onConversationChanged?.();
    },
    onSettled: () => {
      void onConversationChanged?.();
    },
    onRevoked: () => {
      void onConversationChanged?.();
    },
  });
  const nativeRunning =
    !serverManaged &&
    runtimeKind === "pi-sdk" &&
    (chatBusy || Boolean(nativeLive.output?.active));
  const messageQueue = useAgentMessageQueue({
    agentId,
    conversationId: activeConversationId,
    active: nativeRunning,
    onRefresh: () => {
      void onConversationChanged?.();
    },
  });
  const queueT = useTranslations("console.messageQueue");
  const nativeOutput = nativeLive.output;
  const nativeOutputPersisted = Boolean(
    nativeOutput &&
      !nativeOutput.active &&
      initialMessages.some((message) =>
        message.parts.some((part) => {
          const data = part as {
            type: string;
            data?: { taskId?: string; startedAt?: number };
          };
          return (
            data.type === "data-agent-task" &&
            data.data?.taskId === nativeOutput.taskId &&
            (nativeOutput.startedAt === undefined ||
              data.data?.startedAt === nativeOutput.startedAt)
          );
        }),
      ),
  );
  const transcriptMessages = useMemo(() => {
    if (!nativeOutput) return chat.messages;
    const optimisticUser =
      chatBusy && initialMessages.length <= submittedHistoryLength.current
        ? chat.messages.findLast((message) => message.role === "user")
        : undefined;
    return optimisticUser &&
      !initialMessages.some((message) => message.id === optimisticUser.id)
      ? [...initialMessages, optimisticUser]
      : initialMessages;
  }, [nativeOutput, chat.messages, chatBusy, initialMessages]);
  useEffect(() => {
    onBusyChange?.(busy || nativeRunning);
    return () => onBusyChange?.(false);
  }, [busy, nativeRunning, onBusyChange]);
  const contextUsage = useMemo(
    () =>
      resolveContextUsage(chat.messages, {
        maxTokens: contextWindow,
        modelName,
        context: contextBaseText,
        estimated: contextWindowEstimated,
      }),
    [
      chat.messages,
      contextBaseText,
      contextWindow,
      contextWindowEstimated,
      modelName,
    ],
  );

  const persistedMessageIds = useMemo(
    () => new Set(initialMessages.map((message) => message.id)),
    [initialMessages],
  );
  const { displayMessages, sourceMessagesById } = useMemo(() => {
    const sources = new Map<string, AgentUIMessage>();
    const existingIds = new Set(
      transcriptMessages.map((message) => message.id),
    );
    // Persisted advisor records arrive via Work refresh, independently of the main stream.
    const advisories = initialMessages.filter(
      (message) =>
        !existingIds.has(message.id) &&
        message.parts.some((part) => part.type === ADVISOR_SUGGESTIONS_PART),
    );
    const insertionIndex =
      chatBusy && transcriptMessages.at(-1)?.role === "assistant"
        ? transcriptMessages.length - 1
        : transcriptMessages.length;
    const combined = advisories.length
      ? [
          ...transcriptMessages.slice(0, insertionIndex),
          ...advisories,
          ...transcriptMessages.slice(insertionIndex),
        ]
      : transcriptMessages;
    const messages = combined.flatMap((message) => {
      const expanded = expandAssistantMessages([message]);
      for (const displayed of expanded) sources.set(displayed.id, message);
      return expanded;
    });
    return { displayMessages: messages, sourceMessagesById: sources };
  }, [transcriptMessages, chatBusy, initialMessages]);
  const renderedActivityIds = useMemo(
    () =>
      transcriptMessages.flatMap((message) =>
        message.parts.flatMap((part) =>
          (part.type === "data-subagent-activity" ||
            part.type === "data-hook-activity") &&
          "id" in part &&
          typeof part.id === "string"
            ? [part.id]
            : [],
        ),
      ),
    [transcriptMessages],
  );
  const runtimeCommands = useMemo(
    () =>
      isExecutableAgentRuntimeKind(runtimeKind)
        ? sessionRuntimeCommands(runtimeKind, chat.messages)
        : [],
    [chat.messages, runtimeKind],
  );
  const initialMessagesSignature = useMemo(
    () => JSON.stringify(initialMessages),
    [initialMessages],
  );
  const setChatMessages = chat.setMessages;
  const lastInitialMessagesSignatureRef = useRef(initialMessagesSignature);
  useEffect(() => {
    if (chatBusy) return;
    if (lastInitialMessagesSignatureRef.current === initialMessagesSignature)
      return;
    lastInitialMessagesSignatureRef.current = initialMessagesSignature;
    setChatMessages(initialMessages);
  }, [chatBusy, initialMessages, initialMessagesSignature, setChatMessages]);
  const sendChatMessage = chat.sendMessage;
  const regenerateChat = chat.regenerate;
  const sendMessage = useCallback(
    async (
      message: CreateUIMessage<AgentUIMessage>,
      editMessageId?: string,
    ) => {
      if (!ready || branchBusy || commandBusy) return;
      setSubmitError(null);
      const commandLine = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const command = runtimeCommands.length
        ? parseRuntimeCommand(commandLine, runtimeKind ?? "")
        : null;
      if (command) {
        if (
          !isExecutableAgentRuntimeKind(runtimeKind) &&
          !runtimeCommands.some((item) => item.name === command.name)
        )
          throw new DisplayError(commandsT("unsupportedCommand"));
        if (message.parts.some((part) => part.type !== "text"))
          throw new DisplayError(commandsT("noAttachments"));
      }
      let nextConversationId: string;
      try {
        nextConversationId =
          activeConversationId ?? (await ensureConversation());
      } catch {
        throw new DisplayError(t("couldNotCreateConversation"));
      }
      if (command) {
        setCommandBusy(true);
        try {
          const result = await apiRequest(
            `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(nextConversationId)}/commands`,
            {
              method: "POST",
              json: {
                line: commandLine.trim(),
                ...(modelOverride ? { modelOverride } : {}),
              },
            },
          );
          if (!result.ok)
            throw new DisplayError(
              result.message && commandsT.has(result.message)
                ? commandsT(result.message)
                : result.message || commandsT("failed"),
            );
          void onConversationChanged?.();
        } finally {
          setCommandBusy(false);
        }
        return;
      }
      setFollowingOutput(true);
      // AI SDK replaces this user turn and truncates its descendants atomically.
      await sendChatMessage(
        { ...message, ...(editMessageId ? { messageId: editMessageId } : {}) },
        {
          body: {
            ...(modelOverride ? { modelOverride } : {}),
            ...(includeConversationIdInBody
              ? { conversationId: nextConversationId }
              : {}),
            ...(workSessionId ? { workSessionId } : {}),
            ...(webSearchAvailable !== undefined
              ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
              : {}),
            ...(reasoningAvailable ? { reasoningEffort } : {}),
          },
        },
      );
    },
    [
      agentId,
      activeConversationId,
      branchBusy,
      commandBusy,
      commandsT,
      ensureConversation,
      includeConversationIdInBody,
      modelOverride,
      onConversationChanged,
      reasoningAvailable,
      ready,
      reasoningEffort,
      runtimeCommands,
      runtimeKind,
      sendChatMessage,
      t,
      webSearchAvailable,
      webSearchEnabled,
      workSessionId,
    ],
  );
  const regenerate = useCallback<typeof chat.regenerate>(
    async (options) => {
      if (
        !ready ||
        !allowRegenerate ||
        branchBusy ||
        chatBusy ||
        commandBusy ||
        submissionInFlight.current
      )
        return;
      submissionInFlight.current = true;
      setSubmitting(true);
      setSubmitError(null);
      try {
        let nextConversationId: string;
        try {
          nextConversationId =
            activeConversationId ?? (await ensureConversation());
        } catch {
          setSubmitError(t("couldNotCreateConversation"));
          return;
        }
        setFollowingOutput(true);
        await regenerateChat({
          ...options,
          body: {
            ...options?.body,
            ...(modelOverride ? { modelOverride } : {}),
            ...(includeConversationIdInBody
              ? { conversationId: nextConversationId }
              : {}),
            ...(workSessionId ? { workSessionId } : {}),
            ...(webSearchAvailable !== undefined
              ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
              : {}),
            ...(reasoningAvailable ? { reasoningEffort } : {}),
          },
        });
      } finally {
        submissionInFlight.current = false;
        setSubmitting(false);
      }
    },
    [
      activeConversationId,
      allowRegenerate,
      branchBusy,
      chatBusy,
      commandBusy,
      ensureConversation,
      includeConversationIdInBody,
      modelOverride,
      reasoningAvailable,
      ready,
      reasoningEffort,
      regenerateChat,
      t,
      webSearchAvailable,
      webSearchEnabled,
      workSessionId,
    ],
  );

  const composerDisabled =
    branchBusy ||
    commandBusy ||
    creatingConversation ||
    uploadingAttachments ||
    messageQueue.forbidden ||
    nativeLive.connection === "revoked";
  const attachmentsEnabled =
    (serverManaged || isExecutableAgentRuntimeKind(runtimeKind)) &&
    (supportsAttachments ?? Boolean(attachmentUploadUrl));
  const composerStatus = !ready
    ? t("chooseAModelBeforeSending")
    : uploadingAttachments
      ? t("uploadingAttachments")
      : !activeConversationId
        ? t("conversationWillBeCreated")
        : null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [belowEditorElement, setBelowEditorElement] =
    useState<HTMLDivElement | null>(null);
  const blocked = !ready || composerDisabled || busy || nativeRunning;
  const { dragging, dropProps, handlePaste } = useComposerFileDrop({
    enabled: attachmentsEnabled && !blocked,
    onFiles: (incoming) => {
      for (const file of Array.from(incoming))
        void runAction(() => addAttachment(file));
    },
  });
  const runAction = async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      setSubmitError(displayErrorText(cause, work("processFailed")));
    }
  };
  const submitQueuedDraft = async (mode: QueueMode) => {
    if (
      !ready ||
      composerDisabled ||
      messageQueue.pending ||
      !composerText.trim()
    )
      return;
    if (attachments.length) {
      notify(queueT("textOnly"), { severity: "error" });
      return;
    }
    const text = composerText;
    if (await messageQueue.send(mode, text))
      setComposerText((current) => (current === text ? "" : current));
  };
  const submitDraft = async () => {
    if (
      !ready ||
      composerDisabled ||
      submitting ||
      (busy && !messageQueue.fallback) ||
      submissionInFlight.current ||
      messageQueue.pending ||
      (!composerText.trim() && !attachments.length)
    )
      return;
    submittedHistoryLength.current = initialMessages.length;
    const snapshot: DraftSnapshot = {
      text: composerText,
      attachments: takeAttachments(),
    };
    submissionInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setComposerText("");
    try {
      if (
        snapshot.attachments.length &&
        runtimeCommands.length &&
        parseRuntimeCommand(snapshot.text, runtimeKind ?? "")
      )
        throw new DisplayError(commandsT("noAttachments"));
      const files = await uploadAttachments(snapshot.attachments);
      await sendMessage({
        role: "user",
        parts: [
          ...(snapshot.text.trim()
            ? [{ type: "text" as const, text: snapshot.text }]
            : []),
          ...files,
        ],
      });
    } catch (cause) {
      setComposerText((current) => mergeDraftText(current, snapshot.text));
      restoreAttachments(snapshot.attachments);
      setSubmitError(displayErrorText(cause, work("processFailed")));
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };
  const submitEdit = async (message: AgentUIMessage) => {
    if (blocked || submissionInFlight.current || !editText.trim()) return;
    const submittedText = editText;
    submissionInFlight.current = true;
    setSubmitting(true);
    setEditingId(null);
    setEditText("");
    try {
      await sendMessage(
        {
          role: "user",
          metadata: message.metadata,
          parts: [
            { type: "text", text: submittedText },
            ...message.parts.filter((part) => part.type !== "text"),
          ],
        },
        message.id,
      );
    } catch (cause) {
      setEditingId(message.id);
      setEditText(submittedText);
      setSubmitError(displayErrorText(cause, work("processFailed")));
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!readOnly &&
      activeConversationId &&
      agentRevisionVersion &&
      currentRevisionVersion &&
      agentRevisionVersion < currentRevisionVersion ? (
        <RevisionUpgradeNotice
          url={`/api/v1/agents/${agentId}/conversations/${activeConversationId}/revision`}
          fromVersion={agentRevisionVersion}
          targetVersion={currentRevisionVersion}
          disabled={busy || nativeRunning || branchBusy}
          onUpgraded={() => {
            router.refresh();
            void onConversationChanged?.();
          }}
        />
      ) : null}
      <MessageScroller
        label={agentName}
        busy={chatBusy || nativeRunning}
        followOutput={followingOutput}
        onFollowChange={setFollowingOutput}
        navigation="rail"
        labels={agentUi.scroller}
        className={
          displayMessages.length
            ? "min-h-0 flex-1"
            : "mt-auto min-h-0 flex-none"
        }
        contentClassName="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6"
      >
        {displayMessages.length ? (
          <MessageGroup spacing="default" className="gap-6">
            {displayMessages.map((message, messageIndex) => {
              const from = message.role === "user" ? "user" : "assistant";
              const sourceMessage =
                sourceMessagesById.get(message.id) ?? message;
              const turnModelPart = sourceMessage.parts.find(
                (part) => part.type === "data-agent-turn-model",
              );
              const turnModelData =
                turnModelPart && "data" in turnModelPart
                  ? turnModelPart.data
                  : null;
              const turnModel =
                turnModelData &&
                typeof turnModelData === "object" &&
                "model" in turnModelData &&
                typeof turnModelData.model === "string"
                  ? turnModelData.model
                  : null;
              const timelinePart = sourceMessage.parts.find(
                (part) => part.type === AGENT_TURN_TIMELINE_PART,
              );
              const timeline =
                timelinePart && "data" in timelinePart
                  ? parseAgentTurnTimeline(timelinePart.data)
                  : null;
              const advisorOnly =
                sourceMessage.parts.some(
                  (part) => part.type === ADVISOR_SUGGESTIONS_PART,
                ) &&
                sourceMessage.parts.every(
                  (part) =>
                    part.type === ADVISOR_SUGGESTIONS_PART ||
                    (part.type === "text" && !part.text),
                );
              const streaming =
                message.role === "assistant" &&
                !advisorOnly &&
                chat.status === "streaming" &&
                messageIndex === displayMessages.length - 1;
              const text = message.parts
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
              const branch = branchNavigation.find(
                (item) => item.messageId === sourceMessage.id,
              );
              const actionVisibility =
                messageIndex === displayMessages.length - 1
                  ? ""
                  : "opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto motion-reduce:transition-none";
              const branchActions =
                branch && onBranchChange ? (
                  <fieldset
                    aria-label={t("conversationBranch")}
                    className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0 text-xs text-muted-foreground"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={messageActionClassName}
                      disabled={blocked}
                      aria-label={common("previous")}
                      onClick={() =>
                        void runAction(() =>
                          onBranchChange(branch.previousMessageId),
                        )
                      }
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span>
                      {branch.position}/{branch.total}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={messageActionClassName}
                      disabled={blocked}
                      aria-label={common("next")}
                      onClick={() =>
                        void runAction(() =>
                          onBranchChange(branch.nextMessageId),
                        )
                      }
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </fieldset>
                ) : null;
              const messageBody = (
                <>
                  {from === "assistant" && (turnModel || timeline) ? (
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      {turnModel ? <span>{turnModel}</span> : null}
                      {timeline ? (
                        <WorkTurnTrace
                          messageId={sourceMessage.id}
                          timing={timeline}
                          durationMs={timeline.completedAt - timeline.startedAt}
                          parts={[
                            ...(sourceMessage.parts as readonly {
                              type: string;
                            }[]),
                            ...timeline.steps,
                          ]}
                          modelName={turnModel ?? timeline.modelName}
                          status="completed"
                        >
                          <span data-ui="agent-message-duration">
                            {formatContentDuration(
                              timeline.completedAt - timeline.startedAt,
                            )}
                          </span>
                        </WorkTurnTrace>
                      ) : null}
                    </div>
                  ) : null}
                  {from === "user" ? (
                    <>
                      <AgentPromptProvenance parts={sourceMessage.parts} />
                      {message.parts.map((part, index) => {
                        if (part.type === "text")
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Message parts occupy stable stream slots, including duplicate text.
                            <span key={index} className="whitespace-pre-wrap">
                              {displayMessagingUserText(part.text)}
                            </span>
                          );
                        if (part.type === "file")
                          return (
                            <ConversationFilePreview
                              // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate attachment URLs occupy independent persistent part slots.
                              key={index}
                              name={part.filename ?? t("attachment")}
                              url={part.url}
                              mimeType={part.mediaType}
                              display="inline"
                            />
                          );
                        return null;
                      })}
                    </>
                  ) : (
                    <ConversationContentBlocks
                      messageId={message.id}
                      parts={message.parts}
                      streaming={streaming}
                    />
                  )}
                </>
              );
              return (
                <ConversationMessageShell
                  key={message.id}
                  id={`chat-message-${message.id}`}
                  from={from}
                  name={agentName}
                  showIdentity={
                    messageIndex === 0 ||
                    displayMessages[messageIndex - 1]?.role !== "assistant"
                  }
                  aria-busy={streaming || undefined}
                >
                  {editingId === message.id ? (
                    <div className="w-full">
                      <PromptInput
                        value={editText}
                        autoFocus
                        disabled={blocked}
                        aria-label={t("messageThisAgent")}
                        onValueChange={setEditText}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingId(null);
                            setEditText("");
                          }
                        }}
                        onSubmit={() => void submitEdit(sourceMessage)}
                        leadingAction={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditingId(null);
                              setEditText("");
                            }}
                          >
                            {common("cancel")}
                          </Button>
                        }
                      />
                    </div>
                  ) : from === "assistant" ? (
                    <>
                      {messageBody}
                      {!streaming && !advisorOnly ? (
                        <MessageFooter
                          className={`gap-0.5 ${actionVisibility}`}
                        >
                          {activeConversationId &&
                          persistedMessageIds.has(sourceMessage.id) ? (
                            <AgentMessageFeedback
                              agentId={agentId}
                              conversationId={activeConversationId}
                              messageId={sourceMessage.id}
                            />
                          ) : null}
                          {text ? (
                            <CopyButton
                              text={text}
                              label={common("copy")}
                              className={messageActionClassName}
                              iconOnly
                            />
                          ) : null}
                          {allowRegenerate ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={messageActionClassName}
                              disabled={blocked}
                              aria-label={t("retryResponse")}
                              onClick={() =>
                                void runAction(() =>
                                  regenerate({ messageId: sourceMessage.id }),
                                )
                              }
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          ) : null}
                          {branchActions}
                          {onStartBranch ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={messageActionClassName}
                              disabled={blocked}
                              aria-label={chatAssistants("newBranch")}
                              onClick={() =>
                                void runAction(() =>
                                  onStartBranch(sourceMessage.id),
                                )
                              }
                            >
                              <GitBranch className="size-3.5" />
                            </Button>
                          ) : null}
                        </MessageFooter>
                      ) : null}
                    </>
                  ) : (
                    <MessageBubble
                      variant="soft"
                      className={conversationUserBubbleClassName}
                    >
                      <MessageBubbleContent>{messageBody}</MessageBubbleContent>
                    </MessageBubble>
                  )}
                  {from === "user" && editingId !== message.id ? (
                    <MessageFooter className={`gap-0.5 ${actionVisibility}`}>
                      {branchActions}
                      {text ? (
                        <CopyButton
                          text={displayMessagingUserText(text)}
                          label={common("copy")}
                          className={messageActionClassName}
                          iconOnly
                        />
                      ) : null}
                      {allowEdit ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={messageActionClassName}
                          disabled={blocked}
                          aria-label={common("edit")}
                          onClick={() => {
                            setEditText(text);
                            setEditingId(message.id);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      ) : null}
                    </MessageFooter>
                  ) : null}
                </ConversationMessageShell>
              );
            })}
          </MessageGroup>
        ) : (
          <div className="flex items-center justify-center pb-2 pt-8 text-center">
            <div className="max-w-lg">
              <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-muted ring-1 ring-border/50">
                <Bot className="size-6" />
              </span>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                {agentName}
              </p>
              <h3 className="text-2xl font-medium tracking-tight sm:text-3xl">
                {work("emptyTitle")}
              </h3>
              {workSessionId ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("startWorkConversationDescription")}
                </p>
              ) : null}
              {mcpToolsUpdated ? (
                <McpToolsUpdatedNote {...mcpToolsUpdated} />
              ) : null}
            </div>
          </div>
        )}
        {chat.status === "submitted" ? (
          <MessageTyping label={work("preparingReply")} />
        ) : null}
        {nativeOutput && !nativeOutputPersisted ? (
          <LiveOutputView output={nativeOutput} showQueue={false} />
        ) : null}
      </MessageScroller>
      <div
        className={`${conversationComposerDockClassName} ${!displayMessages.length ? "mb-auto" : ""}`}
      >
        <ScrollToBottomButton
          visible={!followingOutput && displayMessages.length > 0}
          onClick={() => setFollowingOutput(true)}
          label={work("scrollToBottom")}
        />
        <div className="mb-2 max-h-[42dvh] space-y-2 overflow-y-auto overscroll-contain empty:hidden">
          {typeof composerNotice === "function"
            ? composerNotice(
                setComposerText,
                belowEditorElement,
                renderedActivityIds,
              )
            : composerNotice}
          {submitError || chat.error
            ? (() => {
                const displayedError = configurationError
                  ? work("configureAgent")
                  : submitError === STORAGE_QUOTA_EXCEEDED
                    ? t("attachmentStorageQuotaExceeded")
                    : runtimeError
                      ? runtimeError.text
                      : (submitError ??
                        displayErrorText(chat.error, work("processFailed")));
                const showConfigure =
                  (configurationError ||
                    runtimeError?.code === "PI_MCP_TOOLS_UNAVAILABLE") &&
                  Boolean(settingsHref);
                const showQuotaManage = submitError === STORAGE_QUOTA_EXCEEDED;
                const reportHref =
                  workspaceSlug && !configurationError && !showQuotaManage
                    ? buildErrorFeedbackHref({
                        workspaceSlug,
                        failureCode: runtimeError?.code,
                        workSessionId,
                        conversationId: activeConversationId ?? undefined,
                        agentId,
                        captured: true,
                      })
                    : null;
                return (
                  <Alert variant="destructive" className="mb-3">
                    <AlertIcon />
                    <AlertContent>
                      <AlertDescription>{displayedError}</AlertDescription>
                    </AlertContent>
                    {showConfigure || showQuotaManage || reportHref ? (
                      <AlertAction>
                        {showConfigure && settingsHref ? (
                          <Link
                            href={settingsHref}
                            className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                          >
                            {t("configureAgent")}
                          </Link>
                        ) : null}
                        {showQuotaManage ? <ManageFilesButton /> : null}
                        {reportHref && workspaceSlug ? (
                          <Link
                            href={reportHref}
                            onClick={() =>
                              captureAndStoreErrorFeedback({
                                workspaceSlug,
                                errorText: displayedError,
                                failureCode: runtimeError?.code,
                                agentName,
                              })
                            }
                            className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            {work("reportThisIssue")}
                          </Link>
                        ) : null}
                      </AlertAction>
                    ) : null}
                  </Alert>
                );
              })()
            : null}
          <AgentMessageQueueView
            queue={messageQueue.queue}
            onClear={() => void messageQueue.clear()}
            disabled={!ready || messageQueue.pending || messageQueue.forbidden}
          />
        </div>
        <div data-ui="chat.composer" {...dropProps} className="relative">
          <ComposerDropOverlay
            dragging={dragging}
            label={work("dropFilesToAttach")}
          />
          <PromptInput
            attachments={
              attachments.length ? (
                <div className="mb-2 flex flex-wrap gap-3">
                  {attachments.map((attachment) => (
                    <ConversationFilePreview
                      key={attachment.id}
                      file={attachment.file}
                      display="chip"
                      name={attachment.file.name}
                      mimeType={attachment.file.type}
                      removeLabel={t("removeAttachment", {
                        name: attachment.file.name,
                      })}
                      onRemove={() => removeAttachment(attachment.id)}
                    />
                  ))}
                </div>
              ) : null
            }
            hasAttachments={attachments.length > 0}
            canSubmit={
              attachments.length > 0 &&
              !(nativeRunning && !messageQueue.fallback)
            }
            labels={agentUi.composer}
            value={composerText}
            onValueChange={setComposerText}
            onPaste={handlePaste}
            onSubmit={() =>
              nativeRunning && !messageQueue.fallback
                ? void submitQueuedDraft("steer")
                : void submitDraft()
            }
            onRunningSubmit={
              nativeRunning && !messageQueue.fallback
                ? (mode) => void submitQueuedDraft(mode)
                : undefined
            }
            queuePending={messageQueue.pending}
            disabled={!ready || composerDisabled}
            loading={(busy || nativeRunning) && !messageQueue.fallback}
            onStop={chatBusy ? () => void stop() : undefined}
            aria-label={t("messageThisAgent")}
            placeholder={
              nativeRunning && !messageQueue.fallback
                ? `${queueT("steerHint")} · ${queueT("followUpHint")}`
                : t("messageThisAgent")
            }
            minRows={1}
            maxRows={12}
            leadingAction={
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <ConversationTools
                  attachmentsEnabled={attachmentsEnabled}
                  composerText={composerText}
                  disabled={blocked}
                  mcpPromptApiPath={scopeApiPath(mcpPromptApiPath)}
                  mcpResourceApiPath={scopeApiPath(mcpResourceApiPath)}
                  onAddAttachment={addAttachment}
                  onError={setSubmitError}
                  onNewConversation={onNewConversation}
                  runtimeCommands={runtimeCommands}
                  onTextChange={setComposerText}
                  webSearchAvailable={Boolean(webSearchAvailable)}
                  webSearchEnabled={webSearchEnabled}
                  onWebSearchChange={setWebSearchEnabled}
                />
                <span className="flex-1" />
                <ConversationContextUsage busy={busy} usage={contextUsage} />
                {reasoningAvailable ? (
                  <ReasoningEffortControl
                    value={reasoningEffort}
                    inherited={inheritedReasoningEffort}
                    disabled={blocked}
                    onChange={setReasoningEffort}
                  />
                ) : null}
                {modelPicker}
              </div>
            }
          />
        </div>
        {composerStatus ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {composerStatus}
          </p>
        ) : null}
        <div ref={setBelowEditorElement} className="space-y-3 empty:hidden" />
      </div>
    </div>
  );
}
