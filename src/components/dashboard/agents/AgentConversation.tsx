'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChat } from '@ai-sdk/react';
import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useComposerRuntime,
  type AssistantRuntime,
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type FileMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { DefaultChatTransport, generateId } from 'ai';
import {
  Bot,
  ChevronDown,
  Clock3,
  Paperclip,
  Send,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins } from 'streamdown';
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10_000_000;
const MAX_INLINE_IMAGE_BYTES = 5_000_000;
const ATTACHMENT_ERROR_PART = 'data-toolplane-attachment-error';
const SOFT_BREAK_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

type AttachmentContentPart = CompleteAttachment['content'][number];
type DraftSnapshot = {
  text: string;
  files: File[];
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function displayUserText(text: string) {
  return text.replace(/^\[Messaging source:[^\]]+\]\n\n/, '').trim() || text;
}

function formatToolResult(result: unknown) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function mergeDraftText(current: string, restored: string) {
  if (!restored) return current;
  if (!current) return restored;
  if (current === restored || current.startsWith(`${restored}\n`)) return current;
  return `${restored}\n${current}`;
}

async function restoreDraftSnapshot(runtime: AssistantRuntime, snapshot: DraftSnapshot) {
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, snapshot.text));
  const existingFiles = new Set(
    current.attachments.flatMap((attachment) => attachment.file
      ? [`${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`]
      : []),
  );
  for (const file of snapshot.files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingFiles.has(key)) continue;
    await composer.addAttachment(file);
    existingFiles.add(key);
  }
}

async function restoreCreateMessageDraft(runtime: AssistantRuntime | null, message: unknown) {
  if (!runtime || !message || typeof message !== 'object') return;
  const candidate = message as {
    text?: unknown;
    parts?: Array<{
      type?: unknown;
      text?: unknown;
      url?: unknown;
      mediaType?: unknown;
      filename?: unknown;
    }>;
  };
  const parts = Array.isArray(candidate.parts) ? candidate.parts : [];
  const text = [
    typeof candidate.text === 'string' ? candidate.text : '',
    ...parts.flatMap((part) => part.type === 'text' && typeof part.text === 'string'
      ? [part.text]
      : []),
  ].filter(Boolean).join('\n');
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, text));

  for (const part of parts) {
    if (
      part.type !== 'file'
      || typeof part.url !== 'string'
      || typeof part.mediaType !== 'string'
    ) continue;
    const name = typeof part.filename === 'string' ? part.filename : 'attachment';
    await composer.addAttachment({
      name,
      type: part.mediaType.startsWith('image/') ? 'image' : 'file',
      contentType: part.mediaType,
      content: [{
        type: 'file',
        data: part.url,
        mimeType: part.mediaType,
        filename: name,
      }],
    });
  }
}

function UserText({ text }: TextMessagePartProps) {
  return (
    <span className="block whitespace-pre-wrap [&:not(:last-child)]:mb-2">
      {displayUserText(text)}
    </span>
  );
}

