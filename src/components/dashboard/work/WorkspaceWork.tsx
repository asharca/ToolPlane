'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type UIEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ContextMenu, Popover } from 'radix-ui';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Archive,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CirclePause,
  Clock3,
  Cpu,
  FileText,
  FileOutput,
  Folder,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AgentModelDialog } from '@/components/dashboard/agents/AgentModelDialog';
import { ReasoningEffortControl } from '@/components/dashboard/agents/ReasoningEffortControl';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import {
  ConversationAttachmentChip,
  ConversationAttachmentPicker,
  ConversationAttachmentRemoveButton,
  ConversationContextUsage,
  ConversationComposerExpand,
  conversationComposerClassName,
  conversationComposerInputClassName,
  conversationComposerToolbarClassName,
  useConversationComposerExpansion,
} from '@/components/dashboard/ConversationComposer';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { McpPromptPickerButton } from '@/components/dashboard/McpPromptPickerButton';
import {
  AssistantMarkdown,
  AssistantReply,
  ConversationPendingIndicator,
  assistantMessageActionClassName,
} from '@/components/dashboard/ConversationMessage';
import { callSandboxTool, SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';
import { resolveContextUsage, type ContextUsageSnapshot } from '@/lib/context-usage';
import { deleteAgentAction } from '@/lib/agents/actions';
import { normalizeReasoningEffort, type ReasoningEffort } from '@/lib/agents/constants';
import { startSandboxAction } from '@/lib/sandboxes/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';

type WorkAgent = {
  id: string;
  name: string;
  supportsWork: boolean;
  ready: boolean;
  runtimeKind: string | null;
  providerId?: string | null;
  providerIds?: string[];
  providerLabel?: string;
  model?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  sandboxes: Array<{
    id: string;
    name: string;
    kind: string;
    deploymentId: string;
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
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeKind?: string;
  data?: unknown;
};

type WorkActivity = {
  id: string;
  type: 'runtime' | 'reasoning' | 'tool';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeKind?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

type WorkMessage = { id: string; role: string; parts: WorkPart[] };

type WorkApproval = {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: string;
};

type WorkPanel = 'files' | 'terminal' | 'context';

type WorkItem = {
  id: string;
  agentId: string;
  title: string | null;
  task: string | null;
  acceptanceCriteria: string | null;
  runtimeKind: string;
  status: string;
  maxSteps: number;
  stepCount: number;
  waitingQuestion: string | null;
  result: string | null;
  error: string | null;
  artifacts: string[];
  conversationId: string;
  reasoningEffort?: ReasoningEffort | null;
  hermesProfile?: string | null;
  hermesProvider?: string | null;
  hermesModel?: string | null;
  workingDirectory?: string;
  sandbox: { id: string; name: string; kind: string; deploymentId: string; running: boolean } | null;
  messages: WorkMessage[];
  approvals: WorkApproval[];
};

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const STOPPABLE_STATUSES = new Set(['queued', 'running', 'waiting_approval']);
const MESSAGEABLE_STATUSES = new Set(['idle', 'waiting_user', 'completed', 'failed']);
const ARCHIVABLE_STATUSES = new Set(['idle', 'completed', 'failed', 'cancelled']);
const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function statusDotClass(status: string) {
  if (status === 'idle' || status === 'completed') return 'text-emerald-500';
  if (status === 'failed' || status === 'cancelled') return 'text-red-500';
  if (status === 'running' || status === 'queued' || status === 'cancelling') return 'text-blue-500';
  if (status === 'waiting_user' || status === 'waiting_approval') return 'text-amber-500';
  return 'text-zinc-400';
}

function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'claude-code') return 'Claude Code';
  if (kind === 'dsh') return 'DeepSeek Harness';
  if (kind === 'hermes') return 'Hermes';
  return 'Pi';
}

function workHref(slug: string, id: string) {
  return `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(id)}`;
}

function agentSettingsHref(slug: string, agentId: string, returnTo: string) {
  return `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?settings=agent&returnTo=${encodeURIComponent(returnTo)}`;
}

function formatValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 20_000 ? `${text.slice(0, 20_000)}\n[truncated]` : text;
  } catch {
    return String(value);
  }
}

type ControlOption = { value: string; label: string; description?: string; disabled?: boolean };

