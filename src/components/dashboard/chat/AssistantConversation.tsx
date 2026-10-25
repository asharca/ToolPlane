"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { FileUIPart, UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  CornerUpRight,
  GitBranch,
  Loader2,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { AssistantMarkdown } from "@/components/dashboard/ConversationMessage";
import type { HermesUIMessage } from "@/lib/agents/hermes/message-segments";
import { McpPromptPickerButton } from "@/components/dashboard/McpPromptPickerButton";
import { McpResourcePickerButton } from "@/components/dashboard/McpResourcePickerButton";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import type { ReasoningEffort } from "@/lib/agents/constants";
import { FormCheckbox } from "@/components/ui/FormCheckbox";

type AssistantUIMessage = UIMessage<unknown, Record<string, unknown>>;
type Confirmation = {
  id: string;
  toolName: string;
  input: unknown;
  status: string;
  error?: string | null;
  result?: unknown;
  expiresAt?: string | null;
};
type Snapshot = {
  runId: string;
  cursor: number;
  status: string;
  phase: string;
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

/** An Assistant observes a server-owned Run; disconnecting never cancels it. */
export function AssistantConversation({
  threadId,
  revision,
  revisionId,
  pinnedRevision,
  readOnly,
  initialMessages,
  onConversationChanged,
  onBranchChange,
  onStartBranch,
  reasoningAvailable = false,
  attachmentUploadUrl,
}: {
  threadId: string;
  revision: number;
  revisionId: string | null;
  readOnly: boolean;
  pinnedRevision?: number | null;
  initialMessages: HermesUIMessage[];
  onConversationChanged: () => void;
  onBranchChange: (id: string) => void;
  onStartBranch: (id: string) => void;
  reasoningAvailable?: boolean;
  attachmentUploadUrl?: string;
}) {
  const t = useTranslations("console.chatAssistants");
  const composerT = useTranslations("console.agents");
  const common = useTranslations("common");
  const [editMessageId, setEditMessageId] = useState<string | undefined>();
  const [files, setFiles] = useState<FileUIPart[]>([]);
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const api = `/api/v1/chat/threads/${threadId}/turns`;
  const [text, setText] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
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
  }, [api]);
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
        cursor.current = { runId: state.runId, sequence: state.cursor };
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
    [api, subscribeSavedProgress, setMessages],
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
      pending.current = {
        key: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        editMessageId,
        text,
        files,
        reasoningEffort,
        webSearchEnabled,
      };
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
      setText("");
      setFiles([]);
      setEditMessageId(undefined);
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
    pending.current = {
      key: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      regenerateId: messageId,
      text: "",
      files: [],
      reasoningEffort,
      webSearchEnabled,
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
  const decide = async (confirmationId: string, approved: boolean) => {
    if (deciding) return;
    setDeciding(confirmationId);
    try {
      const response = await fetch(`${api}/confirmations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationId, approved }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await restore(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(null);
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs"
        aria-live="polite"
      >
        <span>
          {t("currentRevision")}: {revision}
        </span>
        <span title={revisionId ?? undefined}>
          {t("pinnedRevision")}:{" "}
          {pinnedRevision ?? revisionId ?? t("unresolvedRevision")}
        </span>
        {hasContinuingRun && (
          <span>
            {connected ? t("connectionOnline") : t("connectionOffline")}
          </span>
        )}
        {snapshot && (
          <span>
            {t("runStatus")}: {snapshot.phase}
            {snapshot.status === "pending" && snapshot.stopRequested
              ? ` · ${t("stopRequested")}`
              : ""}
          </span>
        )}
        {hasContinuingRun && !connected && (
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
        )}
      </div>
      {pinnedRevision != null && pinnedRevision !== revision && (
        <p
          role="status"
          className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          {t("conversationRevisionOutdated", {
            pinned: pinnedRevision,
            current: revision,
          })}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" role="log">
        {reconcileAssistantMessages(
          chat.messages,
          snapshot?.messages ?? [],
          turnIdentity.current?.runId === snapshot?.runId
            ? turnIdentity.current?.clientMessageId
            : undefined,
          chat.status === "submitted" || chat.status === "streaming",
        ).map((message) => (
          <article
            key={message.id}
            className="mx-auto max-w-3xl break-words"
            aria-label={message.role}
          >
            <p className="text-xs font-medium text-muted-foreground">
              {message.role}
            </p>
            {message.parts.map((part, index) => {
              const key = `${message.id}-${index}`;
              if (part.type === "text")
                return <AssistantMarkdown key={key} text={part.text} />;
              if (part.type === "reasoning")
                return (
                  <details key={key}>
                    <summary>{t("runStatus")}</summary>
                    <AssistantMarkdown text={part.text} />
                  </details>
                );
              if (part.type === "file")
                return (
                  <a
                    key={key}
                    href={part.url}
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {part.filename ?? part.mediaType}
                  </a>
                );
              if (part.type === "dynamic-tool" || part.type.startsWith("tool-"))
                return (
                  <pre
                    key={key}
                    className="max-h-64 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs"
                  >
                    {JSON.stringify(part, null, 2)}
                  </pre>
                );
              return null;
            })}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("showBranches")}
                onClick={() => onBranchChange(message.id)}
              >
                <CornerUpRight className="size-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("conversationBranches")}
                disabled={readOnly || running}
                onClick={() => onStartBranch(message.id)}
              >
                <GitBranch className="size-4" />
              </Button>
            </div>
            {message.role === "assistant" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  readOnly || running || snapshot?.phase === "execution_unknown"
                }
                onClick={() => void regenerate(message.id)}
              >
                {common("regenerate")}
              </Button>
            )}
            {message.role === "user" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || running}
                onClick={() => {
                  setEditMessageId(message.id);
                  setText(
                    message.parts
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
                  );
                  setFiles(
                    message.parts.filter((part) => part.type === "file"),
                  );
                }}
              >
                {common("edit")}
              </Button>
            )}
          </article>
        ))}
        {snapshot?.confirmations.map((confirmation) => (
          <section
            key={confirmation.id}
            className="mx-auto max-w-3xl rounded-lg border p-3"
          >
            <p>
              {confirmation.toolName} · {confirmation.status}
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(confirmation.input, null, 2)}
            </pre>
            {confirmation.result !== undefined &&
              confirmation.result !== null && (
                <div>
                  <p className="text-xs font-medium">{t("toolResult")}</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify(confirmation.result, null, 2)}
                  </pre>
                </div>
              )}
            {confirmation.error && <p role="alert">{confirmation.error}</p>}
            {confirmation.status === "awaiting_user" &&
              !snapshot.stopRequested &&
              (confirmation.expiresAt &&
              new Date(confirmation.expiresAt).getTime() <= Date.now() ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {t("toolConfirmationExpired")}
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    disabled={deciding !== null}
                    onClick={() => void decide(confirmation.id, true)}
                  >
                    {t("approveTool")}
                  </Button>
                  <Button
                    disabled={deciding !== null}
                    variant="ghost"
                    onClick={() => void decide(confirmation.id, false)}
                  >
                    {t("denyTool")}
                  </Button>
                  {confirmation.expiresAt && (
                    <span className="text-xs text-muted-foreground">
                      {t("toolConfirmationExpiresIn", {
                        seconds: Math.max(
                          0,
                          Math.round(
                            (new Date(confirmation.expiresAt).getTime() -
                              Date.now()) /
                              1000,
                          ),
                        ),
                      })}
                    </span>
                  )}
                </div>
              ))}
            {confirmation.status === "execution_unknown" && (
              <p role="alert">{t("unknownOutcome")}</p>
            )}
          </section>
        ))}
      </div>
      {error && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error === "runtime_not_ready" ? t("runtimeNotReady") : error}
        </p>
      )}
      {snapshot?.error && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {snapshot.error}
        </p>
      )}
      {snapshot?.phase === "execution_unknown" &&
        !snapshot.confirmations.some(
          (item) => item.status === "execution_unknown",
        ) && (
          <p role="alert" className="px-4 text-sm text-destructive">
            {t("unknownOutcome")}
          </p>
        )}
      <div className="shrink-0 px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
        <div className="mx-auto w-full max-w-3xl space-y-2 rounded-2xl border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25">
          <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-muted-foreground">
            <McpPromptPickerButton
              apiPath={`/api/v1/chat/threads/${threadId}/prompts`}
              disabled={readOnly || running}
              onError={setError}
              onInsert={(value) =>
                setText((previous) =>
                  previous ? `${previous}\n${value}` : value,
                )
              }
            />
            <McpResourcePickerButton
              apiPath={`/api/v1/chat/threads/${threadId}/composer`}
              disabled={readOnly || running}
              onError={setError}
              onInsert={(value) =>
                setText((previous) =>
                  previous ? `${previous}\n${value}` : value,
                )
              }
            />
            {reasoningAvailable && (
              <ReasoningEffortControl
                value={reasoningEffort}
                disabled={readOnly || running}
                onChange={setReasoningEffort}
              />
            )}
            <FormCheckbox
              label={composerT("enableWebSearch")}
              checked={webSearchEnabled}
              disabled={readOnly || running}
              onCheckedChange={setWebSearchEnabled}
              className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs"
            />
            {attachmentUploadUrl && (
              <>
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
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-full"
                  aria-label={
                    uploading
                      ? composerT("uploadingAttachments")
                      : composerT("addAttachment")
                  }
                  title={composerT("addAttachment")}
                  disabled={readOnly || running || uploading}
                  onClick={() => attachmentInput.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Paperclip className="size-4" />
                  )}
                </Button>
              </>
            )}
          </div>
          {files.map((file) => (
            <Button
              key={file.url}
              size="sm"
              variant="ghost"
              className="max-w-full gap-2 rounded-lg bg-muted/50 text-xs"
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
            <div className="flex items-center gap-2 text-xs">
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
            className="space-y-2"
          >
            <textarea
              aria-label={t("sendMessage")}
              value={text}
              placeholder={t("sendMessage")}
              onChange={(event) => setText(event.target.value)}
              disabled={readOnly}
              rows={2}
              onKeyDown={(event) => {
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
              className="scrollbar-hide block max-h-60 min-h-16 w-full resize-y overflow-y-auto bg-transparent px-2 pt-1.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/55 disabled:opacity-60"
            />
            <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
              <Button
                type="submit"
                size="icon"
                className="size-8 rounded-full"
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
              {running && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-full"
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
                  className="h-8 rounded-full text-xs"
                  onClick={() => void submit(true)}
                >
                  {t("retrySubmission")}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
