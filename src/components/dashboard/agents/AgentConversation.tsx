'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChat } from '@ai-sdk/react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useComposerRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type FileMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { DefaultChatTransport, generateId, type CreateUIMessage, type UIMessage } from 'ai';
import {
  Box,
  Bot,
  Brain,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  CirclePause,
  Copy,
  Loader2,
  Paperclip,
  Pencil,
  Plug,
  RefreshCw,
  Send,
  Split,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import {
  ConversationAttachmentChip,
  ConversationAttachmentPicker,
  ConversationAttachmentRemoveButton,
  ConversationContextUsage,
  ConversationComposerExpand,
  conversationAttachmentThumbClassName,
  conversationComposerClassName,
  conversationComposerInputClassName,
  conversationComposerToolbarClassName,
  useConversationComposerExpansion,
} from '@/components/dashboard/ConversationComposer';
import {
  AssistantMarkdown,
  AssistantReply,
  ConversationPendingIndicator,
  assistantMessageActionClassName,
} from '@/components/dashboard/ConversationMessage';
import { resolveContextUsage, type ContextUsageSnapshot } from '@/lib/context-usage';
import type { ChatBranchNavigation } from '@/lib/chat/branches';
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';

const MAX_ATTACHMENTS = 5;
const ATTACHMENT_ERROR_PART = 'data-toolplane-attachment-error';

type AttachmentContentPart = CompleteAttachment['content'][number];
type DraftSnapshot = {
  text: string;
  files: File[];
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function displayUserText(text: string) {
  return text.replace(/^\[Messaging source:[^\]]+\]\n\n/, '').trim() || text;
}

function toEditableCreateMessage<UI_MESSAGE extends UIMessage = UIMessage>(
  message: AppendMessage,
): CreateUIMessage<UI_MESSAGE> {
  const inputParts = [
    ...message.content.filter((part) => part.type !== 'file'),
    ...(message.attachments?.flatMap((attachment) => attachment.content.map((part) => ({
      ...part,
      filename: attachment.name,
    }))) ?? []),
  ];
  const parts = inputParts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') {
      return { type: 'file', url: part.image, mediaType: 'image/png', ...(part.filename ? { filename: part.filename } : {}) };
    }
    if (part.type === 'file') {
      return { type: 'file', url: part.data, mediaType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) };
    }
    if (part.type === 'data') return { type: `data-${part.name}`, data: part.data };
    throw new Error(`Unsupported message part: ${part.type}`);
  });
  return {
    role: message.role,
    parts,
    metadata: message.sourceId
      ? {
          ...(message.metadata && typeof message.metadata === 'object' ? message.metadata : {}),
          toolplaneEditMessageId: message.sourceId,
        }
      : message.metadata,
  } as unknown as CreateUIMessage<UI_MESSAGE>;
}

function formatToolResult(result: unknown) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

type ToolKind = 'skill' | 'sandbox' | 'mcp' | 'subagent' | 'tool';

function toolKind(toolName: string): ToolKind {
  if (toolName === 'skill_read_file' || toolName === 'skill_run_script') return 'skill';
  if (/sandbox|terminal|shell|process|filesystem/i.test(toolName)) return 'sandbox';
  if (/sub.?agent|delegate/i.test(toolName)) return 'subagent';
  if (toolName.includes('__')) return 'mcp';
  return 'tool';
}

function toolKindLabel(kind: ToolKind, t: ReturnType<typeof useTranslations>) {
  const labels: Record<ToolKind, string> = {
    skill: t('toolKindSkill'),
    sandbox: t('toolKindSandbox'),
    mcp: t('toolKindMcp'),
    subagent: t('toolKindSubagent'),
    tool: t('toolKindTool'),
  };
  return labels[kind];
}