function TopControlMenu({
  icon: Icon,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  options: ControlOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          title={disabled ? selected?.label ?? label : label}
          className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-100"
        >
          <Icon className="size-4 shrink-0" />
          <span className="hidden max-w-36 truncate sm:block">{selected?.label ?? label}</span>
          {!disabled ? <ChevronDown className="size-3.5 shrink-0" /> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={5}
          collisionPadding={10}
          className="z-50 w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
        >
          <div role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                onClick={() => { onChange(option.value); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-muted disabled:opacity-45"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.description ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{option.description}</span> : null}
                </span>
                {option.value === value ? <Check className="size-3.5 shrink-0" /> : null}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function joinWorkPath(base: string, name: string) {
  return base === '.' ? name : `${base.replace(/\/+$/, '')}/${name}`;
}

function parentWorkPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/') || '.';
}

function displayWorkPath(path: string, workspaceRoot = '/workspace') {
  return path === '.' ? workspaceRoot : `${workspaceRoot}/${path}`;
}

function WorkDirectoryControl({
  sandbox,
  value,
  locked,
  workspaceRoot = '/workspace',
  onChange,
}: {
  sandbox: WorkAgent['sandboxes'][number] | null;
  value: string;
  locked: boolean;
  workspaceRoot?: string;
  onChange: (path: string) => void;
}) {
  const t = useTranslations('console.work');
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(value);
  const [pathInput, setPathInput] = useState(displayWorkPath(value, workspaceRoot));
  const [entries, setEntries] = useState<SandboxFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (nextPath: string) => {
    if (!sandbox) return;
    setLoading(true);
    setLoadError(null);
    try {
      const raw = await callSandboxTool(
        `/api/v1/mcp/${sandbox.deploymentId}/rpc`,
        'list_dir',
        { path: nextPath },
        t('directoryLoadError'),
      );
      const listing = parseSandboxDirectoryText(raw, nextPath);
      if (!listing) throw new Error(t('directoryLoadError'));
      setPath(listing.path);
      setPathInput(displayWorkPath(listing.path, workspaceRoot));
      setEntries(listing.entries.filter((entry) => entry.type === 'dir').sort((a, b) => a.name.localeCompare(b.name)));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : t('directoryLoadError'));
    } finally {
      setLoading(false);
    }
  }, [sandbox, t, workspaceRoot]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) void load(value);
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={locked || (!sandbox?.running && sandbox?.kind !== 'hermes')}
          aria-label={t('workingDirectory')}
          title={displayWorkPath(value, workspaceRoot)}
          className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-100"
        >
          <Folder className="size-4 shrink-0" />
          <span className="hidden max-w-48 truncate sm:block">{displayWorkPath(value, workspaceRoot)}</span>
          {!locked ? <ChevronDown className="size-3.5 shrink-0" /> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={5} collisionPadding={10} className="z-50 flex h-96 w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none">
          <form
            className="flex items-center gap-1 border-b border-border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = pathInput.replace(/\\/g, '/').replace(
                workspaceRoot === '/opt/data/workspace' ? /^\/opt\/data\/workspace\/?/ : /^\/workspace\/?/,
                '',
              ).replace(/^\/+/, '') || '.';
              void load(next);
            }}
          >
            <button type="button" disabled={path === '.' || loading} onClick={() => void load(parentWorkPath(path))} aria-label={t('parentDirectory')} className="ui-button-ghost ui-icon-button shrink-0">
              <ArrowUp className="size-4" />
            </button>
            <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} aria-label={t('directoryPath')} className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:border-foreground/30" />
          </form>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {loading ? <div className="flex h-full items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div> : null}
            {!loading && loadError ? <p role="alert" className="p-3 text-xs text-destructive">{loadError}</p> : null}
            {!loading && !loadError && !entries.length ? <p className="p-3 text-center text-xs text-muted-foreground">{t('noSubdirectories')}</p> : null}
            {!loading && !loadError ? entries.map((entry) => (
              <button key={entry.name} type="button" onClick={() => void load(joinWorkPath(path, entry.name))} className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs hover:bg-muted">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            )) : null}
          </div>
          <div className="border-t border-border p-2">
            <button type="button" disabled={loading || Boolean(loadError)} onClick={() => { onChange(path); setOpen(false); }} className="ui-button-primary h-8 w-full text-xs">
              {t('useDirectory', { path: displayWorkPath(path, workspaceRoot) })}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkTranscript({
  agentName,
  messages,
  status,
  streamText,
  streamActivities,
  streaming,
}: {
  agentName: string;
  messages: WorkMessage[];
  status: string;
  streamText: string;
  streamActivities: WorkActivity[];
  streaming: boolean;
}) {
  const t = useTranslations('console.work');
  const agentsT = useTranslations('console.agents');
  const common = useTranslations('common');
  const copyButtonClassName = `${assistantMessageActionClassName} opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/message:opacity-100 group-hover/message:opacity-100`;
  const transcript = streaming
    ? [...messages, {
        id: 'work-stream',
        role: 'assistant',
        parts: [
          ...streamActivities.map((activity): WorkPart => {
            if (activity.type === 'tool') {
              return {
                type: 'work-tool',
                toolCallId: activity.toolCallId,
                toolName: activity.toolName,
                input: activity.input,
                output: activity.output,
                isError: activity.isError,
                status: activity.status,
              };
            }
            if (activity.type === 'reasoning') {
              return { type: 'reasoning', text: activity.text, status: activity.status };
            }
            return {
              type: 'work-runtime',
              runtimeKind: activity.runtimeKind,
              status: activity.status,
            };
          }),
          ...(streamText ? [{ type: 'text', text: streamText }] : []),
        ],
      }]
    : messages;

  if (!transcript.length) {
    return (
      <div className="flex min-h-52 items-center justify-center px-6 text-sm text-muted-foreground">
        <Clock3 className="mr-2 size-4" />
        {t('noMessages')}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[53rem] px-6 py-1.5">
      {transcript.map((message) => {
        const isStreamingMessage = message.id === 'work-stream';
        const rawText = message.parts
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        const text = isStreamingMessage ? rawText : rawText.trim();
        const toolParts = message.parts.filter((part) => part.type === 'work-tool');
        const reasoningParts = message.parts.filter((part) => part.type === 'reasoning');
        const allRuntimeParts = message.parts.filter((part) => part.type === 'work-runtime');
        const runtimeParts = (reasoningParts.length || toolParts.length)
          && allRuntimeParts.every((part) => part.status !== 'failed' && part.status !== 'cancelled')
          ? [] : allRuntimeParts;
        const processParts = [...reasoningParts, ...toolParts, ...runtimeParts];
        const activeTool = [...toolParts].reverse().find((part) => part.status === 'running');
        const activeReasoning = reasoningParts.some((part) => part.status === 'running');
        const activeRuntime = runtimeParts.find((part) => part.status === 'running');
        const processRunning = Boolean(activeTool || activeReasoning || activeRuntime);
        const processFailed = processParts.some((part) => part.isError || part.status === 'failed');
        const processCancelled = processParts.some((part) => part.status === 'cancelled');
        const activeLabel = activeTool?.toolName
          ? t('usingTool', { tool: activeTool.toolName })
          : activeReasoning
            ? t('thinking')
            : activeRuntime
              ? t('runtimeWorking', { runtime: runtimeLabel(activeRuntime.runtimeKind) })
              : '';
        const fileParts = message.parts.filter((part) => (
          part.type === 'file'
          && typeof part.filename === 'string'
          && typeof part.url === 'string'
          && part.url.startsWith('/api/v1/attachments/')
        ));
        const attachmentLinks = fileParts.length ? (
          <div className="flex max-w-full flex-wrap gap-1.5">
            {fileParts.map((part, index) => (
              <a
                key={`${part.url}-${index}`}
                href={part.url}
                download={part.filename}
                className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md bg-muted/70 px-2 text-xs text-foreground hover:bg-muted"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{part.filename}</span>
              </a>
            ))}
          </div>
        ) : null;

        if (message.role === 'user') {
          return (
            <article key={message.id} className="group/message flex flex-col items-end rounded-[10px] pt-2.5">
              <div className="flex max-w-full items-start justify-end gap-2.5">
                <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] break-words rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-[1.65] text-foreground">
                  {attachmentLinks}
                  {text ? <span className="block whitespace-pre-wrap">{text}</span> : null}
                </div>
                <div aria-label={agentsT('user')} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRound className="size-4" />
                </div>
              </div>
              {text ? (
                <div className="mr-10 min-h-[26px]">
                  <CopyButton text={text} label={common('copy')} iconOnly className={copyButtonClassName} />
                </div>
              ) : null}
            </article>
          );
        }

        return (
          <AssistantReply
            key={message.id}
            agentName={agentName}
            streaming={isStreamingMessage}
            actions={!isStreamingMessage && text ? (
              <CopyButton text={text} label={common('copy')} iconOnly className={copyButtonClassName} />
            ) : undefined}
          >
            <div className="min-w-0">
              {attachmentLinks}
              {processParts.length ? (
                <details open={isStreamingMessage || processFailed} className="group/process my-1.5 text-xs">
                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
                    <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/process:rotate-90" />
                    {processRunning ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : processFailed ? <CircleAlert className="size-3.5 shrink-0 text-red-600" /> : processCancelled ? <CirclePause className="size-3.5 shrink-0" /> : <CheckCircle2 className="size-3.5 shrink-0" />}
                    <span className="shrink-0 font-medium text-foreground">{processRunning ? t('processing') : processFailed ? t('processFailed') : processCancelled ? t('processCancelled') : t('processed')}</span>
                    {activeLabel ? <span className="min-w-0 truncate text-[11px]">{activeLabel}</span> : null}
                  </summary>
                  <div className="ml-5 py-1">
                    {runtimeParts.map((part, index) => (
                      <div key={`${message.id}-runtime-${index}`} className="flex min-h-7 items-center gap-2 rounded-md px-1 text-muted-foreground">
                        {part.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : part.status === 'failed' ? <CircleAlert className="size-3.5 text-red-600" /> : part.status === 'cancelled' ? <CirclePause className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                        <TerminalSquare className="size-3.5" />
                        <span>{part.status === 'running' ? t('runtimeWorking', { runtime: runtimeLabel(part.runtimeKind) }) : part.status === 'cancelled' ? t('runtimeCancelled', { runtime: runtimeLabel(part.runtimeKind) }) : runtimeLabel(part.runtimeKind)}</span>
                      </div>
                    ))}
                    {reasoningParts.map((part, index) => (
                      <details key={`${message.id}-reasoning-${index}`} open={part.status === 'running'} className="group/reasoning rounded-md">
                        <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
                          {part.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                          <Activity className="size-3.5" />
                          <span>{part.status === 'running' ? t('thinking') : t('thought')}</span>
                          {part.text ? <ChevronRight className="ml-auto size-3.5 transition-transform group-open/reasoning:rotate-90" /> : null}
                        </summary>
                        {part.text ? <pre className="ml-5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">{part.text}</pre> : null}
                      </details>
                    ))}
                    {toolParts.map((part, index) => {
                      const running = part.status === 'running';
                      const failed = part.isError || part.status === 'failed';
                      const cancelled = part.status === 'cancelled';
                      return (
                        <details key={part.toolCallId ?? `${message.id}-${index}`} open={failed} className={cx('group/tool rounded-md', failed && 'bg-red-500/5')}>
                          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 marker:content-none hover:bg-muted/50">
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
                            <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{part.toolName}</span>
                            <span className={cx('inline-flex shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium', failed ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
                              {running ? <Loader2 className="size-3 animate-spin" /> : failed ? <CircleAlert className="size-3" /> : cancelled ? <CirclePause className="size-3" /> : <CheckCircle2 className="size-3" />}
                              {running ? t('toolRunning') : failed ? t('toolFailed') : cancelled ? t('toolCancelled') : t('toolCompleted')}
                            </span>
                          </summary>
                          <div className="ml-5 space-y-3 px-2 py-2">
                            <div>
                              <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{agentsT('toolInput')}</p>
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground">{formatValue(part.input)}</pre>
                            </div>
                            {!running && part.output !== undefined ? (
                              <div>
                                <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{agentsT('toolOutput')}</p>
                                <pre className={cx('max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[11px] leading-relaxed', failed ? 'bg-red-500/5 text-red-800 dark:text-red-200' : 'bg-muted/30 text-foreground')}>{formatValue(part.output)}</pre>
                              </div>
                            ) : null}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </details>
              ) : null}
              {text ? (
                <AssistantMarkdown text={text} streaming={isStreamingMessage} />
              ) : null}
              {isStreamingMessage && !text && !processParts.length ? (
                <ConversationPendingIndicator
                  label={status === 'queued' ? t('preparingReply') : t('generatingReply')}
                  className="py-0.5 pl-0"
                />
              ) : null}
            </div>
          </AssistantReply>
        );
      })}
    </div>
  );
}

function WorkContextUsagePanel({
  busy,
  usage,
}: {
  busy: boolean;
  usage: ContextUsageSnapshot | null;
}) {
  const t = useTranslations('console.agents');
  const percentage = usage
    ? Math.round(Math.min(100, Math.max(0, usage.usedTokens / usage.maxTokens * 100)))
    : null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <section aria-busy={busy || undefined} className="space-y-3 rounded-xl bg-muted/35 p-4 text-xs">
        <h2 className="flex items-center gap-2 font-medium text-foreground">
          <Activity className="size-4 text-muted-foreground" />
          {t('contextUsage')}
        </h2>
        {usage && percentage !== null ? (
          <>
            <div
              role="progressbar"
              aria-label={`${t('contextUsage')} ${percentage}%`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cx('h-full rounded-full bg-brand transition-[width]', busy && 'animate-pulse')}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span className="shrink-0 tabular-nums">
                {usage.estimated ? '≈ ' : ''}{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} ({percentage}%)
              </span>
              <span className="min-w-0 truncate">{usage.modelName}</span>
            </div>
            {usage.estimated ? <p className="text-[11px] text-muted-foreground">{t('contextUsageEstimated')}</p> : null}
          </>
        ) : (
          <p className="text-muted-foreground">—</p>
        )}
      </section>
    </div>
  );
}

export function WorkspaceWork({
  slug,
  workspaceId,
  agents,
  sessions,
  providers = [],
  selectedWorkSessionId,
  selectedSession,
  requestedAgentId,
}: {
  slug: string;
  workspaceId: string;
  agents: WorkAgent[];
  sessions: WorkItem[];
  providers?: Array<ModelProviderOption & { format: string }>;
  selectedWorkSessionId: string | null;
  selectedSession?: WorkItem | null;
  requestedAgentId?: string;
}) {
  const t = useTranslations('console.work');
  const tAgents = useTranslations('console.agents');
  const tSandboxes = useTranslations('console.sandboxes');
  const initialSelected = selectedSession ?? sessions.find((item) => item.id === selectedWorkSessionId) ?? null;
  const workAgents = agents.filter((item) => item.supportsWork);
  const [items, setItems] = useState(sessions);
  const [liveSelected, setLiveSelected] = useState<WorkItem | null>(null);
  const [creatingMode, setCreatingMode] = useState(!initialSelected);
  const [mobilePane, setMobilePane] = useState<'sessions' | 'work'>('work');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionQuery, setSessionQuery] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const selected = creatingMode ? null : liveSelected?.id === selectedWorkSessionId ? liveSelected : initialSelected;
  const initialAgentId = initialSelected?.agentId
    ?? workAgents.find((item) => item.id === requestedAgentId)?.id
    ?? workAgents[0]?.id
    ?? '';
  const [agentId, setAgentId] = useState(initialAgentId);
  const reasoningScope = selected?.id ?? `agent:${agentId}`;
  const [reasoningSelection, setReasoningSelection] = useState<{
    scope: string;
    value: ReasoningEffort;
  }>({
    scope: initialSelected?.id ?? `agent:${initialAgentId}`,
    value: normalizeReasoningEffort(initialSelected?.reasoningEffort) ?? 'default',
  });
  const reasoningEffort = reasoningSelection.scope === reasoningScope
    ? reasoningSelection.value
    : normalizeReasoningEffort(selected?.reasoningEffort) ?? 'default';
  const setReasoningEffort = (value: ReasoningEffort) => {
    setReasoningSelection({ scope: reasoningScope, value });
  };
  const [hermesDraftSelection, setHermesDraftSelection] = useState<{
    agentId: string;
    profile: string;
    provider: string | null;
    model: string | null;
  } | null>(null);
  const [sandboxId, setSandboxId] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(initialSelected?.workingDirectory ?? '.');
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<WorkAgent | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const {
    expanded: composerExpanded,
    inputRef: composerInputRef,
    minRows: composerMinRows,
    toggle: toggleComposer,
  } = useConversationComposerExpansion();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [desktopPanel, setDesktopPanel] = useState<WorkPanel | null>(null);
  const [mobilePanel, setMobilePanel] = useState<WorkPanel | null>(null);
  const transcriptViewportRef = useRef<HTMLDivElement>(null);
  const followingTranscriptRef = useRef(true);
  const [followingTranscript, setFollowingTranscript] = useState(true);
  const [streamOutput, setStreamOutput] = useState<{
    workSessionId: string;
    text: string;
    activities: WorkActivity[];
  }>({ workSessionId: '', text: '', activities: [] });
  const agent = useMemo(() => agents.find((item) => item.id === agentId) ?? null, [agents, agentId]);
  const selectedAgent = selected ? agents.find((item) => item.id === selected.agentId) ?? null : null;
  const sandboxOptions = agent?.sandboxes ?? [];
  const activeSandboxId = sandboxId || sandboxOptions.find((item) => item.isDefault)?.id || sandboxOptions[0]?.id || '';
  const activeSandbox = sandboxOptions.find((item) => item.id === activeSandboxId) ?? null;
  const controlAgent = selectedAgent ?? agent;
  const controlSandbox = selected?.sandbox
    ? { ...selected.sandbox, isDefault: false }
    : activeSandbox;
  const controlHermesSelection = controlAgent?.runtimeKind === 'hermes'
    ? selected
      ? {
          profile: selected.hermesProfile ?? 'default',
          provider: selected.hermesProvider ?? null,
          model: selected.hermesModel ?? null,
        }
      : hermesDraftSelection?.agentId === controlAgent.id
        ? hermesDraftSelection
        : { agentId: controlAgent.id, profile: 'default', provider: null, model: null }
    : null;
  const controlWorkspaceRoot = controlSandbox?.kind === 'hermes' ? '/opt/data/workspace' : '/workspace';
  const workspaceRpcApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/rpc`
    : controlSandbox ? `/api/v1/mcp/${controlSandbox.deploymentId}/rpc` : undefined;
  const workspaceTerminalApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/terminal`
    : controlAgent?.runtimeKind === 'hermes'
      ? `/api/v1/agents/${controlAgent.id}/terminal`
      : controlSandbox ? `/api/v1/mcp/${controlSandbox.deploymentId}/terminal` : undefined;
  const controlModelLabel = controlHermesSelection
    ? `${controlHermesSelection.profile} · ${controlHermesSelection.model ?? tAgents('profileDefault')}`
    : controlAgent?.model || t('selectModel');
  const activeWorkingDirectory = selected?.workingDirectory ?? workingDirectory;
  const workReturnTo = selected ? workHref(slug, selected.id) : `/app/${encodeURIComponent(slug)}/work`;
  const pendingApprovals = selected?.approvals.filter((approval) => approval.status === 'pending') ?? [];
  const selectedStatus = selected?.status;
  const streamText = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.text : '';
  const streamActivities = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.activities : EMPTY_WORK_ACTIVITIES;
  const contextUsage = useMemo(() => resolveContextUsage(selected?.messages ?? [], {
    maxTokens: controlAgent?.contextWindow,
    modelName: controlAgent?.model,
    context: streamText,
    estimated: controlAgent?.contextWindowEstimated,
  }), [controlAgent?.contextWindow, controlAgent?.contextWindowEstimated, controlAgent?.model, selected?.messages, streamText]);
  const workspacePanelOpen = Boolean(desktopPanel && (desktopPanel === 'context' ? selected : controlSandbox));

  const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const viewport = transcriptViewportRef.current;
    if (!viewport) return;
    followingTranscriptRef.current = true;
    setFollowingTranscript(true);
    if (behavior === 'smooth' && typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  const handleTranscriptScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const viewport = event.currentTarget;
    const following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
    if (followingTranscriptRef.current === following) return;
    followingTranscriptRef.current = following;
    setFollowingTranscript(following);
  }, []);

  const statusLabels: Record<string, string> = {
    idle: t('statusIdle'),
    queued: t('statusQueued'),
    running: t('statusRunning'),
    waiting_user: t('statusWaitingUser'),
    waiting_approval: t('statusWaitingApproval'),
    cancelling: t('statusCancelling'),
    completed: t('statusCompleted'),
    failed: t('statusFailed'),
    cancelled: t('statusCancelled'),
    archived: t('statusArchived'),
  };
  const visibleAgents = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    return agents.flatMap((item) => {
      const agentSessions = items.filter((session) => session.agentId === item.id);
      if (!query) return [{ agent: item, sessions: agentSessions }];
      const agentMatches = item.name.toLocaleLowerCase().includes(query);
      const matchingSessions = agentSessions.filter((session) => [
        session.title,
        session.task,
        session.sandbox?.name,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
      return agentMatches || matchingSessions.length
        ? [{ agent: item, sessions: agentMatches ? agentSessions : matchingSessions }]
        : [];
    });
  }, [agents, items, sessionQuery]);

  const refreshSelected = useCallback(async () => {
    if (!selectedWorkSessionId || creatingMode) return false;
    try {
      const response = await fetch(`/api/v1/work-sessions/${selectedWorkSessionId}`, { cache: 'no-store' });
      if (!response.ok) return false;
      const next = await response.json() as WorkItem;
      next.artifacts = Array.isArray(next.artifacts)
        ? next.artifacts.filter((item): item is string => typeof item === 'string')
        : [];
      setLiveSelected(next);
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
      return true;
    } catch {
      return false;
    }
  }, [creatingMode, selectedWorkSessionId]);

  const selectedActive = Boolean(selectedStatus && ACTIVE_STATUSES.has(selectedStatus));

  useEffect(() => {
    if (!selected?.id) return;
    scrollTranscriptToBottom();
  }, [scrollTranscriptToBottom, selected?.id]);

  useEffect(() => {
    if (!selected?.id || !followingTranscriptRef.current) return;
    scrollTranscriptToBottom();
  }, [scrollTranscriptToBottom, selected?.artifacts, selected?.id, selected?.messages, selectedActive, streamActivities, streamText]);

  useEffect(() => {
    if (!selectedWorkSessionId || creatingMode || !selectedActive || typeof EventSource === 'undefined') return undefined;

    let disposed = false;
    let finishing = false;
    const source = new EventSource(`/api/v1/work-sessions/${encodeURIComponent(selectedWorkSessionId)}/events`);

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
        setStreamOutput({ workSessionId: selectedWorkSessionId, text: '', activities: [] });
      }
    };

    source.addEventListener('snapshot', (event) => {
      const next = payload<{ text?: string; activities?: WorkActivity[]; active?: boolean; done?: boolean }>(event);
      if (!next) return;
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: next.text ?? '',
        activities: Array.isArray(next.activities) ? next.activities : [],
      });
      if (next.done) {
        void finish();
        return;
      }
    });
    source.addEventListener('start', () => {
      setStreamOutput({ workSessionId: selectedWorkSessionId, text: '', activities: [] });
      void refreshSelected();
    });
    source.addEventListener('delta', (event) => {
      const next = payload<{ delta?: string }>(event);
      if (!next?.delta) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text: (current.workSessionId === selectedWorkSessionId ? current.text : '') + next.delta,
        activities: current.workSessionId === selectedWorkSessionId ? current.activities : [],
      }));
    });
    source.addEventListener('activity', (event) => {
      const next = payload<{ activities?: WorkActivity[] }>(event);
      if (!Array.isArray(next?.activities)) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text: current.workSessionId === selectedWorkSessionId ? current.text : '',
        activities: next.activities ?? [],
      }));
      if (next.activities.some((activity) => activity.toolName === 'Hermes approval' && activity.status === 'running')) {
        void refreshSelected();
      }
    });
    source.addEventListener('done', () => void finish());

    return () => {
      disposed = true;
      source.close();
    };
  }, [creatingMode, refreshSelected, selectedActive, selectedWorkSessionId]);

  function startNewWork(nextAgentId = agentId) {
    setAgentId(nextAgentId);
    setSandboxId('');
    setCreatingMode(true);
    setMobilePane('work');
    setDraft('');
    setAttachments([]);
    setReasoningSelection({ scope: `agent:${nextAgentId}`, value: 'default' });
    setHermesDraftSelection(null);
    setWorkingDirectory('.');
    setError(null);
    window.history.replaceState(window.history.state, '', `/app/${encodeURIComponent(slug)}/work`);
  }

  async function uploadAttachments(): Promise<string[]> {
    const uploaded: string[] = [];
    try {
      for (const file of attachments) {
        const query = new URLSearchParams({ filename: file.name });
        const response = await fetch(`/api/v1/workspaces/${workspaceId}/attachments?${query}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        const result = await response.json().catch(() => ({})) as { id?: string; error?: string };
        if (!response.ok || !result.id) throw new Error(result.error || tAgents('attachmentUploadFailed'));
        uploaded.push(result.id);
      }
      return uploaded;
    } catch (error) {
      await Promise.all(uploaded.map((id) => fetch(`/api/v1/attachments/${id}`, { method: 'DELETE' }).catch(() => undefined)));
      throw error;
    }
  }

  async function discardUploaded(ids: string[]) {
    await Promise.all(ids.map((id) => fetch(`/api/v1/attachments/${id}`, { method: 'DELETE' }).catch(() => undefined)));
  }

  async function createWork() {
    if (!agentId || !activeSandboxId || !draft.trim()) return;
    setBusy('create');
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
      const response = await fetch('/api/v1/work-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId,
          sandboxId: activeSandboxId,
          task: draft.trim(),
          workingDirectory,
          attachmentIds,
          ...(agent?.runtimeKind === 'hermes' ? {
            reasoningEffort,
            ...(hermesDraftSelection?.agentId === agent.id ? {
              hermesProfile: hermesDraftSelection.profile,
              hermesProvider: hermesDraftSelection.provider,
              hermesModel: hermesDraftSelection.model,
            } : {}),
          } : {}),
        }),
      });
      const body = await response.json() as { workSessionId?: string; error?: string };
      if (!response.ok || !body.workSessionId) throw new Error(body.error || t('createError'));
      window.location.assign(workHref(slug, body.workSessionId));
    } catch (cause) {
      await discardUploaded(attachmentIds);
      setError(cause instanceof Error ? cause.message : t('createError'));
      setBusy(null);
    }
  }

  async function postAction(path: string, body?: Record<string, unknown>) {
    if (!selected) return false;
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(`/api/v1/work-sessions/${selected.id}/${path}`, {
        method: 'POST',
        ...(body ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        } : {}),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || t('createError'));
      await refreshSelected();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('createError'));
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const input = draft.trim();
    if (!input) return;
    if (!selected) return createWork();
    setBusy('input');
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tAgents('attachmentUploadFailed'));
      setBusy(null);
      return;
    }
    if (await postAction('input', {
      input,
      ...(selected.runtimeKind === 'hermes' ? { reasoningEffort } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    })) {
      setDraft('');
      setAttachments([]);
    } else {
      await discardUploaded(attachmentIds);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function decideApproval(approvalId: string, decision: 'allow' | 'deny') {
    await postAction(`approvals/${approvalId}`, { decision });
  }

  async function archiveWork(id: string) {
    const response = await fetch(`/api/v1/work-sessions/${id}`, { method: 'DELETE' });
    if (response.ok) window.location.assign(`/app/${encodeURIComponent(slug)}/work`);
  }

  const running = Boolean(selected && ACTIVE_STATUSES.has(selected.status));
  const draftHermesModelReady = agent?.runtimeKind === 'hermes'
    && hermesDraftSelection?.agentId === agent.id
    && Boolean(hermesDraftSelection.provider && hermesDraftSelection.model);
  const canSend = selected
    ? MESSAGEABLE_STATUSES.has(selected.status)
    : Boolean(
        (agent?.ready || draftHermesModelReady)
        && activeSandbox
        && (activeSandbox.running || agent?.runtimeKind === 'hermes'),
      );

  function togglePanel(panel: WorkPanel) {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1280px)').matches) {
      setDesktopPanel((current) => current === panel ? null : panel);
      return;
    }
    setMobilePanel(panel);
  }

  return (
    <div className={cx(
      'grid h-full min-h-0 grid-cols-1 overflow-hidden bg-background',
      sidebarOpen && 'lg:grid-cols-[15rem_minmax(0,1fr)]',
      workspacePanelOpen && (sidebarOpen
        ? 'xl:grid-cols-[15rem_minmax(32rem,1fr)_24rem]'
        : 'xl:grid-cols-[minmax(32rem,1fr)_24rem]'),
    )}>
      <aside className={cx(
        mobilePane === 'work'
          ? (sidebarOpen ? 'hidden lg:flex' : 'hidden')
          : (sidebarOpen ? 'flex' : 'flex lg:hidden'),
        'min-h-0 flex-col overflow-hidden bg-background p-1.5',
      )}>
        <div className="relative shrink-0 px-0.5">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="h-7 w-full rounded-full border-0 bg-muted/70 pl-7 pr-7 text-[11px] outline-none focus:ring-1 focus:ring-brand/35"
          />
          {sessionQuery ? (
            <button type="button" onClick={() => setSessionQuery('')} aria-label={t('clearSearch')} title={t('clearSearch')} className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-background">
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          <div className="flex h-8 items-center justify-between px-2.5">
            <p className="truncate text-xs font-medium text-muted-foreground">{tAgents('agents')}</p>
            <Link href={`/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`} aria-label={tAgents('addAgent')} title={tAgents('addAgent')} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Plus className="size-3.5" />
            </Link>
          </div>
          <ul>
            {visibleAgents.map(({ agent: itemAgent, sessions: agentSessions }) => {
              const activeAgentId = selected?.agentId ?? agentId;
              const expanded = Boolean(sessionQuery)
                || (expandedAgents[itemAgent.id] ?? itemAgent.id === activeAgentId);
              const row = (
                <div className={cx(
                  'group flex h-8 min-w-0 items-center rounded-lg transition-colors',
                  itemAgent.id === activeAgentId ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60',
                )}>
                  <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-[13px]">
                    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
                      <Bot className="size-3.5" />
                      <span
                        className={cx(
                          'absolute right-0 top-0 size-1.5 rounded-full ring-1 ring-background',
                          itemAgent.supportsWork ? (itemAgent.ready ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-red-500',
                        )}
                        title={itemAgent.supportsWork ? (itemAgent.ready ? tAgents('ready1') : tAgents('needsModel')) : tAgents('runtimeUnavailable')}
                      />
                    </span>
                    <span className={cx('min-w-0 flex-1 truncate', itemAgent.id === activeAgentId && 'font-medium')}>{itemAgent.name}</span>
                  </div>
                  <Link
                    href={agentSettingsHref(slug, itemAgent.id, workReturnTo)}
                    aria-label={`${tAgents('configureAgent')} · ${itemAgent.name}`}
                    title={tAgents('configureAgent')}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Link>
                  {itemAgent.supportsWork ? (
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedAgents((current) => ({ ...current, [itemAgent.id]: true }));
                        startNewWork(itemAgent.id);
                      }}
                      aria-label={`${t('newWork')} · ${itemAgent.name}`}
                      title={t('newWork')}
                      className="mr-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100 focus:opacity-100"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={itemAgent.name}
                    aria-expanded={expanded}
                    aria-controls={`agent-work-sessions-${itemAgent.id}`}
                    title={expanded ? tAgents('hideConversations') : tAgents('showConversations')}
                    onClick={() => setExpandedAgents((current) => ({ ...current, [itemAgent.id]: !expanded }))}
                    className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                  </button>
                </div>
              );
              return (
                <li key={itemAgent.id} className="py-0.5">
                  <ContextMenu.Root modal={false}>
                    <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                        {itemAgent.supportsWork ? (
                          <ContextMenu.Item
                            onSelect={() => {
                              setExpandedAgents((current) => ({ ...current, [itemAgent.id]: true }));
                              startNewWork(itemAgent.id);
                            }}
                            className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                          >
                            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                            {t('newWork')}
                          </ContextMenu.Item>
                        ) : null}
                        <ContextMenu.Item asChild className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                          <Link href={`/app/${encodeURIComponent(slug)}/chat?agent=${encodeURIComponent(itemAgent.id)}`}>
                            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                            {tAgents('chat')}
                          </Link>
                        </ContextMenu.Item>
                        <ContextMenu.Item asChild className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                          <Link href={agentSettingsHref(slug, itemAgent.id, workReturnTo)}>
                            <Settings2 className="size-3.5 shrink-0 text-muted-foreground" />
                            {tAgents('configureAgent')}
                          </Link>
                        </ContextMenu.Item>
                        <ContextMenu.Separator className="my-1 h-px bg-border" />
                        <ContextMenu.Item
                          onSelect={() => setDeleteAgentTarget(itemAgent)}
                          className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                        >
                          <Trash2 className="size-3.5 shrink-0" />
                          {tAgents('deleteAgent')}
                        </ContextMenu.Item>
                      </ContextMenu.Content>
                    </ContextMenu.Portal>
                  </ContextMenu.Root>
                  {expanded ? (
                    <ul id={`agent-work-sessions-${itemAgent.id}`} className="ml-4 py-0.5 pl-1">
                      {agentSessions.length > 0 ? agentSessions.map((item) => (
                        <li key={item.id} className="group/session relative py-0.5">
                          <Link
                            href={workHref(slug, item.id)}
                            onClick={() => { setCreatingMode(false); setMobilePane('work'); }}
                            aria-current={item.id === selected?.id ? 'page' : undefined}
                            title={`${statusLabels[item.status] ?? item.status} · ${item.sandbox?.name ?? t('sandboxUnavailable')}`}
                            className={cx(
                              'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 pr-7 text-[13px]',
                              item.id === selected?.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60',
                            )}
                          >
                            <Circle className={cx('size-2 shrink-0 fill-current', statusDotClass(item.status))} />
                            <span className="min-w-0 flex-1 truncate">{item.title || item.task || t('untitled')}</span>
                          </Link>
                          {ARCHIVABLE_STATUSES.has(item.status) ? (
                            <button type="button" onClick={() => void archiveWork(item.id)} aria-label={t('archive')} title={t('archive')} className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/session:opacity-100 focus:opacity-100">
                              <Archive className="size-3.5" />
                            </button>
                          ) : null}
                        </li>
                      )) : (
                        <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">{t('noSessions')}</li>
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!visibleAgents.length ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('noSearchResults')}</p> : null}
        </div>
      </aside>

      <main className={cx(
        mobilePane === 'sessions' ? 'hidden lg:flex' : 'flex',
        'relative min-h-0 min-w-0 flex-col bg-background',
      )}>
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 px-2.5">
          <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            <button type="button" onClick={() => setMobilePane('sessions')} aria-label={t('showSidebar')} title={t('showSidebar')} className="ui-button-ghost ui-icon-button lg:!hidden">
              <PanelLeftOpen className="size-[18px]" />
            </button>
            <button type="button" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? t('hideSidebar') : t('showSidebar')} title={sidebarOpen ? t('hideSidebar') : t('showSidebar')} className="ui-button-ghost ui-icon-button hidden lg:!flex">
              {sidebarOpen ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
            </button>
            {selected && controlAgent ? (
              <Link
                href={agentSettingsHref(slug, controlAgent.id, workReturnTo)}
                aria-label={`${tAgents('configureAgent')}: ${controlAgent.name}`}
                title={tAgents('configureAgent')}
                className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted"><Bot className="size-3" /></span>
                <span className="hidden max-w-36 truncate sm:block">{controlAgent.name}</span>
              </Link>
            ) : (
              <TopControlMenu
                icon={Bot}
                label={t('agent')}
                value={controlAgent?.id ?? ''}
                options={workAgents.map((item) => ({
                  value: item.id,
                  label: item.name,
                  description: item.model || item.providerLabel || t('modelNotConfigured'),
                }))}
                onChange={(value) => {
                  setAgentId(value);
                  setSandboxId('');
                  setWorkingDirectory('.');
                  setHermesDraftSelection(null);
                }}
              />
            )}
            {controlAgent ? (
              <AgentModelDialog
                key={`${controlAgent.id}:${controlAgent.model ?? ''}`}
                open={modelDialogOpen}
                onOpenChange={setModelDialogOpen}
                slug={slug}
                agent={{
                  ...controlAgent,
                  providerId: controlAgent.providerId ?? null,
                  providerIds: controlAgent.providerIds ?? [],
                  model: controlAgent.model ?? null,
                }}
                providers={providers}
                confirmationMessage={selected?.messages.length ? t('modelSwitchConfirm') : undefined}
                hermesConversation={controlAgent.runtimeKind === 'hermes' ? {
                  id: selected?.conversationId ?? null,
                  profile: controlHermesSelection?.profile ?? 'default',
                  provider: controlHermesSelection?.provider ?? null,
                  model: controlHermesSelection?.model ?? null,
                  hasMessages: Boolean(selected?.messages.length),
                  editable: !selected || MESSAGEABLE_STATUSES.has(selected.status),
                  forkOnProfileChange: false,
                } : undefined}
                onHermesDraftChange={!selected ? (selection) => {
                  setHermesDraftSelection({ agentId: controlAgent.id, ...selection });
                } : undefined}
                onHermesSelectionSaved={selected ? refreshSelected : undefined}
                trigger={(
                  <button type="button" aria-label={t('model')} title={t('model')} className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                    {controlModelLabel !== t('selectModel') ? (
                      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[9px] font-semibold">{controlModelLabel.charAt(0).toUpperCase()}</span>
                    ) : <Cpu className="size-4 shrink-0" />}
                    <span className="hidden max-w-44 truncate sm:block">{controlModelLabel}</span>
                    <ChevronDown className="size-3.5 shrink-0" />
                  </button>
                )}
              />
            ) : null}
            <TopControlMenu
              icon={Boxes}
              label={t('sandbox')}
              value={controlSandbox?.id ?? ''}
              disabled={Boolean(selected)}
              options={(selected ? selectedAgent?.sandboxes ?? [] : sandboxOptions).map((item) => ({
                value: item.id,
                label: item.name,
                description: item.running ? (item.isDefault ? t('default') : undefined) : t('stopped'),
                disabled: !item.running && item.kind !== 'hermes',
              }))}
              onChange={(value) => {
                setSandboxId(value);
                setWorkingDirectory('.');
              }}
            />
            <WorkDirectoryControl
              key={controlSandbox?.id ?? 'none'}
              sandbox={controlSandbox}
              value={activeWorkingDirectory}
              locked={Boolean(selected)}
              workspaceRoot={controlWorkspaceRoot}
              onChange={setWorkingDirectory}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selected ? (
              <span className="hidden items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground md:flex">
                <Circle className={cx('size-2 fill-current', statusDotClass(selected.status))} />
                {statusLabels[selected.status] ?? selected.status}
              </span>
            ) : null}
            {selected && STOPPABLE_STATUSES.has(selected.status) ? (
              <button type="button" disabled={busy === 'cancel'} onClick={() => void postAction('cancel')} aria-label={t('cancel')} title={t('cancel')} className="ui-button-ghost ui-icon-button text-muted-foreground hover:text-destructive">
                {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
              </button>
            ) : null}
            {controlSandbox && !controlSandbox.running ? (
              <form action={startSandboxAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="sandboxId" value={controlSandbox.id} />
                <SubmitButton pendingLabel={tSandboxes('starting')} flash={false} className="ui-button-secondary h-8 px-2 text-xs">
                  <Play className="size-3.5" />
                  {tSandboxes('start')}
                </SubmitButton>
              </form>
            ) : null}
            {selected ? (
                <button type="button" onClick={() => togglePanel('context')} aria-label={tAgents('contextUsage')} title={tAgents('contextUsage')} aria-pressed={desktopPanel === 'context'} className={cx('ui-button-ghost ui-icon-button', desktopPanel === 'context' && 'bg-muted text-foreground')}>
                  <Activity className="size-4" />
                </button>
            ) : null}
            {controlSandbox ? (
              <>
                <button type="button" onClick={() => togglePanel('files')} aria-label={tSandboxes('files')} title={tSandboxes('files')} aria-pressed={desktopPanel === 'files'} className={cx('ui-button-ghost ui-icon-button', desktopPanel === 'files' && 'bg-muted text-foreground')}>
                  <Folder className="size-4" />
                </button>
                <button type="button" onClick={() => togglePanel('terminal')} aria-label={tSandboxes('terminal')} title={tSandboxes('terminal')} aria-pressed={desktopPanel === 'terminal'} className={cx('ui-button-ghost ui-icon-button', desktopPanel === 'terminal' && 'bg-muted text-foreground')}>
                  <TerminalSquare className="size-4" />
                </button>
              </>
            ) : null}
          </div>
        </header>

        {error ? <p role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p> : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={transcriptViewportRef}
            data-ui="work.transcript"
            onScroll={handleTranscriptScroll}
            className="h-full overflow-y-auto [overflow-anchor:none]"
          >
            {selected ? (
              <>
                <WorkTranscript
                  agentName={controlAgent?.name ?? t('agent')}
                  messages={selected.messages}
                  status={selected.status}
                  streamText={streamText}
                  streamActivities={streamActivities}
                  streaming={selectedActive}
                />
                {selected.artifacts.length ? (
                  <section className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-7">
                    <p className="flex items-center gap-2 text-xs font-semibold"><FileOutput className="size-4" />{t('artifacts')}</p>
                    <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                      {selected.artifacts.map((artifact) => <li key={artifact}>{artifact}</li>)}
                    </ul>
                  </section>
                ) : null}
              </>
            ) : (
              <div className="flex h-full min-h-64 items-center justify-center px-6 text-center">
                <div>
                  <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-5" /></span>
                  <h2 className="mt-3 text-base font-medium">{t('emptyTitle')}</h2>
                  {agent ? <p className="mt-1 text-xs text-muted-foreground">{agent.name}</p> : null}
                </div>
              </div>
            )}
          </div>
          {!followingTranscript && selected ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
              <button
                type="button"
                onClick={() => scrollTranscriptToBottom('smooth')}
                aria-label={tAgents('scrollToLatestMessage')}
                title={tAgents('scrollToLatestMessage')}
                className="pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowDown className="size-4" />
              </button>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 bg-background px-3 pb-3 sm:px-5 sm:pb-4">
          <div className="mx-auto max-w-3xl">
            {pendingApprovals.length ? (
              <div className="divide-y divide-amber-500/20 rounded-lg border border-amber-500/30 bg-amber-500/5">
                {pendingApprovals.map((approval) => (
                  <div key={approval.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="size-4 text-amber-600" />{t('approvalRequired')}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{approval.toolName}</p>
                      <details className="mt-1 text-[11px] text-muted-foreground">
                        <summary className="cursor-pointer">{t('details')}</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2">{formatValue(approval.input)}</pre>
                      </details>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" disabled={Boolean(busy)} onClick={() => void decideApproval(approval.id, 'deny')} className="ui-button-secondary h-8 px-3 text-xs">{t('deny')}</button>
                      <button type="button" disabled={Boolean(busy)} onClick={() => void decideApproval(approval.id, 'allow')} className="ui-button-primary h-8 px-3 text-xs">{t('allow')}</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <form
                data-ui="chat.composer"
                data-composer-inputbar=""
                data-composer-presentation="regular"
                onSubmit={(event) => void sendMessage(event)}
                className={conversationComposerClassName}
              >
                <ConversationComposerExpand expanded={composerExpanded} onToggle={toggleComposer} />
                {selected?.waitingQuestion ? <p className="px-[15px] pb-2 pt-1 text-xs font-medium">{selected.waitingQuestion}</p> : null}
                {attachments.length ? (
                  <div className="flex flex-wrap gap-1 px-[15px] pb-1">
                    {attachments.map((file, index) => (
                      <ConversationAttachmentChip
                        key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                        name={file.name}
                        thumbnail={<FileText className="size-3.5 text-muted-foreground" />}
                        removeButton={(
                          <ConversationAttachmentRemoveButton
                            label={tAgents('removeAttachment', { name: file.name })}
                            onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                          />
                        )}
                      />
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={composerInputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={t('taskPlaceholder')}
                  rows={composerMinRows}
                  className={conversationComposerInputClassName(composerExpanded)}
                />
                <div data-ui="part:composer-actions" data-composer-toolbar="" className={conversationComposerToolbarClassName}>
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    <ConversationAttachmentPicker
                      disabled={Boolean(busy) || running}
                      supportsAttachments={controlSandbox?.kind === 'docker' || controlSandbox?.kind === 'hermes'}
                      onFiles={(files) => {
                        const next = [...attachments, ...files];
                        if (next.length > 5) setError(tAgents('attachmentLimitReached', { count: 5 }));
                        setAttachments(next.slice(0, 5));
                      }}
                    />
                    <McpPromptPickerButton
                      apiPath={controlAgent ? `/api/v1/agents/${controlAgent.id}/prompts` : undefined}
                      disabled={!controlAgent?.ready || Boolean(busy) || running}
                      onError={setError}
                      onInsert={(text) => {
                        setDraft((current) => current ? `${text}\n${current}` : text);
                        window.requestAnimationFrame(() => composerInputRef.current?.focus());
                      }}
                    />
                    {controlAgent?.runtimeKind === 'hermes' ? (
                      <ReasoningEffortControl
                        value={reasoningEffort}
                        disabled={Boolean(busy) || running}
                        onChange={setReasoningEffort}
                      />
                    ) : null}
                    <span className="flex min-w-0 items-center gap-1.5 truncate px-1 text-[11px] text-muted-foreground">
                      <TerminalSquare className="size-3.5 shrink-0" />
                      {selected
                        ? `${runtimeLabel(selected.runtimeKind)} · ${t('steps', { current: selected.stepCount, max: selected.maxSteps })}`
                        : runtimeLabel(agent?.runtimeKind)}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <ConversationContextUsage busy={running} usage={contextUsage} />
                    {running ? (
                      <button type="button" disabled={!selected || busy === 'cancel'} onClick={() => void postAction('cancel')} aria-label={t('cancel')} title={t('cancel')} className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-destructive hover:bg-muted disabled:opacity-50">
                        {busy === 'cancel' ? <Loader2 className="size-[18px] animate-spin" /> : <CirclePause className="size-5" />}
                      </button>
                    ) : (
                      <button type="submit" disabled={!draft.trim() || !canSend || Boolean(busy)} aria-label={t('sendInput')} title={t('sendInput')} className="mr-0.5 mt-px flex size-[30px] shrink-0 items-center justify-center text-brand transition-all duration-200 disabled:cursor-not-allowed disabled:text-muted-foreground/50">
                        {busy === 'create' || busy === 'input' ? <Loader2 className="size-[18px] animate-spin" /> : <Send className="size-[22px]" />}
                      </button>
                    )}
                  </div>
                </div>
              </form>
            )}
            {!selected && agent && !agent.ready ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('configureAgent')}</p> : null}
            {!selected && agent?.ready && !sandboxOptions.length ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('attachSandbox')}</p> : null}
            {!selected && activeSandbox && !activeSandbox.running && agent?.runtimeKind !== 'hermes' ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('stopped')}</p> : null}
          </div>
        </div>
      </main>

      {workspacePanelOpen ? (
        <aside className="hidden min-h-0 overflow-hidden bg-background xl:block">
          {desktopPanel === 'context' ? (
            <WorkContextUsagePanel busy={running} usage={contextUsage} />
          ) : controlSandbox ? (
            <SandboxConsole
              compact
              filesOnly={desktopPanel === 'files'}
              terminalOnly={desktopPanel === 'terminal'}
              deploymentId={controlSandbox.deploymentId}
              running={controlSandbox.running}
              initialPath={activeWorkingDirectory}
              initialEntries={[]}
              terminalLabel={controlSandbox.name}
              terminalSubtitle={t('sandboxSubtitle')}
              workspaceRoot={controlWorkspaceRoot}
              rpcApiBase={workspaceRpcApiBase}
              terminalApiBase={workspaceTerminalApiBase}
            />
          ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Boxes className="mr-2 size-4" />{t('noSandbox')}</div>}
        </aside>
      ) : null}

      {mobilePanel ? (
        <div role="dialog" aria-modal="true" aria-label={mobilePanel === 'context' ? tAgents('contextUsage') : mobilePanel === 'files' ? tSandboxes('files') : tSandboxes('terminal')} className="fixed inset-0 z-50 flex flex-col bg-background xl:hidden">
          <header className="flex h-12 shrink-0 items-center justify-between px-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {mobilePanel === 'context' ? <Activity className="size-4" /> : mobilePanel === 'files' ? <Folder className="size-4" /> : <TerminalSquare className="size-4" />}
              {mobilePanel === 'context' ? tAgents('contextUsage') : mobilePanel === 'files' ? tSandboxes('files') : tSandboxes('terminal')}
            </span>
            <button type="button" onClick={() => setMobilePanel(null)} aria-label={mobilePanel === 'context' ? tAgents('close') : t('closeWorkspace')} className="ui-button-ghost ui-icon-button"><X className="size-4" /></button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            {mobilePanel === 'context' ? (
              <WorkContextUsagePanel busy={running} usage={contextUsage} />
            ) : controlSandbox ? (
              <SandboxConsole
                compact
                filesOnly={mobilePanel === 'files'}
                terminalOnly={mobilePanel === 'terminal'}
                deploymentId={controlSandbox.deploymentId}
                running={controlSandbox.running}
                initialPath={activeWorkingDirectory}
                initialEntries={[]}
                terminalLabel={controlSandbox.name}
                terminalSubtitle={t('sandboxSubtitle')}
                workspaceRoot={controlWorkspaceRoot}
                rpcApiBase={workspaceRpcApiBase}
                terminalApiBase={workspaceTerminalApiBase}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Boxes className="mr-2 size-4" />
                {t('noSandbox')}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <Dialog open={Boolean(deleteAgentTarget)} onOpenChange={(open) => { if (!open) setDeleteAgentTarget(null); }}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent className="!max-w-md">
            <DialogTitle>{tAgents('deleteAgent')}</DialogTitle>
            <DialogDescription>{tAgents('deleteThisAgentAndAllItsConversations')}</DialogDescription>
            <form action={deleteAgentAction} className="flex justify-end gap-2">
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={deleteAgentTarget?.id ?? ''} />
              <input type="hidden" name="returnTo" value={`/app/${slug}/work`} />
              <DialogClose asChild>
                <button type="button" className="ui-button-secondary h-9 px-3">{tAgents('cancel')}</button>
              </DialogClose>
              <SubmitButton pendingLabel={tAgents('deleting')} className="h-9 bg-destructive px-3 text-destructive-foreground hover:bg-destructive/90">
                {tAgents('confirmDelete')}
              </SubmitButton>
            </form>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
