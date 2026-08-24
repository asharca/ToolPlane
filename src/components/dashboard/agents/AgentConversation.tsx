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
import { Popover } from 'radix-ui';
import {
  Box,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  CirclePause,
  Clock3,
  Copy,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Plug,
  Plus,
  RefreshCw,
  Send,
  UserRound,
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
    <AttachmentPrimitive.Root className="mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] items-center gap-1 overflow-hidden rounded-md border border-border bg-muted/50 px-1.5 text-xs font-medium text-foreground">
      <AttachmentPrimitive.unstable_Thumb className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-background text-[9px] font-semibold uppercase text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      {attachment.status.type === 'running' ? (
        <span className="text-muted-foreground">{Math.round(attachment.status.progress * 100)}%</span>
      ) : null}
      <AttachmentPrimitive.Remove
        aria-label={t('removeAttachment', { name: attachment.name })}
        title={t('removeAttachment', { name: attachment.name })}
        className="flex size-4 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </AttachmentPrimitive.Remove>
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
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('openComposerTools')}
          title={t('openComposerTools')}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-[18px]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('composerTools')}
          className="z-50 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          <Popover.Close asChild>
            <button
              type="button"
              disabled={!supportsAttachments}
              onClick={openPicker}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Paperclip className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block">{t('addAttachment')}</span>
                {!supportsAttachments ? (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('attachmentRuntimeRequired')}</span>
                ) : null}
              </span>
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UserMessage() {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  return (
    <MessagePrimitive.Root asChild>
      <article className="flex flex-col items-end rounded-[10px] pt-2.5">
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
        <div className="mr-10 min-h-[26px]">
          <ActionBarPrimitive.Root autohide="always" className="flex h-[26px] items-center justify-end gap-0.5">
            <ActionBarPrimitive.Copy
              aria-label={common('copy')}
              title={common('copy')}
              className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Copy className="size-[15px]" />
            </ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        </div>
      </article>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ agentName }: { agentName: string }) {
  const common = useTranslations('common');
  return (
    <MessagePrimitive.Root asChild>
      <article className="flex items-start justify-start gap-2.5 rounded-[10px] pt-2.5">
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bot className="size-[15px]" />
        </div>
        <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] flex-1">
          <div className="text-sm font-semibold leading-5 text-foreground">
            {agentName}
          </div>
          <div className="mt-2 min-w-0 break-words text-sm leading-[1.65] text-foreground">
            <MessagePrimitive.Parts
              components={{
                Text: AssistantText,
                File: FilePart,
                tools: { Fallback: ToolPart },
              }}
            />
          </div>
          <div className="mt-1 min-h-[26px]">
            <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex h-[26px] items-center gap-0.5">
              <ActionBarPrimitive.Copy
                aria-label={common('copy')}
                title={common('copy')}
                className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <Copy className="size-[15px]" />
              </ActionBarPrimitive.Copy>
              <ActionBarPrimitive.Reload
                aria-label={common('regenerate')}
                title={common('regenerate')}
                className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <RefreshCw className="size-[15px]" />
              </ActionBarPrimitive.Reload>
            </ActionBarPrimitive.Root>
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
  supportsAttachments,
  submitError,
  uploadingAttachments,
  workMode,
}: {
  activeConversationId: string | null;
  agentName: string;
  creatingConversation: boolean;
  error?: Error;
  onClearAttachmentError: () => void;
  ready: boolean;
  supportsAttachments: boolean;
  submitError: string | null;
  uploadingAttachments: boolean;
  workMode: boolean;
}) {
  const t = useTranslations('console.agents');
  const [composerMinRows, setComposerMinRows] = useState(2);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composerExpanded = composerMinRows > 2;
  const ComposerExpandIcon = composerExpanded ? Minimize2 : Maximize2;
  const composerExpandLabel = t(composerExpanded ? 'restoreComposer' : 'expandComposer');
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
                ? <UserMessage />
                : <AssistantMessage agentName={agentName} />}
            </ThreadPrimitive.Messages>
            <ThreadPrimitive.If running>
              <div className="flex items-center gap-2.5 py-2.5 pl-10 text-sm text-muted-foreground">
                <Clock3 className="size-4 shrink-0 animate-pulse" />
                {t('agentIsResponding')}
              </div>
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
            className="relative rounded-[20px] border-[0.5px] border-border bg-card pt-2 shadow-sm transition-all duration-200 ease-in-out"
          >
            <div className="group/expand-corner absolute right-px top-px z-10 size-8">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-1 top-1 size-3 origin-top-right scale-100 rounded-tr-[16px] border-r-[1.5px] border-t-[1.5px] border-foreground/60 opacity-70 transition-[opacity,scale] duration-200 ease-out group-focus-within/expand-corner:scale-50 group-focus-within/expand-corner:opacity-0 group-hover/expand-corner:scale-50 group-hover/expand-corner:opacity-0"
              />
              <button
                type="button"
                onClick={() => {
                  setComposerMinRows(composerExpanded
                    ? 2
                    : Math.ceil((Math.max(220, window.innerHeight * 0.5) - 6) / (14 * 1.4)));
                  composerInputRef.current?.focus();
                }}
                aria-label={composerExpandLabel}
                title={composerExpandLabel}
                aria-pressed={composerExpanded}
                className="pointer-events-none absolute right-1 top-1 flex size-[22px] -translate-y-2.5 translate-x-2.5 rotate-[-8deg] scale-80 items-center justify-center rounded-full bg-transparent text-muted-foreground opacity-0 transition-[opacity,translate,scale,rotate,color,background-color] duration-300 ease-out hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:rotate-0 focus-visible:scale-100 focus-visible:bg-muted focus-visible:text-foreground focus-visible:opacity-100 group-focus-within/expand-corner:pointer-events-auto group-focus-within/expand-corner:translate-x-0 group-focus-within/expand-corner:translate-y-0 group-focus-within/expand-corner:rotate-0 group-focus-within/expand-corner:scale-100 group-focus-within/expand-corner:bg-muted/80 group-focus-within/expand-corner:text-foreground group-focus-within/expand-corner:opacity-100 group-hover/expand-corner:pointer-events-auto group-hover/expand-corner:translate-x-0 group-hover/expand-corner:translate-y-0 group-hover/expand-corner:rotate-0 group-hover/expand-corner:scale-100 group-hover/expand-corner:bg-muted/80 group-hover/expand-corner:text-foreground group-hover/expand-corner:opacity-100"
              >
                <ComposerExpandIcon className="size-3 transition-transform duration-300 ease-out group-focus-within/expand-corner:scale-110 group-hover/expand-corner:scale-110" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 px-[15px] empty:hidden">
              <ComposerPrimitive.Attachments>
                {({ attachment }) => <ComposerAttachment attachment={attachment} />}
              </ComposerPrimitive.Attachments>
            </div>
            <ComposerPrimitive.Input
              ref={composerInputRef}
              placeholder={t('messageThisAgent')}
              disabled={!ready || creatingConversation || uploadingAttachments}
              rows={2}
              minRows={composerMinRows}
              submitMode="enter"
              className={cx(
                'block min-h-[46px] w-full resize-none overflow-y-auto bg-transparent pb-0 pl-[15px] pr-11 pt-1.5 text-sm leading-[1.4] text-foreground outline-none transition-none placeholder:text-muted-foreground disabled:opacity-60 [&::-webkit-scrollbar]:w-[3px]',
                composerExpanded ? 'max-h-[max(220px,50vh)]' : 'max-h-[max(220px,40vh)]',
              )}
            />
            <div data-ui="part:composer-actions" data-composer-toolbar="" className="relative z-[2] flex h-10 items-center justify-between gap-4 px-2 py-[5px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <AttachmentPickerButton
                  disabled={creatingConversation || uploadingAttachments}
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
          </ComposerPrimitive.Root>
        </div>
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
      if (!isHermes) {
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
        const conversationId = sendConversationIdRef.current ?? await ensureConversation();
        sendConversationIdRef.current = conversationId;
        if (!isHermes) throw new Error(t('attachmentRuntimeRequired'));
        const query = new URLSearchParams({
          conversationId,
          filename: attachment.file.name,
        });
        const response = await fetch(`/api/v1/agents/${agentId}/attachments?${query}`, {
          method: 'POST',
          headers: {
            'content-type': attachment.contentType || 'application/octet-stream',
          },
          body: attachment.file,
        });
        const result = await response.json().catch(() => ({})) as {
          name?: string;
          runtimePath?: string;
          size?: number;
          error?: string;
        };
        if (!response.ok || !result.runtimePath) {
          throw new Error(result.error || t('attachmentUploadFailed'));
        }
        const name = result.name || attachment.name;
        const content: AttachmentContentPart[] = [{
          type: 'text',
          text: [
            t('attachmentStoredInHermesWorkspace'),
            t('attachmentMetadataName', { name }),
            t('attachmentMetadataPath', { path: result.runtimePath }),
            t('attachmentMetadataSize', { size: result.size ?? attachment.file.size }),
            t('attachmentMetadataType', { type: attachment.contentType || 'application/octet-stream' }),
          ].join('\n'),
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
  workSessionId,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  initialMessages: HermesUIMessage[];
  ready: boolean;
  runtimeKind: string | null;
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
  const regenerateChat = chat.regenerate;
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
        ...(workSessionId ? { workSessionId } : {}),
      },
    });
  }, [ensureConversation, sendChatMessage, t, workSessionId]);
  const regenerate = useCallback<typeof chat.regenerate>(async (options) => {
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
        conversationId: nextConversationId,
        ...(workSessionId ? { workSessionId } : {}),
      },
    });
  }, [activeConversationId, ensureConversation, regenerateChat, t, workSessionId]);
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
    regenerate,
  }), [chat, displayMessages, regenerate, sendMessage]);
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
        supportsAttachments={runtimeKind === 'hermes'}
        submitError={submitError}
        uploadingAttachments={uploadingAttachments}
        workMode={Boolean(workSessionId)}
      />
    </AssistantRuntimeProvider>
  );
}