function formatToolArgs(args: unknown, argsText: string) {
  if (argsText.trim()) return argsText;
  return formatToolResult(args);
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

function AssistantText({ text, status }: TextMessagePartProps) {
  return <AssistantMarkdown text={text} streaming={status.type === 'running'} />;
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

function ToolPart({
  toolName,
  status,
  result,
  isError,
  args,
  argsText,
  approval,
  respondToApproval,
}: ToolCallMessagePartProps) {
  const t = useTranslations('console.agents');
  const kind = toolKind(toolName);
  const Icon = kind === 'skill'
    ? Brain
    : kind === 'sandbox'
      ? Box
      : kind === 'mcp'
        ? Plug
        : kind === 'subagent'
          ? Bot
          : Wrench;
  const waitingForApproval = approval
    && approval.approved === undefined
    && !approval.resolution;
  const isRunning = status.type === 'running';
  const stateLabel = waitingForApproval
    ? t('toolAwaitingApproval')
    : isRunning
      ? t('toolRunning')
      : isError
        ? t('toolFailed')
        : t('toolCompleted');
  const StateIcon = waitingForApproval || isError
    ? CircleAlert
    : isRunning
      ? Loader2
      : CheckCircle2;

  return (
    <details
      open={isRunning || Boolean(isError) || Boolean(waitingForApproval)}
      className={cx(
        'group my-1 overflow-hidden rounded-lg text-xs',
        (isError || waitingForApproval) && 'bg-amber-500/5',
      )}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-0.5 marker:content-none hover:bg-muted/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{toolName}</span>
          <span className="ml-1.5 text-[11px]">{toolKindLabel(kind, t)}</span>
        </span>
        <span className={cx(
          'inline-flex shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium',
          isError ? 'text-red-700 dark:text-red-300'
            : waitingForApproval ? 'text-amber-700 dark:text-amber-300'
              : isRunning ? 'text-brand'
                : 'text-muted-foreground',
        )}>
          <StateIcon className={cx('size-3', isRunning && 'animate-spin')} />
          {stateLabel}
        </span>
      </summary>
      <div className="ml-5 space-y-3 border-l border-border/70 px-3 py-2">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('toolInput')}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground">
            {formatToolArgs(args, argsText)}
          </pre>
        </div>
        {waitingForApproval ? (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-2.5">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">{t('toolApprovalDescription')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => respondToApproval({ approved: true })}
                className="ui-button-primary h-8 px-3 text-xs"
              >
                {t('toolAllow')}
              </button>
              <button
                type="button"
                onClick={() => respondToApproval({ approved: false })}
                className="ui-button-secondary h-8 px-3 text-xs"
              >
                {t('toolReject')}
              </button>
            </div>
          </div>
        ) : null}
        {result !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('toolOutput')}</p>
            <pre className={cx(
              'max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-[11px] leading-relaxed',
              isError ? 'border-red-500/20 bg-red-500/5 text-red-800 dark:text-red-200' : 'border-border bg-muted/30 text-foreground',
            )}>
              {formatToolResult(result)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
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
    <AttachmentPrimitive.Root asChild>
      <ConversationAttachmentChip
        name={<AttachmentPrimitive.Name />}
        progress={attachment.status.type === 'running' ? attachment.status.progress : undefined}
        thumbnail={<AttachmentPrimitive.unstable_Thumb className={conversationAttachmentThumbClassName} />}
        removeButton={(
          <AttachmentPrimitive.Remove asChild>
            <ConversationAttachmentRemoveButton label={t('removeAttachment', { name: attachment.name })} />
          </AttachmentPrimitive.Remove>
        )}
      />
    </AttachmentPrimitive.Root>
  );
}

function AttachmentPickerButton({
  disabled,
  onClearError,
  supportsAttachments,
}: {
  disabled: boolean;
  onClearError: () => void;
  supportsAttachments: boolean;
}) {
  const composer = useComposerRuntime();
  return (
    <ConversationAttachmentPicker
      accept={composer.getState().attachmentAccept}
      disabled={disabled}
      supportsAttachments={supportsAttachments}
      onFiles={(files) => {
        onClearError();
        for (const file of files) {
          void composer.addAttachment(file).catch(() => undefined);
        }
      }}
    />
  );
}

function ConversationBranchNavigator({
  branch,
  disabled,
  onSelect,
}: {
  branch?: ChatBranchNavigation;
  disabled: boolean;
  onSelect?: (messageId: string) => void | Promise<void>;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  if (!branch || !onSelect) return null;
  return (
    <div aria-label={t('conversationBranch')} className="inline-flex h-[26px] items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onSelect(branch.previousMessageId)}
        aria-label={common('previous')}
        title={common('previous')}
        className="flex size-[22px] items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronLeft className="size-3" />
      </button>
      <span className="min-w-8 text-center font-mono">{branch.position}/{branch.total}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onSelect(branch.nextMessageId)}
        aria-label={common('next')}
        title={common('next')}
        className="flex size-[22px] items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronRight className="size-3" />
      </button>
    </div>
  );
}

function UserMessage({
  allowEdit,
  branch,
  branchBusy,
  messageId,
  onBranchChange,
}: {
  allowEdit: boolean;
  branch?: ChatBranchNavigation;
  branchBusy: boolean;
  messageId: string;
  onBranchChange?: (messageId: string) => void | Promise<void>;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  return (
    <MessagePrimitive.Root asChild>
      <article id={`chat-message-${messageId}`} className="flex flex-col items-end rounded-[10px] pt-2.5">
        <ComposerPrimitive.If editing={false}>
          <div className="flex max-w-full items-start justify-end gap-2.5">
            <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] break-words rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-[1.65] text-foreground">
              <MessagePrimitive.Parts components={{ Text: UserText }} />
              <MessagePrimitive.Attachments>
                {({ attachment }) => <SentAttachment attachment={attachment} />}
              </MessagePrimitive.Attachments>
            </div>
            <div aria-label={t('user')} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <UserRound className="size-4" />
            </div>
          </div>
          <div className="mr-10 flex min-h-[26px] items-center justify-end gap-1">
            <ConversationBranchNavigator branch={branch} disabled={branchBusy} onSelect={onBranchChange} />
            <ActionBarPrimitive.Root autohide="always" className="flex h-[26px] items-center justify-end gap-0.5">
              {allowEdit ? (
                <ActionBarPrimitive.Edit
                  aria-label={common('edit')}
                  title={common('edit')}
                  className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  <Pencil className="size-[14px]" />
                </ActionBarPrimitive.Edit>
              ) : null}
              <ActionBarPrimitive.Copy
                aria-label={common('copy')}
                title={common('copy')}
                className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <Copy className="size-[15px]" />
              </ActionBarPrimitive.Copy>
            </ActionBarPrimitive.Root>
          </div>
        </ComposerPrimitive.If>
        <ComposerPrimitive.If editing>
          <ComposerPrimitive.Root className="mr-10 w-[min(36rem,calc(100%_-_2.5rem))] rounded-[10px] bg-muted p-2">
            <ComposerPrimitive.Input
              autoFocus
              rows={2}
              submitMode="enter"
              className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none"
            />
            <div className="mt-1 flex justify-end gap-1">
              <ComposerPrimitive.Cancel
                aria-label={common('cancel')}
                title={common('cancel')}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X className="size-4" />
              </ComposerPrimitive.Cancel>
              <ComposerPrimitive.Send
                aria-label={common('save')}
                title={common('save')}
                className="flex size-7 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-40"
              >
                <Check className="size-4" />
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.If>
      </article>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  agentName,
  allowRegenerate,
  branch,
  branchBusy,
  messageId,
  onBranchChange,
  onRegenerate,
  onStartBranch,
}: {
  agentName: string;
  allowRegenerate: boolean;
  branch?: ChatBranchNavigation;
  branchBusy: boolean;
  messageId: string;
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onRegenerate?: (messageId: string) => void | Promise<void>;
  onStartBranch?: (messageId: string) => void | Promise<void>;
}) {
  const common = useTranslations('common');
  const chat = useTranslations('console.chatAssistants');
  return (
    <MessagePrimitive.Root asChild>
      <AssistantReply
        id={`chat-message-${messageId}`}
        agentName={agentName}
        actions={(
          <div className="flex h-[26px] items-center gap-1">
            <ConversationBranchNavigator branch={branch} disabled={branchBusy} onSelect={onBranchChange} />
            <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex h-[26px] items-center gap-0.5">
              {onStartBranch ? (
                <button
                  type="button"
                  disabled={branchBusy}
                  aria-label={chat('newBranch')}
                  title={chat('newBranch')}
                  className={assistantMessageActionClassName}
                  onClick={() => void onStartBranch(messageId)}
                >
                  <Split className="size-[15px]" />
                </button>
              ) : null}
              <ActionBarPrimitive.Copy
                aria-label={common('copy')}
                title={common('copy')}
                className={assistantMessageActionClassName}
              >
                <Copy className="size-[15px]" />
              </ActionBarPrimitive.Copy>
              {allowRegenerate && onRegenerate ? (
                <button
                  type="button"
                  disabled={branchBusy}
                  aria-label={common('regenerate')}
                  title={common('regenerate')}
                  className={assistantMessageActionClassName}
                  onClick={() => void onRegenerate?.(messageId)}
                >
                  <RefreshCw className="size-[15px]" />
                </button>
              ) : allowRegenerate ? (
                <ActionBarPrimitive.Reload
                  aria-label={common('regenerate')}
                  title={common('regenerate')}
                  className={assistantMessageActionClassName}
                >
                  <RefreshCw className="size-[15px]" />
                </ActionBarPrimitive.Reload>
              ) : null}
            </ActionBarPrimitive.Root>
          </div>
        )}
      >
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            File: FilePart,
            tools: { Fallback: ToolPart },
          }}
        />
      </AssistantReply>
    </MessagePrimitive.Root>
  );
}