function AssistantText() {
  return (
    <StreamdownTextPrimitive
      plugins={{ code }}
      remarkPlugins={SOFT_BREAK_REMARK_PLUGINS}
      security={{
        allowedProtocols: ['http', 'https', 'mailto'],
        allowDataImages: true,
      }}
      defer
      className="space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}

function FilePart({ data, filename }: FileMessagePartProps) {
  const t = useTranslations('console.agents');
  return (
    <a
      href={data}
      download={filename}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-current/20 px-2 py-1 text-xs underline-offset-2 hover:underline"
    >
      <Paperclip className="size-3.5 shrink-0" />
      <span className="truncate">{filename || t('attachment')}</span>
    </a>
  );
}

function ToolPart({ toolName, status, result, isError }: ToolCallMessagePartProps) {
  return (
    <div className="my-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
      <div className={cx('flex items-center gap-2 font-medium', isError ? 'text-red-600 dark:text-red-300' : 'text-foreground')}>
        <Wrench className="size-4 shrink-0" />
        <span className="break-all">{toolName}</span>
        <span className="font-normal text-muted-foreground">({status.type})</span>
      </div>
      {result !== undefined ? (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 text-[11px] leading-relaxed">
          {formatToolResult(result)}
        </pre>
      ) : null}
    </div>
  );
}

function attachmentUrl(attachment: Attachment) {
  const part = attachment.content?.find((item) => item.type === 'file' || item.type === 'image');
  if (part?.type === 'file') return part.data;
  if (part?.type === 'image') return part.image;
  return null;
}

function SentAttachment({ attachment }: { attachment: CompleteAttachment }) {
  const url = attachmentUrl(attachment);
  return (
    <AttachmentPrimitive.Root className="my-1 inline-flex h-8 max-w-full items-center gap-2 rounded-md border border-current/20 px-2 text-xs">
      <Paperclip className="size-3.5 shrink-0" />
      {url ? (
        <a href={url} download={attachment.name} className="min-w-0 truncate underline-offset-2 hover:underline">
          <AttachmentPrimitive.Name />
        </a>
      ) : (
        <span className="min-w-0 truncate"><AttachmentPrimitive.Name /></span>
      )}
    </AttachmentPrimitive.Root>
  );
}

function ComposerAttachment({ attachment }: { attachment: Attachment }) {
  const t = useTranslations('console.agents');
  return (
    <AttachmentPrimitive.Root className="inline-flex h-8 max-w-full items-center gap-2 rounded-md bg-muted px-2 text-xs text-foreground">
      <AttachmentPrimitive.unstable_Thumb className="flex size-5 shrink-0 items-center justify-center rounded bg-background text-[9px] font-semibold uppercase text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      {attachment.status.type === 'running' ? (
        <span className="text-muted-foreground">{Math.round(attachment.status.progress * 100)}%</span>
      ) : null}
      <AttachmentPrimitive.Remove
        aria-label={t('removeAttachment', { name: attachment.name })}
        title={t('removeAttachment', { name: attachment.name })}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function AttachmentPickerButton({
  disabled,
  onClearError,
}: {
  disabled: boolean;
  onClearError: () => void;
}) {
  const t = useTranslations('console.agents');
  const composer = useComposerRuntime();
  const openPicker = useCallback(() => {
    onClearError();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    const accept = composer.getState().attachmentAccept;
    if (accept !== '*') input.accept = accept;
    const removeInput = () => input.remove();
    input.onchange = () => {
      for (const file of Array.from(input.files ?? [])) {
        void composer.addAttachment(file).catch(() => undefined);
      }
      removeInput();
    };
    input.oncancel = removeInput;
    document.body.appendChild(input);
    input.click();
  }, [composer, onClearError]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={openPicker}
      aria-label={t('addAttachment')}
      title={t('addAttachment')}
      className="ui-button-secondary flex size-10 shrink-0 items-center justify-center px-0"
    >
      <Paperclip className="size-[18px]" />
    </button>
  );
}

function UserMessage() {
  const t = useTranslations('console.agents');
  return (
    <MessagePrimitive.Root asChild>
      <article className="flex justify-end gap-3">
        <div className="order-first min-w-0 max-w-[min(72rem,94%)]">
          <div className="mb-1 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('user')}
          </div>
          <div className="min-w-0 break-words rounded-md border border-primary bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
            <MessagePrimitive.Parts components={{ Text: UserText }} />
            <MessagePrimitive.Attachments>
              {({ attachment }) => <SentAttachment attachment={attachment} />}
            </MessagePrimitive.Attachments>
          </div>
        </div>
      </article>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ agentName }: { agentName: string }) {
  return (
    <MessagePrimitive.Root asChild>
      <article className="flex justify-start gap-3">
        <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
          <Bot className="size-[18px]" />
        </div>
        <div className="min-w-0 max-w-[min(72rem,94%)]">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {agentName}
          </div>
          <div className="min-w-0 break-words rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-foreground">
            <MessagePrimitive.Parts
              components={{
                Text: AssistantText,
                File: FilePart,
                tools: { Fallback: ToolPart },
              }}
            />
          </div>
        </div>
      </article>
    </MessagePrimitive.Root>
  );
}

function AgentThread({
  activeConversationId,
  agentName,
  creatingConversation,
  error,
  onClearAttachmentError,
  ready,
  submitError,
  uploadingAttachments,
}: {
  activeConversationId: string | null;
  agentName: string;
  creatingConversation: boolean;
  error?: Error;
  onClearAttachmentError: () => void;
  ready: boolean;
  submitError: string | null;
  uploadingAttachments: boolean;
}) {
  const t = useTranslations('console.agents');
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="flex-1 px-4 py-5 sm:px-5">
          <ThreadPrimitive.Empty>
            <div className="flex min-h-full items-center justify-center">
              <div className="max-w-md px-5 py-6 text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                  <Bot className="size-6" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">{t('startAConversation')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('sendAConsoleMessageHereOrLetAConnectedChannelCreateItsOwnSessionAfterTheFirstInboundMessage')}
                </p>
              </div>
            </div>
          </ThreadPrimitive.Empty>

          <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-5">
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === 'user'
                ? <UserMessage />
                : <AssistantMessage agentName={agentName} />}
            </ThreadPrimitive.Messages>
            <ThreadPrimitive.If running>
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <Clock3 className="size-[18px] shrink-0 animate-pulse" />
                {t('agentIsResponding')}
              </div>
            </ThreadPrimitive.If>
          </div>
        </div>

        <ThreadPrimitive.ScrollToBottom
          aria-label={t('scrollToLatestMessage')}
          title={t('scrollToLatestMessage')}
          className="sticky bottom-3 z-10 mx-auto mb-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground disabled:invisible"
        >
          <ChevronDown className="size-4" />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 border-t border-border bg-card px-4 py-4">
        {error || submitError ? (
          <p role="alert" className="mx-auto mb-3 max-w-[76rem] rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {submitError || error?.message}
          </p>
        ) : null}

        <ComposerPrimitive.Root className="mx-auto max-w-[76rem] rounded-md border border-input bg-background p-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
          <div className="flex flex-wrap gap-2 px-2 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <ComposerAttachment attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </div>
          <ComposerPrimitive.Input
            placeholder={t('messageThisAgent')}
            disabled={!ready || creatingConversation || uploadingAttachments}
            rows={3}
            submitMode="enter"
            className="max-h-56 min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <AttachmentPickerButton
                disabled={!ready || creatingConversation || uploadingAttachments}
                onClearError={onClearAttachmentError}
              />
              <div className="min-w-0 truncate text-xs text-muted-foreground">
                {!ready
                  ? t('chooseAModelBeforeSending')
                  : uploadingAttachments
                    ? t('uploadingAttachments')
                    : activeConversationId
                      ? t('conversationSelected')
                      : t('conversationWillBeCreated')}
              </div>
            </div>

            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                aria-label={t('send')}
                title={t('send')}
                className="ui-button-primary h-10 gap-2 px-4 disabled:opacity-60"
              >
                <Send className="size-[18px] shrink-0" />
                {creatingConversation ? t('creating') : t('send')}
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                aria-label={t('stop')}
                title={t('stop')}
                className="ui-button-secondary h-10 gap-2 px-4"
              >
                <Square className="size-4 fill-current" />
                {t('stop')}
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}

function useAgentAttachmentAdapter({
  agentId,
  ensureConversation,
  isHermes,
  onError,
  onUploadingChange,
  runtimeRef,
  sendConversationIdRef,
  draftSnapshotRef,
  recoveryErrorRef,
}: {
  agentId: string;
  ensureConversation: () => Promise<string>;
  isHermes: boolean;
  onError: (message: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
  runtimeRef: { current: AssistantRuntime | null };
  sendConversationIdRef: { current: string | null };
  draftSnapshotRef: { current: DraftSnapshot | null };
  recoveryErrorRef: { current: string | null };
}) {
  const t = useTranslations('console.agents');
  const activeAttachmentIds = useRef(new Set<string>());
  const activeSends = useRef(0);

  return useMemo<AttachmentAdapter>(() => ({
    accept: '*',
    async add({ file }) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        const message = t('attachmentTooLarge', { name: file.name });
        onError(message);
        throw new Error(message);
      }
      if (activeAttachmentIds.current.size >= MAX_ATTACHMENTS) {
        const message = t('attachmentLimitReached', { count: MAX_ATTACHMENTS });
        onError(message);
        throw new Error(message);
      }

      const id = generateId();
      activeAttachmentIds.current.add(id);
      return {
        id,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name,
        file,
        contentType: file.type || 'application/octet-stream',
        content: [],
        status: { type: 'requires-action', reason: 'composer-send' },
      };
    },
    async remove(attachment) {
      activeAttachmentIds.current.delete(attachment.id);
    },
    async send(attachment) {
      if (!draftSnapshotRef.current) {
        const state = runtimeRef.current?.thread.composer.getState();
        if (state) {
          draftSnapshotRef.current = {
            text: state.text,
            files: state.attachments.flatMap((item) => item.file ? [item.file] : []),
          };
        }
      }
      activeSends.current += 1;
      onUploadingChange(true);
      onError(null);
      try {
        const conversationId = sendConversationIdRef.current ?? await ensureConversation();
        sendConversationIdRef.current = conversationId;
        const content: AttachmentContentPart[] = [];
        if (isHermes) {
          const body = new FormData();
          body.set('conversationId', conversationId);
          body.set('file', attachment.file);
          const response = await fetch(`/api/v1/agents/${agentId}/attachments`, {
            method: 'POST',
            body,
          });
          const result = await response.json().catch(() => ({})) as {
            name?: string;
            runtimePath?: string;
            error?: string;
          };
          if (!response.ok || !result.runtimePath) {
            throw new Error(result.error || t('attachmentUploadFailed'));
          }
          const name = result.name || attachment.name;
          content.push({
            type: 'text',
            text: `Uploaded attachment in the Hermes workspace:\n- ${name}: ${result.runtimePath}`,
          });
          if (
            attachment.file.type.startsWith('image/')
            && attachment.file.size <= MAX_INLINE_IMAGE_BYTES
          ) {
            content.push({
              type: 'file',
              data: await fileToDataUrl(attachment.file),
              mimeType: attachment.contentType || 'application/octet-stream',
              filename: attachment.name,
            });
          }
        } else {
          content.push({
            type: 'file',
            data: await fileToDataUrl(attachment.file),
            mimeType: attachment.contentType || 'application/octet-stream',
            filename: attachment.name,
          });
        }

        return {
          ...attachment,
          status: { type: 'complete' },
          content,
        };
      } catch (error) {
        const message = error instanceof Error
          ? error.message === 'conversation'
            ? t('couldNotCreateConversation')
            : error.message
          : t('attachmentUploadFailed');
        recoveryErrorRef.current = message;
        onError(message);
        return {
          ...attachment,
          status: { type: 'complete' },
          content: [{
            type: 'data',
            name: ATTACHMENT_ERROR_PART.slice(5),
            data: { message },
          }],
        };
      } finally {
        activeAttachmentIds.current.delete(attachment.id);
        activeSends.current = Math.max(0, activeSends.current - 1);
        onUploadingChange(activeSends.current > 0);
        if (activeSends.current === 0 && !recoveryErrorRef.current) {
          draftSnapshotRef.current = null;
        }
      }
    },
  }), [agentId, draftSnapshotRef, ensureConversation, isHermes, onError, onUploadingChange, recoveryErrorRef, runtimeRef, sendConversationIdRef, t]);
}

