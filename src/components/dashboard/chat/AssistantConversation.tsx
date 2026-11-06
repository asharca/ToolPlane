"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { FileUIPart, UIMessage } from "ai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowUp,
  Bot,
  Brain,
  Database,
  Globe,
  GitBranch,
  Loader2,
  Paperclip,
  Pencil,
  Square,
  ScrollText,
  SlidersHorizontal,
  type LucideIcon,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import {
  AssistantMarkdown,
  ConversationMessageShell,
  ConversationActivity,
  conversationUserBubbleClassName,
  ToolPayload,
  toolResultUnboundedHeight,
  toolOutputText,
} from "@/components/dashboard/ConversationMessage";
import {
  conversationComposerDockClassName,
  conversationComposerSurfaceClassName,
} from "@/components/dashboard/ConversationComposer";
import {
  ComposerModelSelect,
  type ModelSelection,
  type ModelProviderOption,
} from "@/components/dashboard/ComposerModelSelect";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
} from "@/components/agents/message";
import { ToolResult } from "@/components/agents/tool-result";
import { MessageScroller } from "@/components/agents/message-scroller";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { CopyButton, copyText } from "@/components/dashboard/CopyButton";
import { cn } from "@/lib/utils";
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import {
  CHAT_EXECUTION_LABELS,
  readChatExecutionProgress,
  type ChatExecutionProgress,
} from "@/lib/chat/execution-stage";
import {
  ComposerMenu,
  type ComposerMenuItem,
  useComposerMenu,
} from "@/components/dashboard/composer-menu";
import { useMcpComposerMenu } from "@/components/dashboard/composer-mcp-menu";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import type { ReasoningEffort } from "@/lib/agents/constants";
import { ComposerToolsButton } from "@/components/dashboard/ComposerToolsButton";
import { ComposerToolbarCustomizer } from "@/components/dashboard/ComposerToolbarCustomizer";
import {
  RevisionUpgradeNotice,
  McpToolsUpdatedNote,
} from "@/components/dashboard/RevisionUpgradeNotice";
import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";

const TOOLBAR_KEY = "toolplane.chat.composer.toolbar";
const TOOLBAR_EVENT = "toolplane:chat-composer-toolbar";
const DEFAULT_TOOLBAR_IDS = [
  "mcp-prompts",
  "resources",
  "reasoning",
  "web-search",
  "attachments",
];
const DEFAULT_TOOLBAR_VALUE = JSON.stringify(DEFAULT_TOOLBAR_IDS);

function subscribeToolbar(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(TOOLBAR_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(TOOLBAR_EVENT, listener);
  };
}

function readToolbar() {
  try {
    return localStorage.getItem(TOOLBAR_KEY) ?? DEFAULT_TOOLBAR_VALUE;
  } catch {
    return DEFAULT_TOOLBAR_VALUE;
  }
}

type ToolbarOption = { id: string; label: string; icon: LucideIcon };

type AssistantUIMessage = UIMessage<unknown, Record<string, unknown>>;
type Confirmation = {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: string;
  error?: string | null;
  result?: unknown;
};
type Snapshot = {
  runId: string;
  cursor: number;
  status: string;
  phase: string;
  execution?: ChatExecutionProgress | null;
  stopRequested: boolean;
  error?: string | null;
  messages: Array<{
    id: string;
    role?: string;
    parts: AssistantUIMessage["parts"];
  }>;
  confirmations: Confirmation[];
};
type Submission = {
  key: string;
  text: string;
  files: FileUIPart[];
  messageId: string;
  editMessageId?: string;
  regenerateId?: string;
  reasoningEffort: ReasoningEffort;
  webSearchEnabled: boolean;
  modelOverride?: ModelSelection;
};

export function reconcileAssistantMessages(
  messages: AssistantUIMessage[],
  savedMessages: Snapshot["messages"],
  optimisticUserId?: string,
  preferLiveAssistant = false,
): AssistantUIMessage[] {
  const saved = new Map(savedMessages.map((message) => [message.id, message]));
  const savedUser = savedMessages.find((message) => message.role === "user");
  const merged = new Map<string, AssistantUIMessage>();
  for (const message of messages) {
    const replacement =
      message.id === optimisticUserId ? savedUser : saved.get(message.id);
    const next =
      replacement && !(preferLiveAssistant && message.role === "assistant")
        ? ({
            ...message,
            ...replacement,
            role: replacement.role ?? message.role,
          } as AssistantUIMessage)
        : message;
    merged.set(next.id, next);
  }
  for (const message of savedMessages) {
    if (!merged.has(message.id))
      merged.set(message.id, {
        ...message,
        role: message.role ?? "assistant",
      } as AssistantUIMessage);
  }
  return Array.from(merged.values());
}