function AgentThread({
  activeConversationId,
  agentName,
  allowEdit,
  allowRegenerate,
  branchBusy,
  branchNavigation,
  creatingConversation,
  contextUsage,
  contextUsageBusy,
  error,
  onClearAttachmentError,
  onBranchChange,
  onRegenerateMessage,
  onStartBranch,
  ready,
  supportsAttachments,
  submitError,
  uploadingAttachments,
  workMode,
}: {
  activeConversationId: string | null;
  agentName: string;
  allowEdit: boolean;
  allowRegenerate: boolean;
  branchBusy: boolean;
  branchNavigation: ChatBranchNavigation[];
  creatingConversation: boolean;
  contextUsage: ContextUsageSnapshot | null;
  contextUsageBusy: boolean;
  error?: Error;
  onClearAttachmentError: () => void;
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onRegenerateMessage?: (messageId: string) => void | Promise<void>;
  onStartBranch?: (messageId: string) => void | Promise<void>;
  ready: boolean;
  supportsAttachments: boolean;
  submitError: string | null;
  uploadingAttachments: boolean;
  workMode: boolean;
}) {
  const t = useTranslations('console.agents');
  const {
    expanded: composerExpanded,
    inputRef: composerInputRef,
    minRows: composerMinRows,
    toggle: toggleComposer,
  } = useConversationComposerExpansion();
  const branchByMessageId = useMemo(
    () => new Map(branchNavigation.map((branch) => [branch.messageId, branch])),
    [branchNavigation],
  );
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="flex-1 py-1.5">
          <ThreadPrimitive.Empty>
            <div className="flex min-h-full items-center justify-center px-6 pb-24">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Bot className="size-6" />
                </div>
                <h3 className="text-lg font-medium text-foreground">{workMode ? t('startWorkConversation') : t('startAConversation')}</h3>
                {workMode ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('startWorkConversationDescription')}</p> : null}
              </div>
            </div>
          </ThreadPrimitive.Empty>

          <div className="mx-auto flex w-full max-w-[53rem] flex-col gap-0 px-6">
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === 'user'
                ? <UserMessage allowEdit={allowEdit} branch={branchByMessageId.get(message.id)} branchBusy={branchBusy} messageId={message.id} onBranchChange={onBranchChange} />
                : <AssistantMessage agentName={agentName} allowRegenerate={allowRegenerate} branch={branchByMessageId.get(message.id)} branchBusy={branchBusy} messageId={message.id} onBranchChange={onBranchChange} onRegenerate={onRegenerateMessage} onStartBranch={onStartBranch} />}
            </ThreadPrimitive.Messages>
            <ThreadPrimitive.If running>
              <ConversationPendingIndicator label={t('agentIsResponding')} />
            </ThreadPrimitive.If>
          </div>
        </div>

        <ThreadPrimitive.ScrollToBottom
          aria-label={t('scrollToLatestMessage')}
          title={t('scrollToLatestMessage')}
          className="sticky bottom-3 z-10 mx-auto mb-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground disabled:invisible"
        >
          <ChevronDown className="size-4" />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 bg-background pb-3 pt-4">
        <div className="mx-auto w-full max-w-[53rem] px-6">
          {error || submitError ? (
            <p role="alert" className="mb-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {submitError || error?.message}
            </p>
          ) : null}

          <ComposerPrimitive.Root
            data-ui="chat.composer"
            data-composer-inputbar=""
            data-composer-presentation="regular"
            className={conversationComposerClassName}
          >
            <ConversationComposerExpand expanded={composerExpanded} onToggle={toggleComposer} />
            <div className="flex flex-wrap gap-1.5 px-[15px] empty:hidden">
              <ComposerPrimitive.Attachments>
                {({ attachment }) => <ComposerAttachment attachment={attachment} />}
              </ComposerPrimitive.Attachments>
            </div>
            <ComposerPrimitive.Input
              ref={composerInputRef}
              placeholder={t('messageThisAgent')}
              disabled={!ready || branchBusy || creatingConversation || uploadingAttachments}
              rows={2}
              minRows={composerMinRows}
              submitMode="enter"
              className={conversationComposerInputClassName(composerExpanded)}
            />
            <div data-ui="part:composer-actions" data-composer-toolbar="" className={conversationComposerToolbarClassName}>
              <div className="flex min-w-0 items-center gap-1.5">
                <AttachmentPickerButton
                  disabled={branchBusy || creatingConversation || uploadingAttachments}
                  onClearError={onClearAttachmentError}
                  supportsAttachments={supportsAttachments}
                />
                {!ready || uploadingAttachments || !activeConversationId ? (
                  <div className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {!ready
                      ? t('chooseAModelBeforeSending')
                      : uploadingAttachments
                        ? t('uploadingAttachments')
                        : t('conversationWillBeCreated')}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <ConversationContextUsage busy={contextUsageBusy} usage={contextUsage} />
                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send
                    aria-label={creatingConversation ? t('creating') : t('send')}
                    title={creatingConversation ? t('creating') : t('send')}
                    className="mr-0.5 mt-px flex size-[30px] shrink-0 items-center justify-center text-brand transition-all duration-200 disabled:cursor-not-allowed disabled:text-muted-foreground/50"
                  >
                    {creatingConversation ? <Loader2 className="size-[18px] animate-spin" /> : <Send className="size-[22px]" />}
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel
                    aria-label={t('stop')}
                    title={t('stop')}
                    className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-destructive hover:bg-muted"
                  >
                    <CirclePause className="size-5" />
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </div>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}

function useAgentAttachmentAdapter({
  agentId,
  attachmentUploadUrl,
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
  attachmentUploadUrl?: string;
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
      if (!isHermes && !attachmentUploadUrl) {
        const message = t('attachmentRuntimeRequired');
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
        let uploadUrl: string;
        if (isHermes) {
          const conversationId = sendConversationIdRef.current ?? await ensureConversation();
          sendConversationIdRef.current = conversationId;
          const query = new URLSearchParams({
            conversationId,
            filename: attachment.file.name,
          });
          uploadUrl = `/api/v1/agents/${agentId}/attachments?${query}`;
        } else {
          if (!attachmentUploadUrl) throw new Error(t('attachmentRuntimeRequired'));
          const url = new URL(attachmentUploadUrl, window.location.origin);
          url.searchParams.set('filename', attachment.file.name);
          uploadUrl = `${url.pathname}${url.search}`;
        }
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'content-type': attachment.contentType || 'application/octet-stream',
          },
          body: attachment.file,
        });
        const result = await response.json().catch(() => ({})) as {
          name?: string;
          mimeType?: string;
          runtimePath?: string;
          size?: number;
          url?: string;
          error?: string;
        };
        if (!response.ok || (isHermes ? !result.runtimePath : !result.url)) {
          throw new Error(result.error || t('attachmentUploadFailed'));
        }
        const name = result.name || attachment.name;
        const content: AttachmentContentPart[] = isHermes
          ? [{
              type: 'text',
              text: [
                t('attachmentStoredInHermesWorkspace'),
                t('attachmentMetadataName', { name }),
                t('attachmentMetadataPath', { path: result.runtimePath! }),
                t('attachmentMetadataSize', { size: result.size ?? attachment.file.size }),
                t('attachmentMetadataType', { type: attachment.contentType || 'application/octet-stream' }),
              ].join('\n'),
            }]
          : [{
              type: 'file',
              data: result.url!,
              mimeType: result.mimeType || attachment.contentType || 'application/octet-stream',
              filename: name,
            }];

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
  }), [agentId, attachmentUploadUrl, draftSnapshotRef, ensureConversation, isHermes, onError, onUploadingChange, recoveryErrorRef, runtimeRef, sendConversationIdRef, t]);
}