export function AgentConversation({
  activeConversationId,
  agentId,
  agentName,
  creatingConversation,
  ensureConversation,
  initialMessages,
  ready,
  runtimeKind,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  initialMessages: HermesUIMessage[];
  ready: boolean;
  runtimeKind: string | null;
}) {
  const t = useTranslations('console.agents');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const clearSubmitError = useCallback(() => setSubmitError(null), []);
  const assistantRuntimeRef = useRef<AssistantRuntime | null>(null);
  const sendConversationIdRef = useRef<string | null>(null);
  const attachmentDraftSnapshotRef = useRef<DraftSnapshot | null>(null);
  const attachmentRecoveryErrorRef = useRef<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: `/api/v1/agents/${agentId}/chat`,
  }), [agentId]);
  const chat = useChat<HermesUIMessage>({
    transport,
    messages: initialMessages,
  });

  const displayMessages = useMemo(
    () => expandHermesAssistantMessages(chat.messages),
    [chat.messages],
  );
  const initialMessagesSignature = useMemo(
    () => JSON.stringify(initialMessages),
    [initialMessages],
  );
  const setChatMessages = chat.setMessages;
  const lastInitialMessagesSignatureRef = useRef(initialMessagesSignature);
  useEffect(() => {
    if (lastInitialMessagesSignatureRef.current === initialMessagesSignature) return;
    lastInitialMessagesSignatureRef.current = initialMessagesSignature;
    setChatMessages(initialMessages);
  }, [initialMessages, initialMessagesSignature, setChatMessages]);
  const sendChatMessage = chat.sendMessage;
  const sendMessage = useCallback<typeof chat.sendMessage>(async (message, options) => {
    setSubmitError(null);
    const messageParts = message && typeof message === 'object'
      && 'parts' in message && Array.isArray(message.parts)
      ? message.parts as Array<{ type: string }>
      : [];
    const attachmentFailed = messageParts.some((part) => part.type === ATTACHMENT_ERROR_PART);
    if (attachmentFailed) {
      const snapshot = attachmentDraftSnapshotRef.current;
      const errorMessage = attachmentRecoveryErrorRef.current ?? t('attachmentUploadFailed');
      attachmentDraftSnapshotRef.current = null;
      attachmentRecoveryErrorRef.current = null;
      sendConversationIdRef.current = null;
      if (snapshot && assistantRuntimeRef.current) {
        await restoreDraftSnapshot(assistantRuntimeRef.current, snapshot);
      } else {
        await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
      }
      setSubmitError(errorMessage);
      return;
    }
    let nextConversationId: string;
    try {
      nextConversationId = sendConversationIdRef.current ?? await ensureConversation();
      sendConversationIdRef.current = null;
    } catch {
      sendConversationIdRef.current = null;
      setSubmitError(t('couldNotCreateConversation'));
      await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
      return;
    }
    await sendChatMessage(message, {
      ...options,
      body: {
        ...options?.body,
        conversationId: nextConversationId,
      },
    });
  }, [ensureConversation, sendChatMessage, t]);
  const attachmentAdapter = useAgentAttachmentAdapter({
    agentId,
    ensureConversation,
    isHermes: runtimeKind === 'hermes',
    onError: setSubmitError,
    onUploadingChange: setUploadingAttachments,
    runtimeRef: assistantRuntimeRef,
    sendConversationIdRef,
    draftSnapshotRef: attachmentDraftSnapshotRef,
    recoveryErrorRef: attachmentRecoveryErrorRef,
  });
  const assistantChat = useMemo(() => ({
    ...chat,
    messages: displayMessages,
    sendMessage,
  }), [chat, displayMessages, sendMessage]);
  const runtime = useAISDKRuntime(assistantChat, {
    adapters: { attachments: attachmentAdapter },
    isSendDisabled: !ready || creatingConversation || uploadingAttachments,
    joinStrategy: 'none',
  });
  useEffect(() => {
    assistantRuntimeRef.current = runtime;
    return () => {
      if (assistantRuntimeRef.current === runtime) assistantRuntimeRef.current = null;
    };
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentThread
        activeConversationId={activeConversationId}
        agentName={agentName}
        creatingConversation={creatingConversation}
        error={chat.error}
        onClearAttachmentError={clearSubmitError}
        ready={ready}
        submitError={submitError}
        uploadingAttachments={uploadingAttachments}
      />
    </AssistantRuntimeProvider>
  );
}