function AssistantToolResult({
  toolName,
  input,
  result,
  error,
  status,
}: Omit<Confirmation, "id" | "toolCallId">) {
  const t = useTranslations("console.chatAssistants");
  const toolT = useTranslations("console.agents");
  const common = useTranslations("common");
  const output = toolOutputText(result);
  return (
    <ToolResult
      tool={null}
      title={toolName}
      kind="request"
      status={
        status === "succeeded"
          ? "success"
          : status === "executing"
            ? "running"
            : "error"
      }
      defaultOpen={status !== "succeeded" && status !== "executing"}
      maxHeight={toolResultUnboundedHeight}
      className="my-2 w-full"
    >
      <div className="space-y-3">
        {result !== undefined && result !== null && (
          <CopyButton
            text={output ?? JSON.stringify(result, null, 2)}
            label={common("copy")}
          />
        )}
        {input !== undefined && (
          <ToolPayload label={toolT("toolInput")} language="json">
            {JSON.stringify(input, null, 2)}
          </ToolPayload>
        )}
        {result !== undefined && result !== null && (
          <ToolPayload
            label={t("toolResult")}
            language={output === undefined ? "json" : "text"}
          >
            {output ?? JSON.stringify(result, null, 2)}
          </ToolPayload>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {status === "execution_unknown" && (
          <p role="alert" className="text-sm text-destructive">
            {t("unknownOutcome")}
          </p>
        )}
      </div>
    </ToolResult>
  );
}

/** An Assistant observes a server-owned Run; disconnecting never cancels it. */
export function AssistantConversation({
  threadId,
  revision,
  pinnedRevision,
  readOnly,
  initialMessages,
  draftText: text,
  onDraftTextChange: setText,
  onConversationChanged,
  onStartBranch,
  onThreadUpgraded,
  reasoningAvailable = false,
  attachmentUploadUrl,
  assistantName,
  assistantDescription,
  mcpToolChanges,
  providers,
  defaultModelSelection,
  modelSelection,
  onModelChange,
}: {
  threadId: string;
  revision: number;
  readOnly: boolean;
  pinnedRevision?: number | null;
  initialMessages: AgentUIMessage[];
  draftText: string;
  onDraftTextChange: Dispatch<SetStateAction<string>>;
  onConversationChanged: () => void;
  onStartBranch: (id: string) => void;
  onThreadUpgraded?: () => void;
  reasoningAvailable?: boolean;
  attachmentUploadUrl?: string;
  assistantName: string;
  assistantDescription?: string | null;
  mcpToolChanges?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  };
  providers: ModelProviderOption[];
  defaultModelSelection: ModelSelection | null;
  modelSelection: ModelSelection | null;
  onModelChange: (selection: ModelSelection | null) => void;
}) {
  const t = useTranslations("console.chatAssistants");
  const composerT = useTranslations("console.agents");
  const common = useTranslations("common");
  const workT = useTranslations("console.work");
  const copyT = useTranslations("console.common");
  const [editMessageId, setEditMessageId] = useState<string | undefined>();
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const toolbarValue = useSyncExternalStore(
    subscribeToolbar,
    readToolbar,
    () => DEFAULT_TOOLBAR_VALUE,
  );
  const api = `/api/v1/chat/threads/${threadId}/turns`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes drive the textarea height.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [executionProgress, setExecutionProgress] =
    useState<ChatExecutionProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const pending = useRef<Submission | null>(null);
  const admittedBody = useRef<{
    key: string;
    body: Record<string, unknown>;
  } | null>(null);
  const cursor = useRef<{ runId: string; sequence: number } | null>(null);
  const turnIdentity = useRef<{
    runId: string;
    clientMessageId: string;
  } | null>(null);
  const restoreGeneration = useRef(0);
  const liveStatus = useRef("ready");
  const subscription = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const receiveExecutionProgress = useCallback((value: unknown) => {
    const progress = readChatExecutionProgress(value);
    if (!progress || progress.runId !== cursor.current?.runId) return;
    setExecutionProgress((previous) =>
      previous?.runId === progress.runId &&
      previous.sequence >= progress.sequence
        ? previous
        : progress,
    );
  }, []);
  const subscribeSavedProgress = useCallback(() => {
    if (!cursor.current || !mounted.current) return;
    subscription.current?.abort();
    const controller = new AbortController();
    subscription.current = controller;
    const { runId, sequence } = cursor.current;
    void (async () => {
      const response = await fetch(
        `${api}/stream?runId=${encodeURIComponent(runId)}&afterSequence=${sequence}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.statusText);
      if (!response.body) return;
      setConnected(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done || controller.signal.aborted) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            const event = JSON.parse(line.slice(6));
            if (event.type === "data-chat-execution")
              receiveExecutionProgress(event.data);
            if (
              event.type === "data-chat-cursor" &&
              event.data?.runId === runId &&
              Number.isSafeInteger(event.data.sequence) &&
              event.data.sequence > (cursor.current?.sequence ?? -1)
            )
              cursor.current = event.data;
          }
        }
      } finally {
        reader.releaseLock();
      }
    })().catch((cause: Error) => {
      if (!controller.signal.aborted) {
        setConnected(false);
        setError(cause.message);
      }
    });
  }, [api, receiveExecutionProgress]);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<AssistantUIMessage>({
        api,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.status === 503) {
            const failure = await response
              .clone()
              .json()
              .catch(() => null);
            if (failure?.error === "runtime_not_ready")
              throw new Error("runtime_not_ready");
          }
          if (!response.ok) {
            const failure = await response
              .clone()
              .json()
              .catch(() => null);
            if (
              typeof failure?.error === "string" &&
              failure.error.startsWith("CHAT_MODEL_")
            )
              throw new Error(failure.error);
          }
          const runId = response.headers.get("X-Chat-Run-Id");
          if (runId)
            cursor.current = {
              runId,
              sequence: Number(response.headers.get("X-Chat-Cursor") ?? 0),
            };
          if (runId && pending.current)
            turnIdentity.current = {
              runId,
              clientMessageId: pending.current.messageId,
            };
          return response;
        },
        prepareSendMessagesRequest: ({ messages, trigger }) => {
          const request = pending.current;
          if (!request)
            throw new Error("No intentional Assistant turn was submitted");
          if (admittedBody.current?.key !== request.key)
            admittedBody.current = {
              key: request.key,
              body: {
                reasoningEffort: request.reasoningEffort,
                webSearchEnabled: request.webSearchEnabled,
                modelOverride: request.modelOverride,
                messages: messages.slice(-1),
                trigger,
                messageId: request.editMessageId ?? request.regenerateId,
                idempotencyKey: request.key,
              },
            };
          return { body: admittedBody.current.body };
        },
      }),
    [api],
  );
  const chat = useChat<AssistantUIMessage>({
    transport,
    messages: initialMessages,
    onData: (part) => {
      if (part.type === "data-chat-execution")
        receiveExecutionProgress(part.data);
      if (part.type === "data-chat-cursor") {
        const data = part.data as { runId: string; sequence: number };
        if (
          !cursor.current ||
          cursor.current.runId !== data.runId ||
          data.sequence > cursor.current.sequence
        )
          cursor.current = data;
      }
    },
    onFinish: ({ isError, isDisconnect }) => {
      if (!isError && !isDisconnect) {
        pending.current = null;
      }
      onConversationChanged();
    },
    onError: (cause) => {
      setError(cause.message);
      setConnected(false);
    },
  });
  liveStatus.current = chat.status;
  const activeHistory = useRef(chat.messages);
  activeHistory.current = chat.messages;
  const { setMessages } = chat;
  const restore = useCallback(
    async (subscribe: boolean) => {
      const generation = restoreGeneration.current;
      const response = await fetch(`${api}/stream?state=1`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error((await response.json()).error || response.statusText);
      const candidate =
        response.status === 204
          ? null
          : ((await response.json()) as Snapshot | null);
      if (generation !== restoreGeneration.current) return;
      // A poll started during admission may still return the preceding turn.
      // Never let that terminal snapshot replace the newly admitted Run cursor.
      if (
        candidate &&
        candidate.status !== "pending" &&
        pending.current &&
        (turnIdentity.current?.clientMessageId !== pending.current.messageId ||
          candidate.runId !== turnIdentity.current?.runId)
      ) {
        setRestored(true);
        return;
      }
      const state =
        candidate &&
        (candidate.status === "pending" ||
          pending.current ||
          !activeHistory.current.length ||
          candidate.messages.some(
            (saved) =>
              saved.role === "assistant" &&
              activeHistory.current.some((message) => message.id === saved.id),
          ))
          ? candidate
          : null;
      setSnapshot(state);
      setConnected(true);
      if (state) {
        cursor.current = {
          runId: state.runId,
          sequence:
            cursor.current?.runId === state.runId
              ? Math.max(cursor.current.sequence, state.cursor)
              : state.cursor,
        };
        receiveExecutionProgress(state.execution);
        // Do not inject snapshots into the SDK's actively mutating stream array.
        // Rendering reconciles that stream with durable, turn-bound identities.
        if (
          liveStatus.current !== "submitted" &&
          liveStatus.current !== "streaming"
        )
          setMessages((messages) =>
            reconcileAssistantMessages(
              messages,
              state.messages,
              turnIdentity.current?.runId === state.runId
                ? turnIdentity.current.clientMessageId
                : undefined,
            ),
          );
        // A mid-text cursor is not an AI SDK stream-start frame. Reconnect consumes
        // persisted cursor envelopes; snapshots remain the rendering authority.
        if (subscribe && state.status === "pending") subscribeSavedProgress();
      }
      setRestored(true);
    },
    [api, subscribeSavedProgress, setMessages, receiveExecutionProgress],
  );
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const refresh = async () => {
      try {
        if (active) await restore(false);
      } catch (cause) {
        if (active) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void restore(true).catch((cause: Error) => {
      if (active) {
        setError(cause.message);
        setRestored(true);
      }
    });
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => {
      active = false;
      mounted.current = false;
      subscription.current?.abort();
      clearInterval(timer);
    };
  }, [restore]);
  const running =
    snapshot?.status === "pending" ||
    chat.status === "submitted" ||
    chat.status === "streaming";
  const localRunIsActive =
    pending.current &&
    turnIdentity.current?.clientMessageId === pending.current.messageId &&
    (chat.status === "submitted" ||
      chat.status === "streaming" ||
      !snapshot ||
      (snapshot.runId === turnIdentity.current.runId &&
        snapshot.status === "pending"));
  const activeRunId =
    (localRunIsActive ? turnIdentity.current?.runId : undefined) ??
    (snapshot?.status === "pending" ? snapshot.runId : undefined) ??
    cursor.current?.runId;
  const hasContinuingRun =
    snapshot?.status === "pending" ||
    Boolean(
      pending.current &&
        cursor.current &&
        cursor.current.runId !== snapshot?.runId,
    );
  const currentExecution =
    executionProgress?.runId === activeRunId
      ? executionProgress
      : snapshot?.runId === activeRunId
        ? snapshot?.execution
        : null;
  const executionStage =
    currentExecution?.stage ??
    (chat.status === "submitted" ? "queued" : "preparing");
  const executionLabel = workT(CHAT_EXECUTION_LABELS[executionStage]);
  const submit = async (retry: boolean) => {
    if (readOnly || running || uploading || !restored) return;
    setError(null);
    if (!retry) {
      if (!text.trim() && !files.length) return;
      restoreGeneration.current += 1;
      subscription.current?.abort();
      cursor.current = null;
      turnIdentity.current = null;
      setSnapshot(null);
      setExecutionProgress(null);
      pending.current = {
        key: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        editMessageId,
        text,
        files,
        reasoningEffort,
        webSearchEnabled,
        modelOverride: modelSelection ?? undefined,
      };
      setText("");
      setFiles([]);
      setEditMessageId(undefined);
    }
    const request = pending.current;
    if (!request) return;
    try {
      // A transport retry reuses the exact user message ID and idempotency key.
      if (request.regenerateId)
        await chat.regenerate({ messageId: request.regenerateId });
      else {
        if (retry)
          setMessages((messages) =>
            messages.filter((message) => message.id !== request.messageId),
          );
        await chat.sendMessage({
          id: request.messageId,
          role: "user",
          parts: [{ type: "text", text: request.text }, ...request.files],
        });
      }
      await restore(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const regenerate = async (messageId: string) => {
    if (readOnly || running || snapshot?.phase === "execution_unknown") return;
    restoreGeneration.current += 1;
    subscription.current?.abort();
    cursor.current = null;
    turnIdentity.current = null;
    setSnapshot(null);
    setExecutionProgress(null);
    pending.current = {
      key: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      regenerateId: messageId,
      text: "",
      files: [],
      reasoningEffort,
      webSearchEnabled,
      modelOverride: modelSelection ?? undefined,
    };
    await submit(true);
  };
  const upload = async (selected: FileList | null) => {
    if (!selected || !attachmentUploadUrl) return;
    if (selected.length + files.length > 5) {
      setError(composerT("attachmentLimitReached", { count: 5 }));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(selected)) {
        const url = new URL(attachmentUploadUrl, window.location.origin);
        url.searchParams.set("filename", file.name);
        const response = await fetch(`${url.pathname}${url.search}`, {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        const body = await response.json();
        if (!response.ok || !body.url)
          throw new Error(body.error || composerT("attachmentUploadFailed"));
        setFiles((previous) => [
          ...previous,
          {
            type: "file",
            url: body.url,
            filename: body.name ?? file.name,
            mediaType: body.mimeType ?? file.type,
          },
        ]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };
  const stop = async () => {
    try {
      const turnId = activeRunId;
      if (!turnId) return;
      const response = await fetch(api, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const result = (await response.json()) as {
        stopRequested: boolean;
        turnId: string;
      };
      if (!result.stopRequested) setError(t("stopNotAccepted"));
      await restore(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const messages = reconcileAssistantMessages(
    chat.messages,
    snapshot?.messages ?? [],
    turnIdentity.current?.runId === snapshot?.runId
      ? turnIdentity.current?.clientMessageId
      : undefined,
    chat.status === "submitted" || chat.status === "streaming",
  );
  const displayMessages: AssistantUIMessage[] =
    running && messages.at(-1)?.role !== "assistant"
      ? [
          ...messages,
          {
            id: `${threadId}-pending-response`,
            role: "assistant",
            parts: [],
          },
        ]
      : messages;
  const empty = displayMessages.length === 0;
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

  const toolbarOptions: ToolbarOption[] = [
    { id: "mcp-prompts", label: composerT("mcpPrompts"), icon: ScrollText },
    { id: "resources", label: composerT("mcpResources"), icon: Database },
    ...(reasoningAvailable
      ? [{ id: "reasoning", label: composerT("reasoningEffort"), icon: Brain }]
      : []),
    { id: "web-search", label: composerT("enableWebSearch"), icon: Globe },
    ...(attachmentUploadUrl
      ? [
          {
            id: "attachments",
            label: composerT("addAttachment"),
            icon: Paperclip,
          },
        ]
      : []),
  ];
  const mcpMenu = useMcpComposerMenu({
    composerPath: `/api/v1/chat/threads/${threadId}/composer`,
    promptsPath: `/api/v1/chat/threads/${threadId}/prompts`,
  });
  const menuItems: ComposerMenuItem[] = [
    ...(attachmentUploadUrl
      ? [
          {
            id: "attachments",
            label: uploading
              ? composerT("uploadingAttachments")
              : composerT("addAttachment"),
            icon: Paperclip,
            disabled: uploading,
          },
        ]
      : []),
    {
      id: "web-search",
      label: webSearchEnabled
        ? composerT("disableWebSearch")
        : composerT("enableWebSearch"),
      icon: Globe,
      pressed: webSearchEnabled,
    },
    ...mcpMenu.rootItems,
  ];
  const menu = useComposerMenu({
    text,
    setText,
    textareaRef,
    containerRef: composerRef,
    disabled: readOnly || running,
    rootItems: menuItems,
    views: mcpMenu.views,
    onActivate: async (item, view, insertText) => {
      const handled = await mcpMenu.activate(item, view, (value) =>
        insertText(value),
      );
      if (handled !== null) return handled;
      if (item.id === "attachments") attachmentInput.current?.click();
      if (item.id === "web-search") setWebSearchEnabled((value) => !value);
      return undefined;
    },
    onError: setError,
  });
  let pinnedIds = DEFAULT_TOOLBAR_IDS;
  try {
    const parsed: unknown = JSON.parse(toolbarValue);
    if (Array.isArray(parsed))
      pinnedIds = [...new Set(parsed)].filter(
        (id): id is string =>
          typeof id === "string" && DEFAULT_TOOLBAR_IDS.includes(id),
      );
  } catch {
    /* Ignore obsolete or invalid browser preferences. */
  }
  const pinnedOptions = pinnedIds.flatMap(
    (id) => toolbarOptions.find((option) => option.id === id) ?? [],
  );

  function saveToolbar(ids: string[]) {
    try {
      localStorage.setItem(TOOLBAR_KEY, JSON.stringify(ids));
      window.dispatchEvent(new Event(TOOLBAR_EVENT));
    } catch {
      setError(composerT("toolbarSaveFailed"));
    }
  }

  function activateToolbarAction(id: string) {
    if (id === "mcp-prompts") menu.openView("mcp-prompts");
    if (id === "resources") menu.openView("mcp-resources");
    if (id === "attachments") attachmentInput.current?.click();
  }

  function renderToolbarAction(option: ToolbarOption) {
    if (option.id === "reasoning")
      return (
        <ReasoningEffortControl
          value={reasoningEffort}
          disabled={readOnly || running}
          onChange={setReasoningEffort}
        />
      );
    if (option.id === "web-search")
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "size-8 rounded-full",
            webSearchEnabled &&
              "bg-primary/10 text-primary hover:bg-primary/15",
          )}
          aria-label={option.label}
          aria-pressed={webSearchEnabled}
          title={option.label}
          disabled={readOnly || running}
          onClick={() => setWebSearchEnabled((value) => !value)}
        >
          <option.icon className="size-4 shrink-0" />
        </Button>
      );
    const Icon =
      option.id === "attachments" && uploading ? Loader2 : option.icon;
    const label =
      option.id === "attachments" && uploading
        ? composerT("uploadingAttachments")
        : option.label;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        aria-label={label}
        title={option.label}
        disabled={
          readOnly || running || (option.id === "attachments" && uploading)
        }
        onClick={() => activateToolbarAction(option.id)}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            option.id === "attachments" && uploading && "animate-spin",
          )}
        />
      </Button>
    );
  }
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        empty && "overflow-y-auto",
      )}
    >
      {/* Only states the reader can act on or is waiting for; routine run/revision metadata stays hidden. */}
      {((hasContinuingRun && !connected) ||
        (snapshot?.status === "pending" && snapshot.stopRequested)) && (
        <div
          className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2 text-xs text-muted-foreground sm:px-6"
          aria-live="polite"
        >
          {snapshot?.status === "pending" && snapshot.stopRequested ? (
            <span>{t("stopRequested")}</span>
          ) : null}
          {hasContinuingRun && !connected ? (
            <>
              <span>{t("connectionOffline")}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void restore(true).catch((cause: Error) =>
                    setError(cause.message),
                  )
                }
              >
                {t("reconnect")}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {!readOnly &&
        onThreadUpgraded &&
        pinnedRevision != null &&
        pinnedRevision < revision && (
          <RevisionUpgradeNotice
            url={`/api/v1/chat/threads/${threadId}/revision`}
            fromVersion={pinnedRevision}
            targetVersion={revision}
            disabled={hasContinuingRun}
            onUpgraded={onThreadUpgraded}
          />
        )}
      <MessageScroller
        className="min-h-0 flex-1"
        label={assistantName}
        busy={running}
        contentClassName={cn(
          "px-4 sm:px-6",
          empty
            ? "flex min-h-full flex-col justify-end pb-6 pt-8"
            : "space-y-6 pb-8 pt-6",
        )}
      >
        {empty ? (
          <div className="mx-auto w-full max-w-3xl text-center">
            <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-muted">
              <Bot className="size-7" strokeWidth={1.5} />
            </div>
            <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
              {assistantName}
            </h2>
            {assistantDescription ? (
              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                {assistantDescription}
              </p>
            ) : null}
            {mcpToolChanges ? (
              <McpToolsUpdatedNote {...mcpToolChanges} />
            ) : null}
          </div>
        ) : null}
        {displayMessages.map((message, messageIndex) => {
          const assistant = message.role === "assistant";
          const streaming =
            assistant && running && messageIndex === displayMessages.length - 1;
          const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n\n");
          const actionVisibility =
            messageIndex === displayMessages.length - 1
              ? ""
              : "opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto motion-reduce:transition-none";
          const showIdentity =
            messageIndex === 0 ||
            displayMessages[messageIndex - 1]?.role !== "assistant";
          const modelPart = message.parts.find(
            (part) => part.type === "data-model",
          );
          const model = (
            modelPart && "data" in modelPart ? modelPart.data : undefined
          ) as { providerId?: string; model?: string } | undefined;
          const modelName =
            model?.model ??
            (streaming
              ? (
                  pending.current?.modelOverride ??
                  modelSelection ??
                  defaultModelSelection
                )?.model
              : undefined);
          const providerName = providers.find(
            (provider) => provider.id === model?.providerId,
          )?.name;
          const replyMetadata =
            assistant && modelName ? (
              <div
                className={cn(
                  "flex min-w-0 flex-wrap items-center gap-2 text-[11px] font-normal text-muted-foreground",
                  actionVisibility,
                )}
              >
                <span
                  data-ui="assistant-reply-model"
                  className="truncate"
                  title={[providerName, modelName].filter(Boolean).join(" · ")}
                >
                  {modelName}
                </span>
              </div>
            ) : null;
          const processItems: Array<{
            id: string;
            type: "text";
            content: ReactNode;
          }> = [];
          let processFailed = false;
          if (assistant) {
            message.parts.forEach((part, index) => {
              const id = `${message.id}-${index}`;
              if (part.type === "reasoning" && part.text.trim()) {
                processItems.push({
                  id,
                  type: "text",
                  content: (
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {workT(streaming && !text ? "thinking" : "thought")}
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {part.text}
                      </pre>
                    </div>
                  ),
                });
              }
              if (
                part.type !== "dynamic-tool" &&
                !part.type.startsWith("tool-")
              )
                return;
              const tool = part as {
                type: string;
                toolName?: string;
                toolCallId?: string;
                state?: string;
                input?: unknown;
                output?: unknown;
                errorText?: string;
              };
              const receipt = snapshot?.confirmations.find(
                (item) => item.toolCallId === tool.toolCallId,
              );
              const status =
                receipt?.status ??
                (tool.state === "output-error"
                  ? "failed"
                  : tool.state === "output-available"
                    ? "succeeded"
                    : "executing");
              if (status !== "succeeded" && status !== "executing")
                processFailed = true;
              processItems.push({
                id: tool.toolCallId ?? id,
                type: "text",
                content: (
                  <AssistantToolResult
                    toolName={tool.toolName ?? tool.type.slice(5)}
                    input={receipt?.input ?? tool.input}
                    result={receipt?.result ?? tool.output}
                    error={receipt?.error ?? tool.errorText}
                    status={status}
                  />
                ),
              });
            });
            if (
              message.id ===
              (snapshot?.messages.findLast((item) => item.role === "assistant")
                ?.id ??
                displayMessages.findLast((item) => item.role === "assistant")
                  ?.id)
            ) {
              for (const receipt of snapshot?.confirmations ?? []) {
                if (
                  messages.some((item) =>
                    item.parts.some(
                      (part) =>
                        "toolCallId" in part &&
                        part.toolCallId === receipt.toolCallId,
                    ),
                  )
                )
                  continue;
                if (
                  receipt.status !== "succeeded" &&
                  receipt.status !== "executing"
                )
                  processFailed = true;
                processItems.push({
                  id: receipt.id,
                  type: "text",
                  content: <AssistantToolResult {...receipt} />,
                });
              }
            }
          }
          const messageBody = (
            <>
              {message.parts.map((part, index) =>
                part.type === "file" ? (
                  <a
                    // biome-ignore lint/suspicious/noArrayIndexKey: Streamed attachments are append-only; retain duplicate URLs as separate items.
                    key={`${message.id}-${index}`}
                    href={part.url}
                    className="my-1 inline-flex max-w-full items-center gap-2 rounded-xl border border-border/60 bg-background px-3 py-2 text-xs underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Paperclip
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {part.filename ?? part.mediaType}
                  </a>
                ) : null,
              )}
              {assistant && (streaming || processItems.length > 0) ? (
                <div data-ui="assistant-process" className="w-full">
                  <ConversationActivity
                    contentType="text"
                    status={streaming ? "working" : "complete"}
                    defaultOpen={processFailed}
                    collapseOnComplete={!processFailed}
                    activeLabel={
                      streaming ? executionLabel : workT("processing")
                    }
                    summary={
                      streaming
                        ? executionLabel
                        : workT(processFailed ? "processFailed" : "processed")
                    }
                    items={processItems}
                  />
                </div>
              ) : null}
              {text ? (
                assistant ? (
                  <AssistantMarkdown text={text} streaming={streaming} />
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {text}
                  </p>
                )
              ) : null}
            </>
          );
          const branchAction = (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("newBranch")}
              title={t("newBranch")}
              className={messageActionClassName}
              disabled={readOnly || running}
              onClick={() => onStartBranch(message.id)}
            >
              <GitBranch className="size-3.5" />
            </Button>
          );
          return (
            <ConversationMessageShell
              key={message.id}
              id={`chat-message-${message.id}`}
              from={assistant ? "assistant" : "user"}
              name={assistantName}
              showIdentity={showIdentity}
              metadata={replyMetadata}
              className="group/message mx-auto w-full max-w-3xl scroll-mt-6 break-words"
              aria-label={assistant ? assistantName : t("branchUser")}
              aria-busy={streaming || undefined}
            >
              {showIdentity ? null : replyMetadata}
              {assistant ? (
                <StreamingResponse
                  status={
                    streaming
                      ? "streaming"
                      : processFailed
                        ? "error"
                        : "complete"
                  }
                  copyText={text}
                  onCopy={
                    text
                      ? async () => {
                          if (!(await copyText(text))) {
                            const message = copyT("copyFailed");
                            setError(message);
                            throw new Error(message);
                          }
                        }
                      : undefined
                  }
                  onRetry={
                    !readOnly &&
                    !running &&
                    snapshot?.phase !== "execution_unknown"
                      ? () => void regenerate(message.id)
                      : undefined
                  }
                  announce={false}
                  actionsClassName={actionVisibility}
                  actions={branchAction}
                >
                  {messageBody}
                </StreamingResponse>
              ) : (
                <>
                  <MessageBubble
                    variant="soft"
                    className={conversationUserBubbleClassName}
                  >
                    <MessageBubbleContent>{messageBody}</MessageBubbleContent>
                  </MessageBubble>
                  <MessageFooter className={cn("gap-0.5", actionVisibility)}>
                    {text ? (
                      <CopyButton
                        text={text}
                        label={common("copy")}
                        iconOnly
                        className={messageActionClassName}
                      />
                    ) : null}
                    {branchAction}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={common("edit")}
                      title={common("edit")}
                      className={messageActionClassName}
                      disabled={readOnly || running}
                      onClick={() => {
                        setEditMessageId(message.id);
                        setText(text);
                        setFiles(
                          message.parts.filter((part) => part.type === "file"),
                        );
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </MessageFooter>
                </>
              )}
            </ConversationMessageShell>
          );
        })}
      </MessageScroller>
      {error && (
        <p
          role="alert"
          className="mx-auto my-2 w-[calc(100%-2rem)] max-w-3xl rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error === "runtime_not_ready"
            ? t("runtimeNotReady")
            : t.has(`modelErrors.${error}`)
              ? t(`modelErrors.${error}`)
              : error}
        </p>
      )}
      {snapshot?.error && (
        <p
          role="alert"
          className="mx-auto my-2 w-[calc(100%-2rem)] max-w-3xl rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {snapshot.error}
        </p>
      )}
      {snapshot?.phase === "execution_unknown" &&
        !snapshot.confirmations.some(
          (item) => item.status === "execution_unknown",
        ) && (
          <p
            role="alert"
            className="mx-auto my-2 w-[calc(100%-2rem)] max-w-3xl rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {t("unknownOutcome")}
          </p>
        )}
      <div
        ref={composerRef}
        data-ui="chat.composer"
        className={cn(
          conversationComposerDockClassName,
          empty && "mb-[min(20dvh,10rem)] before:hidden",
        )}
      >
        <ComposerMenu
          menu={menu}
          className="left-3 sm:left-4"
          footer={{
            label: composerT("customizeToolbar"),
            icon: SlidersHorizontal,
            onSelect: () => setCustomizing(true),
          }}
        />
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto]",
            conversationComposerSurfaceClassName,
          )}
        >
          <div className="order-3 col-start-1 flex min-w-0 flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1 text-muted-foreground">
            <ComposerToolsButton
              open={menu.open}
              disabled={readOnly || running}
              aria-label={composerT("openComposerTools")}
              title={composerT("openComposerTools")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={menu.openFromButton}
            />
            {pinnedOptions.map((option) => (
              <span
                key={option.id}
                data-composer-shortcut={option.id}
                className="inline-flex min-w-0"
              >
                {renderToolbarAction(option)}
              </span>
            ))}
          </div>
          {files.map((file) => (
            <Button
              key={file.url}
              size="sm"
              variant="ghost"
              className="order-1 col-span-2 mx-4 mt-3 max-w-[calc(100%-2rem)] justify-self-start gap-2 rounded-full bg-muted/50 text-xs"
              aria-label={composerT("removeAttachment", {
                name: file.filename ?? file.mediaType,
              })}
              onClick={() =>
                setFiles((previous) =>
                  previous.filter((item) => item.url !== file.url),
                )
              }
            >
              <span className="truncate">
                {file.filename ?? file.mediaType}
              </span>
              <X className="size-3 shrink-0" aria-hidden="true" />
            </Button>
          ))}
          {editMessageId && (
            <div className="order-1 col-span-2 flex items-center gap-2 px-4 pt-3 text-xs">
              {common("edit")}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditMessageId(undefined);
                  setText("");
                  setFiles([]);
                }}
              >
                {common("cancel")}
              </Button>
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
            className="contents"
          >
            <textarea
              ref={textareaRef}
              aria-label={t("sendMessage")}
              value={text}
              placeholder={t("sendMessage")}
              onChange={(event) => {
                setText(event.target.value);
                menu.sync(
                  event.target.value,
                  event.target.selectionStart,
                  event.target.selectionEnd,
                );
              }}
              onSelect={(event) =>
                menu.sync(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd,
                )
              }
              {...menu.comboboxProps}
              disabled={readOnly}
              rows={1}
              onKeyDown={(event) => {
                if (menu.onKeyDown(event)) return;
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="scrollbar-hide order-2 col-span-2 block max-h-[40vh] min-h-12 w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/55 disabled:opacity-60"
            />
            <div className="order-3 col-start-2 flex min-h-9 flex-wrap items-center justify-end gap-1 self-end pb-2.5 pl-1 pr-2.5 pt-1">
              <ComposerModelSelect
                providers={providers}
                defaultSelection={defaultModelSelection}
                value={modelSelection}
                onChange={onModelChange}
              />
              {!running && (
                <Button
                  type="submit"
                  size="icon"
                  className="size-9 rounded-full"
                  aria-label={t("sendMessage")}
                  title={t("sendMessage")}
                  disabled={
                    readOnly ||
                    running ||
                    uploading ||
                    !restored ||
                    (!text.trim() && !files.length)
                  }
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
              )}
              {running && (
                <Button
                  type="button"
                  variant="primary"
                  size="icon"
                  className="size-9 rounded-full"
                  aria-label={t("stopRun")}
                  title={t("stopRun")}
                  disabled={
                    !activeRunId ||
                    (snapshot?.runId === activeRunId && snapshot.stopRequested)
                  }
                  onClick={() => void stop()}
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                </Button>
              )}
              {error && pending.current && !running && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-lg text-xs"
                  onClick={() => void submit(true)}
                >
                  {t("retrySubmission")}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
      {attachmentUploadUrl ? (
        <input
          ref={attachmentInput}
          type="file"
          multiple
          aria-label={composerT("addAttachment")}
          aria-hidden="true"
          tabIndex={-1}
          disabled={readOnly || running || uploading}
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
          className="hidden"
        />
      ) : null}
      <ComposerToolbarCustomizer
        open={customizing}
        onOpenChange={(open) => {
          setCustomizing(open);
          if (!open) textareaRef.current?.focus();
        }}
        title={composerT("customizeToolbar")}
        resetLabel={composerT("resetToolbar")}
        options={toolbarOptions}
        pinnedIds={pinnedOptions.map((option) => option.id)}
        defaultPinnedIds={toolbarOptions.map((option) => option.id)}
        onChange={saveToolbar}
      />
    </div>
  );
}