export function AgentConversation({
  activeConversationId,
  agentId,
  agentName,
  allowEdit = false,
  allowRegenerate = true,
  apiPath,
  attachmentUploadUrl,
  branchBusy = false,
  branchNavigation = [],
  contextBaseText,
  contextWindow,
  contextWindowEstimated = true,
  creatingConversation,
  ensureConversation,
  includeConversationIdInBody = true,
  initialMessages,
  modelName,
  onBranchChange,
  onConversationChanged,
  onStartBranch,
  ready,
  runtimeKind,
  supportsAttachments,
  workSessionId,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  apiPath?: string;
  attachmentUploadUrl?: string;
  branchBusy?: boolean;
  branchNavigation?: ChatBranchNavigation[];
  contextBaseText?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  includeConversationIdInBody?: boolean;
  initialMessages: HermesUIMessage[];
  modelName?: string | null;
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onConversationChanged?: () => void | Promise<void>;
  onStartBranch?: (messageId: string) => void | Promise<void>;
  ready: boolean;
  runtimeKind: string | null;
  supportsAttachments?: boolean;
  workSessionId?: string;
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
    api: apiPath ?? `/api/v1/agents/${agentId}/chat`,
    ...(!includeConversationIdInBody ? {
      prepareSendMessagesRequest: ({ body, messageId, messages, trigger }) => {
        const editMessageId = (messages.at(-1)?.metadata as { toolplaneEditMessageId?: unknown } | undefined)
          ?.toolplaneEditMessageId;
        return {
          body: {
            ...body,
            messageId: messageId ?? (typeof editMessageId === 'string' ? editMessageId : undefined),
            messages: messages.slice(-1),
            trigger,
          },
        };
      },
    } : {}),
  }), [agentId, apiPath, includeConversationIdInBody]);
  const chat = useChat<HermesUIMessage>({
    transport,
    messages: initialMessages,
    onFinish: () => { void onConversationChanged?.(); },
  });
  const contextUsage = useMemo(() => resolveContextUsage(chat.messages, {
    maxTokens: contextWindow,
    modelName,
    context: contextBaseText,
    estimated: contextWindowEstimated,
  }), [chat.messages, contextBaseText, contextWindow, contextWindowEstimated, modelName]);

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
  const regenerateChat = chat.regenerate;
  const sendMessage = useCallback<typeof chat.sendMessage>(async (message, options) => {
    if (branchBusy) return;
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
        ...(includeConversationIdInBody ? { conversationId: nextConversationId } : {}),
        ...(workSessionId ? { workSessionId } : {}),
      },
    });
  }, [branchBusy, ensureConversation, includeConversationIdInBody, sendChatMessage, t, workSessionId]);
  const regenerate = useCallback<typeof chat.regenerate>(async (options) => {
    if (!allowRegenerate || branchBusy) return;
    setSubmitError(null);
    let nextConversationId: string;
    try {
      nextConversationId = activeConversationId ?? await ensureConversation();
    } catch {
      setSubmitError(t('couldNotCreateConversation'));
      return;
    }
    await regenerateChat({
      ...options,
      body: {
        ...options?.body,
        ...(includeConversationIdInBody ? { conversationId: nextConversationId } : {}),
        ...(workSessionId ? { workSessionId } : {}),
      },
    });
  }, [activeConversationId, allowRegenerate, branchBusy, ensureConversation, includeConversationIdInBody, regenerateChat, t, workSessionId]);
  const attachmentAdapter = useAgentAttachmentAdapter({
    agentId,
    attachmentUploadUrl,
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
    regenerate,
  }), [chat, displayMessages, regenerate, sendMessage]);
  const runtime = useAISDKRuntime(assistantChat, {
    adapters: { attachments: attachmentAdapter },
    isSendDisabled: !ready || branchBusy || creatingConversation || uploadingAttachments,
    joinStrategy: 'none',
    ...(allowEdit ? { toCreateMessage: toEditableCreateMessage } : {}),
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
        allowEdit={allowEdit}
        allowRegenerate={allowRegenerate}
        branchBusy={branchBusy}
        branchNavigation={branchNavigation}
        creatingConversation={creatingConversation}
        contextUsage={contextUsage}
        contextUsageBusy={chat.status === 'submitted' || chat.status === 'streaming'}
        error={chat.error}
        onClearAttachmentError={clearSubmitError}
        onBranchChange={onBranchChange}
        onRegenerateMessage={!includeConversationIdInBody
          ? (messageId) => void regenerate({ messageId })
          : undefined}
        onStartBranch={onStartBranch}
        ready={ready}
        supportsAttachments={supportsAttachments ?? (runtimeKind === 'hermes' || Boolean(attachmentUploadUrl))}
        submitError={submitError}
        uploadingAttachments={uploadingAttachments}
        workMode={Boolean(workSessionId)}
      />
    </AssistantRuntimeProvider>
  );
}
