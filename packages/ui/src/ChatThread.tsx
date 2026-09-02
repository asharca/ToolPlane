'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useComposerRuntime,
  type AssistantRuntime,
  type Attachment,
  type CompleteAttachment,
  type FileMessagePartProps,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';
import { Popover } from 'radix-ui';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins } from 'streamdown';
import {
  Bot,
  Box,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Copy,
  Globe2,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Split,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import { Button, IconButton } from './Controls.tsx';

export type ChatBranchNavigation = {
  messageId: string;
  position: number;
  total: number;
  previousMessageId: string;
  nextMessageId: string;
};

export type ChatThreadLabels = {
  addAttachment: string;
  allowTool: string;
  attachment: string;
  attachmentsUnavailable: string;
  cancel: string;
  composerTools: string;
  conversationBranch: string;
  copy: string;
  edit: string;
  expandComposer: string;
  generatingReply: string;
  messagePlaceholder: string;
  next: string;
  openComposerTools: string;
  preparingReply: string;
  previous: string;
  processFailed: string;
  processed: string;
  processing: string;
  regenerate: string;
  rejectTool: string;
  removeAttachment: (name: string) => string;
  restoreComposer: string;
  save: string;
  scrollToLatestMessage: string;
  send: string;
  startBranch: string;
  startConversation: string;
  stop: string;
  thinking: string;
  thought: string;
  toolApprovalDescription: string;
  toolAwaitingApproval: string;
  toolCompleted: string;
  toolFailed: string;
  toolInput: string;
  toolKindMcp: string;
  toolKindSandbox: string;
  toolKindSkill: string;
  toolKindSubagent: string;
  toolKindTool: string;
  toolKindWeb: string;
  toolOutput: string;
  toolRunning: string;
  user: string;
  usingTool: (toolName: string) => string;
};

export const chatThreadDefaultLabels: ChatThreadLabels = {
  addAttachment: 'Add attachment',
  allowTool: 'Allow',
  attachment: 'Attachment',
  attachmentsUnavailable: 'Attachments are not available.',
  cancel: 'Cancel',
  composerTools: 'Composer tools',
  conversationBranch: 'Conversation branch',
  copy: 'Copy',
  edit: 'Edit',
  expandComposer: 'Expand composer',
  generatingReply: 'Generating reply',
  messagePlaceholder: 'Type a message',
  next: 'Next',
  openComposerTools: 'Open tools',
  preparingReply: 'Preparing',
  previous: 'Previous',
  processFailed: 'Process failed',
  processed: 'Processed',
  processing: 'Processing',
  regenerate: 'Regenerate',
  rejectTool: 'Reject',
  removeAttachment: (name) => `Remove ${name}`,
  restoreComposer: 'Restore composer',
  save: 'Save',
  scrollToLatestMessage: 'Scroll to latest message',
  send: 'Send',
  startBranch: 'Start a new branch',
  startConversation: 'Start a conversation',
  stop: 'Stop',
  thinking: 'Thinking',
  thought: 'Thought',
  toolApprovalDescription: 'This tool needs your approval before it can run.',
  toolAwaitingApproval: 'Awaiting approval',
  toolCompleted: 'Completed',
  toolFailed: 'Failed',
  toolInput: 'Input',
  toolKindMcp: 'MCP',
  toolKindSandbox: 'Sandbox',
  toolKindSkill: 'Skill',
  toolKindSubagent: 'Sub-agent',
  toolKindTool: 'Tool',
  toolKindWeb: 'Web',
  toolOutput: 'Output',
  toolRunning: 'Running',
  user: 'You',
  usingTool: (toolName) => `Using ${toolName}`,
};

export type ChatThreadProps = {
  runtime: AssistantRuntime;
  assistantName: string;
  allowAttachments?: boolean;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  branchNavigation?: readonly ChatBranchNavigation[];
  busy?: boolean;
  className?: string;
  components?: ChatThreadComponents;
  composerEnd?: ReactNode;
  composerStatus?: ReactNode;
  composerTools?: ReactNode;
  disabled?: boolean;
  emptyState?: ReactNode;
  error?: ReactNode;
  labels?: Partial<ChatThreadLabels>;
  onBranchSelect?: (messageId: string) => void | Promise<void>;
  onBranchStart?: (messageId: string) => void | Promise<void>;
  onRegenerateMessage?: (messageId: string) => void | Promise<void>;
  transformUserText?: (text: string) => string;
};

export type ChatThreadComponents = {
  AssistantText?: ComponentType<TextMessagePartProps>;
  AssistantMessageBefore?: ComponentType<{ messageId: string }>;
  AssistantMessageAfter?: ComponentType<{ messageId: string }>;
  AssistantActions?: ComponentType<{ messageId: string }>;
  SentAttachment?: ComponentType<{ attachment: CompleteAttachment }>;
};

const LabelsContext = createContext<ChatThreadLabels>(chatThreadDefaultLabels);
const UserTextTransformContext = createContext<(text: string) => string>((text) => text);

const markdownPlugins = { code };
const markdownRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function useLabels() {
  return useContext(LabelsContext);
}

function formatToolResult(result: unknown) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
    const text = result.content.flatMap((part) => (
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : []
    )).join('\n\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

type ToolKind = 'web' | 'skill' | 'sandbox' | 'mcp' | 'subagent' | 'tool';

function toolKind(toolName: string): ToolKind {
  if (/(?:^|__)(?:brave|web|firecrawl|fetch|search|crawl|scrape|extract|browser)/i.test(toolName)) return 'web';
  if (/skill/i.test(toolName)) return 'skill';
  if (/sandbox|terminal|shell|process|filesystem/i.test(toolName)) return 'sandbox';
  if (/sub.?agent|delegate/i.test(toolName)) return 'subagent';
  if (toolName.includes('__')) return 'mcp';
  return 'tool';
}

function toolKindLabel(kind: ToolKind, labels: ChatThreadLabels) {
  return {
    web: labels.toolKindWeb,
    skill: labels.toolKindSkill,
    sandbox: labels.toolKindSandbox,
    mcp: labels.toolKindMcp,
    subagent: labels.toolKindSubagent,
    tool: labels.toolKindTool,
  }[kind];
}

function UserText({ text }: TextMessagePartProps) {
  const transform = useContext(UserTextTransformContext);
  return <span className="block whitespace-pre-wrap [&:not(:last-child)]:mb-2">{transform(text)}</span>;
}

function AssistantText() {
  return (
    <StreamdownTextPrimitive
      plugins={markdownPlugins}
      remarkPlugins={markdownRemarkPlugins}
      linkSafety={{ enabled: true }}
      security={{
        allowedProtocols: ['http', 'https', 'mailto'],
        allowDataImages: false,
      }}
      className="space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}

function ReasoningPart({ text, status }: ReasoningMessagePartProps) {
  const labels = useLabels();
  const running = status.type === 'running';
  return (
    <details open={running} className="group/reasoning rounded-md">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
        {running
          ? <Loader2 className="size-3.5 shrink-0 animate-spin" />
          : <CheckCircle2 className="size-3.5 shrink-0" />}
        <Brain className="size-3.5 shrink-0" />
        <span>{running ? labels.thinking : labels.thought}</span>
        {text ? <ChevronRight className="ml-auto size-3.5 transition-transform group-open/reasoning:rotate-90" /> : null}
      </summary>
      {text ? (
        <pre className="ml-5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
          {text}
        </pre>
      ) : null}
    </details>
  );
}

function FilePart({ data, filename }: FileMessagePartProps) {
  const labels = useLabels();
  return (
    <a
      href={data}
      download={filename}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-current/20 px-2 py-1 text-xs underline-offset-2 hover:underline"
    >
      <Paperclip className="size-3.5 shrink-0" />
      <span className="truncate">{filename || labels.attachment}</span>
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
  const labels = useLabels();
  const kind = toolKind(toolName);
  const Icon = kind === 'skill'
    ? Brain
    : kind === 'web'
      ? Globe2
      : kind === 'sandbox'
        ? Box
        : kind === 'mcp'
          ? Plug
          : kind === 'subagent'
            ? Bot
            : Wrench;
  const waitingForApproval = approval && approval.approved === undefined && !approval.resolution;
  const running = status.type === 'running';
  const stateLabel = waitingForApproval
    ? labels.toolAwaitingApproval
    : running
      ? labels.toolRunning
      : isError
        ? labels.toolFailed
        : labels.toolCompleted;
  const StateIcon = waitingForApproval || isError ? CircleAlert : running ? Loader2 : CheckCircle2;

  return (
    <details
      open={running || Boolean(isError) || Boolean(waitingForApproval)}
      className={cx('group my-1 overflow-hidden rounded-lg text-xs', (isError || waitingForApproval) && 'bg-amber-500/5')}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-0.5 marker:content-none hover:bg-muted/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{toolName}</span>
          <span className="ml-1.5 text-[11px]">{toolKindLabel(kind, labels)}</span>
        </span>
        <span className={cx(
          'inline-flex shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium',
          isError ? 'text-red-700 dark:text-red-300'
            : waitingForApproval ? 'text-amber-700 dark:text-amber-300'
              : running ? 'text-brand'
                : 'text-muted-foreground',
        )}>
          <StateIcon className={cx('size-3', running && 'animate-spin')} />
          {stateLabel}
        </span>
      </summary>
      <div className="ml-5 space-y-3 border-l border-border/70 px-3 py-2">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{labels.toolInput}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground">
            {argsText.trim() || formatToolResult(args)}
          </pre>
        </div>
        {waitingForApproval ? (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-2.5">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">{labels.toolApprovalDescription}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => respondToApproval({ approved: true })}>
                {labels.allowTool}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => respondToApproval({ approved: false })}>
                {labels.rejectTool}
              </Button>
            </div>
          </div>
        ) : null}
        {result !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{labels.toolOutput}</p>
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

function AssistantProcess() {
  const labels = useLabels();
  const running = useAuiState((state) => state.chainOfThought.status.type === 'running');
  const failed = useAuiState((state) => state.chainOfThought.parts.some((part) => (
    part.type === 'tool-call' && part.isError
  )));
  const activeLabel = useAuiState((state) => {
    const part = state.chainOfThought.parts.at(-1);
    if (!running || !part) return '';
    return part.type === 'tool-call' ? labels.usingTool(part.toolName) : labels.thinking;
  });

  return (
    <ChainOfThoughtPrimitive.Root asChild>
      <details open={running || failed} data-ui="assistant-process" className="group/process my-1.5 text-xs">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/process:rotate-90" />
          {running
            ? <Loader2 className="size-3.5 shrink-0 animate-spin" />
            : failed
              ? <CircleAlert className="size-3.5 shrink-0 text-red-600" />
              : <CheckCircle2 className="size-3.5 shrink-0" />}
          <span className="shrink-0 font-medium text-foreground">
            {running ? labels.processing : failed ? labels.processFailed : labels.processed}
          </span>
          {activeLabel ? <span className="min-w-0 truncate text-[11px]">{activeLabel}</span> : null}
        </summary>
        <div className="ml-5 py-1">
          <ChainOfThoughtPrimitive.Parts components={{ Reasoning: ReasoningPart, tools: { Fallback: ToolPart } }} />
        </div>
      </details>
    </ChainOfThoughtPrimitive.Root>
  );
}

function PendingIndicator({ label }: { label: string }) {
  return (
    <div role="status" data-ui="conversation-pending" className="flex items-center gap-2 py-0.5 text-[13px] text-muted-foreground">
      <span>{label}</span>
      <span aria-hidden="true" className="flex items-center gap-1">
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current [animation-delay:-300ms]" />
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current [animation-delay:-150ms]" />
        <span data-ui="conversation-pending-dot" className="size-1 animate-bounce rounded-full bg-current" />
      </span>
    </div>
  );
}

function AssistantPendingPart() {
  const labels = useLabels();
  const running = useAuiState((state) => state.message.status?.type === 'running');
  const hasParts = useAuiState((state) => state.message.parts.length > 0);
  if (!running) return null;
  return <PendingIndicator label={hasParts ? labels.generatingReply : labels.preparingReply} />;
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
  const labels = useLabels();
  return (
    <AttachmentPrimitive.Root className="mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] items-center gap-1 overflow-hidden rounded-md border border-border bg-muted/50 px-1.5 text-xs font-medium text-foreground">
      <AttachmentPrimitive.unstable_Thumb className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-background text-[9px] font-semibold uppercase text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      {attachment.status.type === 'running' ? (
        <span className="text-muted-foreground">{Math.round(attachment.status.progress * 100)}%</span>
      ) : null}
      <AttachmentPrimitive.Remove
        aria-label={labels.removeAttachment(attachment.name)}
        title={labels.removeAttachment(attachment.name)}
        className="flex size-4 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function AttachmentPicker({ disabled, enabled }: { disabled: boolean; enabled: boolean }) {
  const labels = useLabels();
  const composer = useComposerRuntime();
  const openPicker = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    const accept = composer.getState().attachmentAccept;
    if (accept && accept !== '*') input.accept = accept;
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
  }, [composer]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton
          icon={<Plus className="size-[18px]" />}
          label={labels.openComposerTools}
          size="sm"
          variant="ghost"
          disabled={disabled}
          className="size-[30px] min-h-[30px] shrink-0 rounded-full"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={labels.composerTools}
          className="z-50 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          <Popover.Close asChild>
            <button
              type="button"
              disabled={!enabled}
              onClick={openPicker}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Paperclip className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block">{labels.addAttachment}</span>
                {!enabled ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{labels.attachmentsUnavailable}</span> : null}
              </span>
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BranchNavigator({
  branch,
  disabled,
  onSelect,
}: {
  branch?: ChatBranchNavigation;
  disabled: boolean;
  onSelect?: (messageId: string) => void | Promise<void>;
}) {
  const labels = useLabels();
  if (!branch || !onSelect) return null;
  return (
    <div role="group" aria-label={labels.conversationBranch} className="inline-flex h-8 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
      <IconButton
        icon={<ChevronLeft className="size-3" />}
        label={labels.previous}
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void onSelect(branch.previousMessageId)}
        className="rounded-md"
      />
      <span className="min-w-8 text-center font-mono">{branch.position}/{branch.total}</span>
      <IconButton
        icon={<ChevronRight className="size-3" />}
        label={labels.next}
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void onSelect(branch.nextMessageId)}
        className="rounded-md"
      />
    </div>
  );
}

function UserMessage({
  allowEdit,
  branch,
  busy,
  components,
  messageId,
  onBranchSelect,
}: {
  allowEdit: boolean;
  branch?: ChatBranchNavigation;
  busy: boolean;
  components?: ChatThreadComponents;
  messageId: string;
  onBranchSelect?: (messageId: string) => void | Promise<void>;
}) {
  const labels = useLabels();
  const SentAttachmentComponent = components?.SentAttachment ?? SentAttachment;
  return (
    <MessagePrimitive.Root asChild>
      <article id={`chat-message-${messageId}`} className="flex flex-col items-end rounded-[10px] pt-2.5">
        <ComposerPrimitive.If editing={false}>
          <div className="flex max-w-full items-start justify-end gap-2.5">
            <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] break-words rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-[1.65] text-foreground">
              <MessagePrimitive.Parts components={{ Text: UserText }} />
              <MessagePrimitive.Attachments>{({ attachment }) => <SentAttachmentComponent attachment={attachment} />}</MessagePrimitive.Attachments>
            </div>
            <div aria-label={labels.user} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <UserRound className="size-4" />
            </div>
          </div>
          <div className="mr-10 flex min-h-[26px] items-center justify-end gap-1">
            <BranchNavigator branch={branch} disabled={busy} onSelect={onBranchSelect} />
            <ActionBarPrimitive.Root autohide="always" className="flex h-[26px] items-center justify-end gap-0.5">
              {allowEdit ? (
                <ActionBarPrimitive.Edit aria-label={labels.edit} title={labels.edit} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                  <Pencil className="size-[14px]" />
                </ActionBarPrimitive.Edit>
              ) : null}
              <ActionBarPrimitive.Copy aria-label={labels.copy} title={labels.copy} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                <Copy className="size-[15px]" />
              </ActionBarPrimitive.Copy>
            </ActionBarPrimitive.Root>
          </div>
        </ComposerPrimitive.If>
        <ComposerPrimitive.If editing>
          <ComposerPrimitive.Root className="mr-10 w-[min(36rem,calc(100%_-_2.5rem))] rounded-[10px] bg-muted p-2">
            <ComposerPrimitive.Input autoFocus rows={2} submitMode="enter" className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none" />
            <div className="mt-1 flex justify-end gap-1">
              <ComposerPrimitive.Cancel aria-label={labels.cancel} title={labels.cancel} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
                <X className="size-4" />
              </ComposerPrimitive.Cancel>
              <ComposerPrimitive.Send aria-label={labels.save} title={labels.save} className="flex size-7 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-40">
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
  busy,
  components,
  messageId,
  onBranchSelect,
  onBranchStart,
  onRegenerateMessage,
}: {
  agentName: string;
  allowRegenerate: boolean;
  branch?: ChatBranchNavigation;
  busy: boolean;
  components?: ChatThreadComponents;
  messageId: string;
  onBranchSelect?: (messageId: string) => void | Promise<void>;
  onBranchStart?: (messageId: string) => void | Promise<void>;
  onRegenerateMessage?: (messageId: string) => void | Promise<void>;
}) {
  const labels = useLabels();
  const AssistantTextComponent = components?.AssistantText ?? AssistantText;
  const AssistantMessageBefore = components?.AssistantMessageBefore;
  const AssistantMessageAfter = components?.AssistantMessageAfter;
  const AssistantActions = components?.AssistantActions;
  return (
    <MessagePrimitive.Root asChild>
      <article
        id={`chat-message-${messageId}`}
        data-ui="assistant-reply"
        className="group/message flex items-start justify-start gap-2.5 rounded-[10px] pt-2.5"
      >
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bot className="size-[15px]" />
        </div>
        <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] flex-1">
          <div className="text-sm font-semibold leading-5 text-foreground">{agentName}</div>
          <div className="mt-2 min-w-0 break-words text-sm leading-[1.65] text-foreground">
            {AssistantMessageBefore ? <AssistantMessageBefore messageId={messageId} /> : null}
            <MessagePrimitive.Parts components={{ Text: AssistantTextComponent, File: FilePart, ChainOfThought: AssistantProcess, Empty: AssistantPendingPart }} />
            {AssistantMessageAfter ? <AssistantMessageAfter messageId={messageId} /> : null}
          </div>
          <div className="mt-1 flex min-h-[26px] items-center gap-1">
            <BranchNavigator branch={branch} disabled={busy} onSelect={onBranchSelect} />
            <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex h-[26px] items-center gap-0.5">
              {onBranchStart ? (
                <button type="button" disabled={busy} aria-label={labels.startBranch} title={labels.startBranch} onClick={() => void onBranchStart(messageId)} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                  <Split className="size-[15px]" />
                </button>
              ) : null}
              <ActionBarPrimitive.Copy aria-label={labels.copy} title={labels.copy} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                <Copy className="size-[15px]" />
              </ActionBarPrimitive.Copy>
              {AssistantActions ? <AssistantActions messageId={messageId} /> : null}
              {allowRegenerate && onRegenerateMessage ? (
                <button type="button" disabled={busy} aria-label={labels.regenerate} title={labels.regenerate} onClick={() => void onRegenerateMessage(messageId)} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                  <RefreshCw className="size-[15px]" />
                </button>
              ) : allowRegenerate ? (
                <ActionBarPrimitive.Reload aria-label={labels.regenerate} title={labels.regenerate} className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                  <RefreshCw className="size-[15px]" />
                </ActionBarPrimitive.Reload>
              ) : null}
            </ActionBarPrimitive.Root>
          </div>
        </div>
      </article>
    </MessagePrimitive.Root>
  );
}

function ComposerExpand({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const labels = useLabels();
  const Icon = expanded ? Minimize2 : Maximize2;
  const label = expanded ? labels.restoreComposer : labels.expandComposer;
  return (
    <div className="absolute right-px top-px z-10 size-8">
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        title={label}
        aria-pressed={expanded}
        className="pointer-events-none absolute right-1 top-1 flex size-[22px] -translate-y-2.5 translate-x-2.5 rotate-[-8deg] scale-80 items-center justify-center rounded-full bg-transparent text-muted-foreground opacity-0 transition-all duration-300 hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:rotate-0 focus-visible:scale-100 focus-visible:opacity-100 group-focus-within/composer:pointer-events-auto group-focus-within/composer:translate-x-0 group-focus-within/composer:translate-y-0 group-focus-within/composer:rotate-0 group-focus-within/composer:scale-100 group-focus-within/composer:opacity-100 group-hover/composer:pointer-events-auto group-hover/composer:translate-x-0 group-hover/composer:translate-y-0 group-hover/composer:rotate-0 group-hover/composer:scale-100 group-hover/composer:opacity-100"
      >
        <Icon className="size-3" />
      </button>
    </div>
  );
}

function ChatThreadContent({
  assistantName,
  allowAttachments,
  allowEdit,
  allowRegenerate,
  branchNavigation,
  busy,
  className,
  composerEnd,
  composerStatus,
  composerTools,
  components,
  disabled,
  emptyState,
  error,
  onBranchSelect,
  onBranchStart,
  onRegenerateMessage,
}: Omit<ChatThreadProps, 'runtime' | 'labels'> & {
  allowAttachments: boolean;
  allowEdit: boolean;
  allowRegenerate: boolean;
  branchNavigation: readonly ChatBranchNavigation[];
  busy: boolean;
  disabled: boolean;
}) {
  const labels = useLabels();
  const [composerRows, setComposerRows] = useState(2);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentUploading = useAuiState((state) => (
    state.composer.attachments.some((attachment) => attachment.status.type === 'running')
  ));
  const composerExpanded = composerRows > 2;
  const branchByMessageId = useMemo(
    () => new Map(branchNavigation.map((branch) => [branch.messageId, branch])),
    [branchNavigation],
  );
  const toggleComposer = () => {
    setComposerRows(composerExpanded
      ? 2
      : Math.ceil((Math.max(220, window.innerHeight * 0.5) - 6) / (14 * 1.4)));
    composerInputRef.current?.focus();
  };
  const blocked = disabled || busy;

  return (
    <ThreadPrimitive.Root
      data-chat-ui="chat-thread"
      className={cx('flex min-h-0 flex-1 flex-col', className)}
    >
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="flex-1 py-1.5">
          <ThreadPrimitive.Empty>
            <div className="flex min-h-full items-center justify-center px-6 pb-24">
              {emptyState ?? (
                <div className="max-w-md text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-6" /></div>
                  <h3 className="text-lg font-medium text-foreground">{labels.startConversation}</h3>
                </div>
              )}
            </div>
          </ThreadPrimitive.Empty>
          <div className="mx-auto flex w-full max-w-[53rem] flex-col gap-0 px-6">
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === 'user'
                ? (
                    <UserMessage
                      allowEdit={allowEdit}
                      branch={branchByMessageId.get(message.id)}
                      busy={blocked}
                      components={components}
                      messageId={message.id}
                      onBranchSelect={onBranchSelect}
                    />
                  )
                : (
                    <AssistantMessage
                      agentName={assistantName}
                      allowRegenerate={allowRegenerate}
                      branch={branchByMessageId.get(message.id)}
                      busy={blocked}
                      components={components}
                      messageId={message.id}
                      onBranchSelect={onBranchSelect}
                      onBranchStart={onBranchStart}
                      onRegenerateMessage={onRegenerateMessage}
                    />
                  )}
            </ThreadPrimitive.Messages>
          </div>
        </div>
        <ThreadPrimitive.ScrollToBottom aria-label={labels.scrollToLatestMessage} title={labels.scrollToLatestMessage} className="sticky bottom-3 z-10 mx-auto mb-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground disabled:invisible">
          <ChevronDown className="size-4" />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 bg-background pb-3 pt-4">
        <div className="mx-auto w-full max-w-[53rem] px-6">
          {error ? (
            <div role="alert" className="mb-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>
          ) : null}
          <ComposerPrimitive.Root data-ui="chat.composer" className="group/composer relative rounded-[20px] border-[0.5px] border-border bg-card pt-2 shadow-sm transition-all duration-200 ease-in-out hover:border-foreground/25 focus-within:border-foreground/25">
            <ComposerPrimitive.AttachmentDropzone asChild>
              <div className="contents">
                <ComposerExpand expanded={composerExpanded} onToggle={toggleComposer} />
                <div className="flex flex-wrap gap-1.5 px-[15px] empty:hidden">
                  <ComposerPrimitive.Attachments>{({ attachment }) => <ComposerAttachment attachment={attachment} />}</ComposerPrimitive.Attachments>
                </div>
                <ComposerPrimitive.Input
                  ref={composerInputRef}
                  placeholder={labels.messagePlaceholder}
                  disabled={blocked}
                  rows={2}
                  minRows={composerRows}
                  submitMode="enter"
                  className={cx(
                    'block min-h-[46px] w-full resize-none overflow-y-auto bg-transparent pb-0 pl-[15px] pr-11 pt-1.5 text-sm leading-[1.4] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 [&::-webkit-scrollbar]:w-[3px]',
                    composerExpanded ? 'max-h-[max(220px,50vh)]' : 'max-h-[max(220px,40vh)]',
                  )}
                />
                <div className="relative z-[2] flex min-h-10 items-center justify-between gap-4 px-2 py-[5px]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <AttachmentPicker disabled={blocked} enabled={allowAttachments} />
                    {composerTools}
                    {composerStatus ? <div className="min-w-0 text-[11px] text-muted-foreground">{composerStatus}</div> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {composerEnd}
                    <ThreadPrimitive.If running={false}>
                      <ComposerPrimitive.Send disabled={blocked || attachmentUploading} aria-label={labels.send} title={attachmentUploading ? labels.processing : labels.send} className="mr-0.5 mt-px flex size-[30px] shrink-0 items-center justify-center text-brand transition-all duration-200 disabled:cursor-not-allowed disabled:text-muted-foreground/50">
                        <Send className="size-[22px]" />
                      </ComposerPrimitive.Send>
                    </ThreadPrimitive.If>
                    <ThreadPrimitive.If running>
                      <ComposerPrimitive.Cancel aria-label={labels.stop} title={labels.stop} className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-destructive hover:bg-muted">
                        <CirclePause className="size-5" />
                      </ComposerPrimitive.Cancel>
                    </ThreadPrimitive.If>
                  </div>
                </div>
              </div>
            </ComposerPrimitive.AttachmentDropzone>
          </ComposerPrimitive.Root>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}

export function ChatThread({
  runtime,
  assistantName,
  allowAttachments = false,
  allowEdit = false,
  allowRegenerate = true,
  branchNavigation = [],
  busy = false,
  disabled = false,
  labels: labelOverrides,
  transformUserText = (text) => text,
  ...props
}: ChatThreadProps) {
  const labels = useMemo(
    () => ({ ...chatThreadDefaultLabels, ...labelOverrides }),
    [labelOverrides],
  );
  return (
    <LabelsContext.Provider value={labels}>
      <UserTextTransformContext.Provider value={transformUserText}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatThreadContent
            {...props}
            assistantName={assistantName}
            allowAttachments={allowAttachments}
            allowEdit={allowEdit}
            allowRegenerate={allowRegenerate}
            branchNavigation={branchNavigation}
            busy={busy}
            disabled={disabled}
          />
        </AssistantRuntimeProvider>
      </UserTextTransformContext.Provider>
    </LabelsContext.Provider>
  );
}
