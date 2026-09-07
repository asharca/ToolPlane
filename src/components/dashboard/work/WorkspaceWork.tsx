'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type UIEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ContextMenu, Popover } from 'radix-ui';
import { SidebarActionRail } from '@asharca/ui';
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CirclePause,
  Clock3,
  Minimize2,
  Cpu,
  FileText,
  FileOutput,
  Folder,
  FolderPlus,
  GripVertical,
  Loader2,
  ListFilter,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Radio,
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
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import { ReasoningEffortControl } from '@/components/dashboard/agents/ReasoningEffortControl';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import { ConversationContextUsage } from '@/components/dashboard/ConversationComposer';
import { WorkComposer } from './WorkComposer';
import type { ComposerReference } from '@/lib/work/composer-types';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { SidebarEntityActionsMenu } from '@/components/dashboard/SidebarEntityActionsMenu';
import { SidebarGroupDialog } from '@/components/dashboard/SidebarGroupDialog';
import {
  AssistantMarkdown,
  AssistantReply,
  assistantMessageActionClassName,
} from '@/components/dashboard/ConversationMessage';
import { callSandboxTool, SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';
import { resolveContextUsage, type ContextUsageSnapshot } from '@/lib/context-usage';
import { deleteAgentAction, pinAgentAction } from '@/lib/agents/actions';
import { normalizeReasoningEffort, type ReasoningEffort } from '@/lib/agents/constants';
import { displayMessagingUserText, type ParsedMessagingSession } from '@/lib/agents/messaging';
import { activeConversationMessages, isConversationControl, messageCompaction } from '@/lib/agents/conversation-context';
import { COMMAND_RESULT_PART, parseRuntimeCommand, sessionRuntimeCommands } from '@/lib/agents/runtime-commands';
import type { executeRuntimeCommand } from '@/lib/agents/runtime-command-service';
import { startSandboxAction } from '@/lib/sandboxes/actions';
import {
  usePersistentBoolean,
  usePersistentBooleanRecord,
} from '@/lib/use-persistent-boolean';
import {
  workAgentGroupPreferencesCookieName,
  workAgentGroupsCookieName,
  workSidebarCookieName,
} from '@/lib/sidebar-preferences';
import {
  createSidebarGroupId,
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  getSidebarDropEdge,
  reorderSidebarItems,
  sidebarDropIndicatorClassName,
  sortSidebarItems,
  type SidebarDropEdge,
  type SidebarGroupPreferences,
} from '@/lib/sidebar-groups';
import { usePersistentSidebarGroups } from '@/lib/use-persistent-sidebar-groups';
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
  pinned: boolean;
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
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  runtimeKind?: string;
  data?: unknown;
  reference?: Omit<ComposerReference, 'text'>;
};

type WorkActivity = {
  id: string;
  type: 'runtime' | 'reasoning' | 'tool';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
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
};

type WorkMessage = { id: string; role: string; createdAt?: string; parts: WorkPart[] };
type ConversationSummary = { id: string; agentId: string; title?: string | null; source: ParsedMessagingSession | null };
type ConversationDetail = ConversationSummary & {
  readOnly: boolean;
  messages: WorkMessage[];
  reasoningEffort?: ReasoningEffort | null;
  hermesProfile?: string | null;
  hermesProvider?: string | null;
  hermesModel?: string | null;
};

type WorkSidebarAgent = {
  agent: WorkAgent;
  sessions: WorkItem[];
  channels: Array<ConversationSummary & { label: string }>;
};

type WorkSidebarEntry =
  | { kind: 'group'; id: string; name: string; editable: boolean; count: number }
  | { kind: 'agent'; groupId: string | null; item: WorkSidebarAgent };

type WorkSidebarDragItem =
  | { kind: 'agent'; id: string }
  | { kind: 'session' | 'conversation'; id: string; agentId: string };

type WorkTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  approvalWaitMs?: number;
  runtimeKind?: string;
  modelName?: string;
};

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
  titlePending?: boolean;
  task: string | null;
  acceptanceCriteria: string | null;
  runtimeKind: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
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
  sandbox: { id: string; name: string; kind: string; deploymentId: string; status?: string; running: boolean } | null;
  messages: WorkMessage[];
  approvals: WorkApproval[];
};

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'cancelling']);
const STOPPABLE_STATUSES = new Set(['queued', 'running', 'waiting_approval']);
const MESSAGEABLE_STATUSES = new Set(['idle', 'waiting_user', 'completed', 'failed']);
const ARCHIVABLE_STATUSES = new Set(['idle', 'completed', 'failed', 'cancelled']);
const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];
const EMPTY_EXPANDED_AGENTS: Record<string, boolean> = {};
const UNGROUPED_SIDEBAR_GROUP_ID = '__ungrouped__';

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

function formatWorkDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function parseWorkTiming(value: unknown): WorkTiming | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const startedAt = typeof data.startedAt === 'number' && Number.isFinite(data.startedAt) && data.startedAt > 0
    ? data.startedAt
    : null;
  if (startedAt === null) return null;
  const completedAt = typeof data.completedAt === 'number' && Number.isFinite(data.completedAt) && data.completedAt >= startedAt
    ? data.completedAt
    : undefined;
  const durationMs = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0
    ? data.durationMs
    : undefined;
  const approvalWaitMs = typeof data.approvalWaitMs === 'number' && Number.isFinite(data.approvalWaitMs) && data.approvalWaitMs >= 0
    ? data.approvalWaitMs
    : undefined;
  return {
    startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(approvalWaitMs === undefined ? {} : { approvalWaitMs }),
    ...(typeof data.runtimeKind === 'string' && data.runtimeKind ? { runtimeKind: data.runtimeKind } : {}),
    ...(typeof data.modelName === 'string' && data.modelName ? { modelName: data.modelName } : {}),
  };
}

function messageWorkTiming(message: WorkMessage): WorkTiming | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type !== 'data-work-timing') continue;
    const timing = parseWorkTiming(part.data);
    if (timing) return timing;
  }
  return null;
}

function workTimingDuration(timing: WorkTiming | null, now?: number): number | undefined {
  if (!timing) return undefined;
  const finishedAt = timing.completedAt ?? now;
  const total = timing.durationMs
    ?? (finishedAt === undefined ? undefined : Math.max(0, finishedAt - timing.startedAt));
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
    if (!live || startedAt === undefined || completedAt !== undefined) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [completedAt, live, startedAt]);
  const duration = workTimingDuration(timing, live ? now ?? undefined : undefined);
  const label = formatWorkDuration(duration);
  return label ? (
    <>
      {separator ? <span aria-hidden="true" className="shrink-0 text-muted-foreground">·</span> : null}
      <span data-ui={dataUi} className={className} title={`${Math.round(duration ?? 0)} ms`}>{label}</span>
    </>
  ) : null;
}

function workToolLabel(part: Pick<WorkPart, 'deploymentName' | 'originalToolName' | 'toolName'>): string {
  if (part.deploymentName && part.originalToolName) return `${part.deploymentName} · ${part.originalToolName}`;
  return part.originalToolName ?? part.toolName ?? 'Tool';
}

function formatWorkMessageTime(value: string | undefined): { label: string; title: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    label: date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    title: date.toLocaleString(),
  };
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

function CompactionNote({ message }: { message: WorkMessage }) {
  const t = useTranslations('console.conversationOperations');
  const data = messageCompaction(message);
  if (!data) return null;
  return <details data-message-id={message.id} data-ui="conversation.compaction" className="my-3 min-w-0 border-y border-border py-2 text-xs text-muted-foreground">
    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
      <Minimize2 className="size-3.5 shrink-0" />
      <span>{t('compacted')}</span>
      <span>{t('tokens', { before: data.beforeTokens, after: data.afterTokens })}</span>
    </summary>
    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">{data.summary}</pre>
  </details>;
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
  sessionStartedAt?: string | null;
  sessionCompletedAt?: string | null;
  streaming: boolean;
}) {
  const t = useTranslations('console.work');
  const agentsT = useTranslations('console.agents');
  const common = useTranslations('common');
  const copyButtonClassName = `${assistantMessageActionClassName} opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/message:opacity-100 group-hover/message:opacity-100`;
  const streamPersisted = streamStartedAt !== undefined && messages.some((message) => (
    (message.role === 'assistant' || isConversationControl(message)) && messageWorkTiming(message)?.startedAt === streamStartedAt
  ));
  const transcript = streaming && !streamPersisted
      ? [...messages, {
        id: 'work-stream',
        role: 'assistant',
        ...(streamStartedAt ? { createdAt: new Date(streamStartedAt).toISOString() } : {}),
        parts: [
          ...streamActivities.map((activity): WorkPart => {
            if (activity.type === 'tool') {
              return {
                type: 'work-tool',
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
          ...(streamStartedAt ? [{
            type: 'data-work-timing',
            data: {
              startedAt: streamStartedAt,
              ...(streamRuntimeKind ? { runtimeKind: streamRuntimeKind } : {}),
              ...(streamModelName ? { modelName: streamModelName } : {}),
            },
          }] : []),
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
        if (messageCompaction(message)) return <CompactionNote key={message.id} message={message} />;
        const isStreamingMessage = message.id === 'work-stream';
        const messageTime = formatWorkMessageTime(message.createdAt);
        const persistedTiming = messageWorkTiming(message);
        const sessionStart = Date.parse(sessionStartedAt ?? '');
        const sessionEnd = Date.parse(sessionCompletedAt ?? '');
        const fallbackTiming: WorkTiming | null = !persistedTiming
          && !isStreamingMessage
          && message.role === 'assistant'
          && messages.filter((item) => item.role === 'assistant').length === 1
          && Number.isFinite(sessionStart)
          && Number.isFinite(sessionEnd)
          && sessionEnd >= sessionStart
          ? { startedAt: sessionStart, completedAt: sessionEnd, durationMs: sessionEnd - sessionStart }
          : null;
        const messageTiming = persistedTiming ?? fallbackTiming;
        const messageModelName = messageTiming?.modelName ?? resolveContextUsage([message])?.modelName ?? fallbackModelName;
        const commandResult = message.parts.find((part) => part.type === COMMAND_RESULT_PART)?.data as { text?: string } | undefined;
        const rawText = message.parts
          .filter((part) => part.type === 'text' && typeof part.text === 'string' && !part.reference)
          .map((part) => part.text)
          .join('\n') || (typeof commandResult?.text === 'string' ? commandResult.text : '');
        const text = message.role === 'user' ? displayMessagingUserText(rawText) : isStreamingMessage ? rawText : rawText.trim();
        const processParts = message.parts.filter((part) => (
          part.type === 'reasoning'
          || part.type === 'work-tool'
          || (part.type === 'work-runtime' && (part.status === 'failed' || part.status === 'cancelled'))
        ));
        const visibleProcessParts = processParts.filter((part) => (
          part.type !== 'work-runtime' || !isStreamingMessage || part.status !== 'running'
        ));
        const processFailed = visibleProcessParts.some((part) => part.isError || part.status === 'failed');
        const processCancelled = visibleProcessParts.some((part) => part.status === 'cancelled');
        const fileParts = message.parts.filter((part) => (
          part.type === 'file'
          && typeof part.url === 'string'
          && (part.url.startsWith('/api/v1/attachments/') || /^data:[\w.+-]+\/[\w.+-]+;base64,/.test(part.url))
        ));
        const attachmentLinks = fileParts.length ? (
          <div className="flex max-w-full flex-wrap gap-1.5">
            {fileParts.map((part, index) => (
              <a
                key={`${part.url}-${index}`}
                href={part.url}
                download={part.filename ?? agentsT('attachment')}
                className="inline-flex max-w-56 flex-wrap items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1.5 text-xs text-foreground hover:bg-muted"
              >
                {part.mediaType?.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={part.url} alt={part.filename ?? agentsT('attachment')} className="max-h-48 w-full object-contain" />
                ) : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate">{part.filename ?? agentsT('attachment')}</span>
              </a>
            ))}
          </div>
        ) : null;
        const processTimeline = (live: boolean) => visibleProcessParts.map((part, index) => {
          if (part.type === 'work-runtime') {
            return (
              <div key={`${message.id}-runtime-${index}`} className="flex min-h-7 items-center gap-2 rounded-md px-1 text-muted-foreground">
                {part.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : part.status === 'failed' ? <CircleAlert className="size-3.5 text-red-600" /> : part.status === 'cancelled' ? <CirclePause className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                <TerminalSquare className="size-3.5" />
                <span>{part.status === 'running' ? t('runtimeWorking', { runtime: runtimeLabel(part.runtimeKind) }) : part.status === 'cancelled' ? t('runtimeCancelled', { runtime: runtimeLabel(part.runtimeKind) }) : runtimeLabel(part.runtimeKind)}</span>
              </div>
            );
          }
          if (part.type === 'reasoning') {
            const running = part.status === 'running';
            return (
              <details key={`${message.id}-reasoning-${index}`} open={live && running} className="group/reasoning rounded-md">
                <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
                  {running ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                  <Activity className="size-3.5" />
                  <span>{running ? t('thinking') : t('thought')}</span>
                  {part.text ? <ChevronRight className="ml-auto size-3.5 transition-transform group-open/reasoning:rotate-90" /> : null}
                </summary>
                {part.text ? <pre className="ml-5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">{part.text}</pre> : null}
              </details>
            );
          }
          if (part.type !== 'work-tool') return null;
          const running = part.status === 'running';
          const failed = part.isError || part.status === 'failed';
          const cancelled = part.status === 'cancelled';
          const toolLabel = workToolLabel(part);
          const duration = formatWorkDuration(part.durationMs);
          return (
            <details key={part.toolCallId ?? `${message.id}-${index}`} open={live ? running || failed : failed} className={cx('group/tool rounded-md', failed && 'bg-red-500/5')}>
              <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 marker:content-none hover:bg-muted/50">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
                <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{toolLabel}</span>
                {!running && duration ? <span className="shrink-0 text-[10px] text-muted-foreground" title={`${part.durationMs} ms`}>{duration}</span> : null}
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
        });

        if (message.role === 'user') {
          return (
            <article key={message.id} data-message-id={message.id} className="group/message flex flex-col items-end rounded-[10px] pt-2.5">
              <div className="flex max-w-full items-start justify-end gap-2.5">
                <div className="min-w-0 max-w-[calc(100%_-_2.5rem)] break-words rounded-[10px] bg-muted px-4 py-2.5 text-sm leading-[1.65] text-foreground">
                  {attachmentLinks}
                  {message.parts.filter((part) => part.reference).map((part, index) => <details key={index} className="my-1 max-w-full text-xs">
                    <summary className="cursor-pointer break-words text-muted-foreground">@{part.reference!.label}</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{part.text}</pre>
                  </details>)}
                  {text ? <span className="block whitespace-pre-wrap">{text}</span> : null}
                </div>
                <div aria-label={agentsT('user')} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRound className="size-4" />
                </div>
              </div>
              {text ? (
                <div className="mr-10 flex min-h-[26px] items-center justify-end gap-2">
                  {messageTime ? (
                    <time
                      data-ui="work-message-time"
                      dateTime={message.createdAt}
                      title={messageTime.title}
                      className="text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
                    >
                      {messageTime.label}
                    </time>
                  ) : null}
                  <CopyButton text={text} label={common('copy')} iconOnly className={copyButtonClassName} />
                </div>
              ) : null}
            </article>
          );
        }

        return (
          <AssistantReply
            key={message.id}
            data-message-id={message.id}
            agentName={agentName}
            headerMeta={(
              <>
                {messageModelName ? <span data-ui="assistant-reply-model" title={messageModelName} className="min-w-0 truncate text-xs font-normal text-muted-foreground">{messageModelName}</span> : null}
                {messageTime ? (
                  <time
                    data-ui="work-message-time"
                    dateTime={message.createdAt}
                    title={messageTime.title}
                    className="shrink-0 text-[10px] font-normal text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
                  >
                    {messageTime.label}
                  </time>
                ) : null}
                <WorkElapsed
                  timing={messageTiming}
                  live={isStreamingMessage}
                  dataUi="work-message-duration"
                  className="shrink-0 text-[10px] font-normal text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
                />
              </>
            )}
            streaming={isStreamingMessage}
            actions={!isStreamingMessage && text ? (
              <CopyButton text={text} label={common('copy')} iconOnly className={copyButtonClassName} />
            ) : undefined}
          >
            <div className="min-w-0">
              {attachmentLinks}
              {isStreamingMessage || visibleProcessParts.length ? (
                isStreamingMessage ? (
                  <div data-ui="work-process" className="my-1.5 space-y-1 text-xs">
                    <div className="flex min-h-7 items-center gap-1.5 px-1 text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      <span className="font-medium text-foreground">{t('processing')}</span>
                      <WorkElapsed timing={messageTiming} live separator dataUi="work-process-duration" className="text-[10px] text-muted-foreground" />
                    </div>
                    {visibleProcessParts.length ? <div className="space-y-1">{processTimeline(true)}</div> : null}
                  </div>
                ) : (
                  <details data-ui="work-process" open={processFailed || processCancelled} className="group/process my-1.5 text-xs">
                    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground marker:content-none hover:bg-muted/50">
                      <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/process:rotate-90" />
                      {processFailed ? <CircleAlert className="size-3.5 shrink-0 text-red-600" /> : processCancelled ? <CirclePause className="size-3.5 shrink-0" /> : <CheckCircle2 className="size-3.5 shrink-0" />}
                      <span className="shrink-0 font-medium text-foreground">{processFailed ? t('processFailed') : processCancelled ? t('processCancelled') : t('processed')}</span>
                      <WorkElapsed timing={messageTiming} separator dataUi="work-process-duration" className="shrink-0 text-[10px] text-muted-foreground" />
                    </summary>
                    <div className="ml-5 py-1">
                      {processTimeline(false)}
                    </div>
                  </details>
                )
              ) : null}
              {text ? (
                <AssistantMarkdown text={text} streaming={isStreamingMessage} />
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
  sessions: WorkItem[];
  providers?: Array<ModelProviderOption & { format: string }>;
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
  const t = useTranslations('console.work');
  const tAgents = useTranslations('console.agents');
  const tChannels = useTranslations('console.agentMessaging');
  const operationsT = useTranslations('console.conversationOperations');
  const tSandboxes = useTranslations('console.sandboxes');
  const common = useTranslations('common');
  const router = useRouter();
  const initialSelected = selectedSession ?? sessions.find((item) => item.id === selectedWorkSessionId) ?? null;
  const workAgents = agents.filter((item) => item.supportsWork);
  const [items, setItems] = useState(sessions);
  const [liveSelected, setLiveSelected] = useState<WorkItem | null>(null);
  const selectionKey = selectedConversation?.id ?? selectedWorkSessionId;
  const [draftSelectionKey, setDraftSelectionKey] = useState<string | null>(null);
  if (draftSelectionKey && draftSelectionKey !== selectionKey) setDraftSelectionKey(null);
  const creatingMode = !selectionKey || draftSelectionKey === selectionKey;
  const conversation = creatingMode ? null : selectedConversation;
  const [conversationBusy, setConversationBusy] = useState(false);
  const [mobilePane, setMobilePane] = useState<'sessions' | 'work'>('work');
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:work-sidebar:${workspaceId}`,
    initialSidebarOpen,
    workSidebarCookieName(workspaceId),
  );
  const [sessionQuery, setSessionQuery] = useState('');
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
  const selected = creatingMode || conversation ? null : liveSelected?.id === selectedWorkSessionId ? liveSelected : initialSelected;
  const initialAgentId = selectedConversation?.agentId ?? initialSelected?.agentId
    ?? workAgents.find((item) => item.id === requestedAgentId)?.id
    ?? workAgents[0]?.id
    ?? '';
  const [agentId, setAgentId] = useState(initialAgentId);
  const reasoningScope = conversation?.id ?? selected?.id ?? `agent:${agentId}`;
  const [reasoningSelection, setReasoningSelection] = useState<{
    scope: string;
    value: ReasoningEffort;
  }>({
    scope: initialSelected?.id ?? `agent:${initialAgentId}`,
    value: normalizeReasoningEffort(initialSelected?.reasoningEffort) ?? 'default',
  });
  const reasoningEffort = reasoningSelection.scope === reasoningScope
    ? reasoningSelection.value
    : normalizeReasoningEffort(conversation?.reasoningEffort ?? selected?.reasoningEffort) ?? 'default';
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
  const [groupEditor, setGroupEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [draggingSidebarItem, setDraggingSidebarItem] = useState<WorkSidebarDragItem | null>(null);
  const draggingSidebarItemRef = useRef<WorkSidebarDragItem | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<{ kind: WorkSidebarDragItem['kind']; id: string; edge: SidebarDropEdge } | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [referenceSelection, setReferenceSelection] = useState<{ scope: string; items: ComposerReference[] }>({ scope: '', items: [] });
  const [composerPending, setComposerPending] = useState(false);
  const commandsT = useTranslations('console.runtimeCommands');
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
    startedAt?: number;
    runtimeKind?: string;
    modelName?: string;
  }>({ workSessionId: '', text: '', activities: [] });
  const agent = useMemo(() => agents.find((item) => item.id === agentId) ?? null, [agents, agentId]);
  const selectedAgent = selected || conversation ? agents.find((item) => item.id === (conversation?.agentId ?? selected?.agentId)) ?? null : null;
  const sandboxOptions = agent?.sandboxes ?? [];
  const activeSandboxId = sandboxId || sandboxOptions.find((item) => item.isDefault)?.id || sandboxOptions[0]?.id || '';
  const activeSandbox = sandboxOptions.find((item) => item.id === activeSandboxId) ?? null;
  const controlAgent = selectedAgent ?? agent;
  const controlSandbox = conversation
    ? selectedAgent?.sandboxes.find((sandbox) => sandbox.isDefault) ?? selectedAgent?.sandboxes[0] ?? null
    : selected?.sandbox
    ? { ...selected.sandbox, isDefault: false }
    : activeSandbox;
  const controlHermesSelection = controlAgent?.runtimeKind === 'hermes'
    ? conversation
      ? { profile: conversation.hermesProfile ?? 'default', provider: conversation.hermesProvider ?? null, model: conversation.hermesModel ?? null }
      : selected
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
  const composerScope = `${controlAgent?.id}:${controlSandbox?.id}:${selected?.id ?? conversation?.id ?? 'new'}`;
  const references = referenceSelection.scope === composerScope ? referenceSelection.items : [];
  const commands = sessionRuntimeCommands(selected?.runtimeKind ?? controlAgent?.runtimeKind ?? '', selected?.messages ?? []);
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
  const activeWorkingDirectory = conversation ? '.' : selected?.workingDirectory ?? workingDirectory;
  const workReturnTo = conversation
    ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversation.agentId)}&c=${encodeURIComponent(conversation.id)}`
    : selected ? workHref(slug, selected.id) : `/app/${encodeURIComponent(slug)}/work`;
  const pendingApprovals = selected?.approvals.filter((approval) => approval.status === 'pending') ?? [];
  const selectedStatus = selected?.status;
  const visibleError = error ?? selected?.error;

  useEffect(() => {
    if (selected || conversation || activeSandbox?.status !== 'provisioning') return;
    const interval = window.setInterval(() => router.refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [activeSandbox?.status, agent?.runtimeKind, router, selected, conversation]);

  useEffect(() => {
    if ((!hasChannels && !conversation?.readOnly) || conversationBusy) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasChannels, conversation?.readOnly, conversationBusy, router]);

  const streamText = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.text : '';
  const streamActivities = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.activities : EMPTY_WORK_ACTIVITIES;
  const streamStartedAt = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.startedAt : undefined;
  const streamRuntimeKind = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.runtimeKind : undefined;
  const streamModelName = streamOutput.workSessionId === selectedWorkSessionId ? streamOutput.modelName : undefined;
  const contextUsage = useMemo(() => resolveContextUsage(activeConversationMessages(conversation?.messages ?? selected?.messages ?? []).map((message) => ({ parts: Array.isArray(message.parts) ? message.parts : [] })), {
    maxTokens: controlAgent?.contextWindow,
    modelName: controlAgent?.model,
    context: streamText,
    estimated: controlAgent?.contextWindowEstimated,
  }), [controlAgent?.contextWindow, controlAgent?.contextWindowEstimated, controlAgent?.model, selected?.messages, conversation?.messages, streamText]);
  const workspacePanelOpen = Boolean(desktopPanel && (desktopPanel === 'context' ? selected || conversation : controlSandbox));

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
  const visibleAgents = useMemo<WorkSidebarAgent[]>(() => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    return sortSidebarItems(agents, groupPreferences.entityOrder).flatMap((item) => {
      const order = groupPreferences.conversationOrder?.[item.id];
      const agentSessions = sortSidebarItems(items.filter((session) => session.agentId === item.id), order);
      const agentChannels = sortSidebarItems(conversations.filter((conversation) => conversation.agentId === item.id), order).map((conversation) => {
        if (!conversation.source) return { ...conversation, label: conversation.title || tAgents('newChat') };
        const { platform, chatId } = conversation.source;
        const platformLabel = tChannels.has(`platforms.${platform}`) ? tChannels(`platforms.${platform}`) : platform;
        return { ...conversation, label: `${platformLabel} · ${chatId}` };
      });
      if (!query) return [{ agent: item, sessions: agentSessions, channels: agentChannels }];
      const agentMatches = item.name.toLocaleLowerCase().includes(query);
      const matchingSessions = agentSessions.filter((session) => [
        session.title,
        session.task,
        session.sandbox?.name,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
      const matchingChannels = agentChannels.filter((conversation) => [
        conversation.label, conversation.source?.platform, conversation.source?.contextId,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
      return agentMatches || matchingSessions.length || matchingChannels.length
        ? [{ agent: item, sessions: agentMatches ? agentSessions : matchingSessions, channels: agentMatches ? agentChannels : matchingChannels }]
        : [];
    });
  }, [agents, items, conversations, groupPreferences.entityOrder, groupPreferences.conversationOrder, sessionQuery, tChannels, tAgents]);
  const activeAgentId = conversation?.agentId ?? selected?.agentId ?? agentId;
  const groupedAgents = useMemo(() => {
    const agentsByGroup = new Map<string, WorkSidebarAgent[]>(
      groupPreferences.groups.map((group) => [group.id, []]),
    );
    const ungrouped: WorkSidebarAgent[] = [];
    for (const item of visibleAgents) {
      const group = agentsByGroup.get(groupPreferences.assignments[item.agent.id] ?? '');
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
  const sidebarAgentEntries = useMemo<WorkSidebarEntry[]>(() => {
    if (!groupPreferences.groups.length) {
      return visibleAgents.map((item) => ({ kind: 'agent', groupId: null, item }));
    }
    const entries: WorkSidebarEntry[] = [];
    for (const { group, agents: groupAgents } of groupedAgents.groups) {
      if (!sessionQuery.trim() || groupAgents.length) {
        entries.push({ kind: 'group', id: group.id, name: group.name, editable: true, count: groupAgents.length });
        entries.push(...groupAgents.map((item) => ({ kind: 'agent' as const, groupId: group.id, item })));
      }
    }
    if (!sessionQuery || groupedAgents.ungrouped.length) {
      entries.push({
        kind: 'group',
        id: UNGROUPED_SIDEBAR_GROUP_ID,
        name: t('ungrouped'),
        editable: false,
        count: groupedAgents.ungrouped.length,
      });
      entries.push(...groupedAgents.ungrouped.map((item) => ({ kind: 'agent' as const, groupId: UNGROUPED_SIDEBAR_GROUP_ID, item })));
    }
    return entries;
  }, [groupPreferences.groups.length, groupedAgents, sessionQuery, t, visibleAgents]);

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
    if (!selected?.titlePending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSelected();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [refreshSelected, selected?.titlePending]);

  useEffect(() => {
    if (!selected?.id && !conversation?.id) return;
    scrollTranscriptToBottom();
  }, [scrollTranscriptToBottom, selected?.id, conversation?.id]);

  useEffect(() => {
    if ((!selected?.id && !conversation?.id) || !followingTranscriptRef.current) return;
    scrollTranscriptToBottom();
  }, [scrollTranscriptToBottom, selected?.artifacts, selected?.id, selected?.messages, conversation?.id, conversation?.messages, selectedActive, streamActivities, streamText]);

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
      const next = payload<{
        text?: string;
        activities?: WorkActivity[];
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
      }>(event);
      if (!next) return;
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: next.text ?? '',
        activities: Array.isArray(next.activities) ? next.activities : [],
        ...(typeof next.startedAt === 'number' ? { startedAt: next.startedAt } : {}),
        ...(typeof next.runtimeKind === 'string' ? { runtimeKind: next.runtimeKind } : {}),
        ...(typeof next.modelName === 'string' ? { modelName: next.modelName } : {}),
      });
      if (next.done) {
        void finish();
        return;
      }
    });
    source.addEventListener('start', (event) => {
      const next = payload<{ startedAt?: number; runtimeKind?: string; modelName?: string }>(event);
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: '',
        activities: [],
        ...(typeof next?.startedAt === 'number' ? { startedAt: next.startedAt } : {}),
        ...(typeof next?.runtimeKind === 'string' ? { runtimeKind: next.runtimeKind } : {}),
        ...(typeof next?.modelName === 'string' ? { modelName: next.modelName } : {}),
      });
      void refreshSelected();
    });
    source.addEventListener('delta', (event) => {
      const next = payload<{ delta?: string }>(event);
      if (!next?.delta) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text: (current.workSessionId === selectedWorkSessionId ? current.text : '') + next.delta,
        activities: current.workSessionId === selectedWorkSessionId ? current.activities : [],
        ...(current.workSessionId === selectedWorkSessionId && current.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.runtimeKind ? { runtimeKind: current.runtimeKind } : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName ? { modelName: current.modelName } : {}),
      }));
    });
    source.addEventListener('activity', (event) => {
      const next = payload<{ activities?: WorkActivity[] }>(event);
      if (!Array.isArray(next?.activities)) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text: current.workSessionId === selectedWorkSessionId ? current.text : '',
        activities: next.activities ?? [],
        ...(current.workSessionId === selectedWorkSessionId && current.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.runtimeKind ? { runtimeKind: current.runtimeKind } : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName ? { modelName: current.modelName } : {}),
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

  function openAgentGroup(nextAgentId: string) {
    setGroupPreferences((current) => {
      const groupId = current.assignments[nextAgentId];
      if (!groupId || !current.collapsed[groupId]) return current;
      return { ...current, collapsed: { ...current.collapsed, [groupId]: false } };
    });
  }

  function startNewWork(nextAgentId = agentId) {
    setExpandedAgents((current) => ({ ...current, [nextAgentId]: true }));
    openAgentGroup(nextAgentId);
    setAgentId(nextAgentId);
    setSandboxId('');
    setDraftSelectionKey(selectionKey);
    setMobilePane('work');
    setDraft('');
    setAttachments([]);
    setReferenceSelection({ scope: '', items: [] });
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
          ...(references.length ? { references } : {}),
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
    if (conversation || busy || running || composerPending) return;
    const input = draft.trim();
    if (!input) return;
    const command = parseRuntimeCommand(input);
    if (command && command.name !== 'new') {
      if (!commands.some((item) => item.name === command.name)) { setError(commandsT('unsupportedCommand')); return; }
      if (attachments.length || references.length) { setError(commandsT('noAttachments')); return; }
      if (input.length > 2000) { setError(commandsT('invalidCommand')); return; }
      {
        if (!selected) {
          if (canSend) return createWork();
          setError(commandsT('needsConversation')); return;
        }
        setBusy('command'); setError(null);
        try {
          const response = await fetch(`/api/v1/agents/${encodeURIComponent(selected.agentId)}/conversations/${encodeURIComponent(selected.conversationId)}/commands`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line: input }),
          });
          const result = await response.json() as Awaited<ReturnType<typeof executeRuntimeCommand>> & { error?: string };
          if (!response.ok) throw new Error(result.error && commandsT.has(result.error) ? commandsT(result.error) : result.error || commandsT('failed'));
          setDraft('');
          await refreshSelected();
        } catch (cause) { setError(cause instanceof Error ? cause.message : commandsT('failed')); }
        finally { setBusy(null); }
        return;
      }
    }
    if (/^\/new(?:\s|$)/i.test(input)) { setError(operationsT('channelCommandOnly')); return; }
    if (!canSend) return;
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
      ...(references.length ? { references } : {}),
      ...(selected.runtimeKind === 'hermes' ? { reasoningEffort } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    })) {
      setDraft('');
      setAttachments([]);
      setReferenceSelection({ scope: '', items: [] });
    } else {
      await discardUploaded(attachmentIds);
    }
  }

  async function decideApproval(approvalId: string, decision: 'allow' | 'deny') {
    await postAction(`approvals/${approvalId}`, { decision });
  }

  async function archiveWork(id: string) {
    const response = await fetch(`/api/v1/work-sessions/${id}`, { method: 'DELETE' });
    if (response.ok) window.location.assign(`/app/${encodeURIComponent(slug)}/work`);
  }

  async function toggleAgentPin(item: WorkAgent) {
    const formData = new FormData();
    formData.set('workspace', slug);
    formData.set('agentId', item.id);
    formData.set('pinned', String(!item.pinned));
    await pinAgentAction(formData);
    router.refresh();
  }

  function setAllAgentSections(collapsed: boolean) {
    setExpandedAgents(Object.fromEntries(agents.map((item) => [item.id, !collapsed])));
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
          groups: current.groups.map((group) => (
            group.id === groupEditor.id ? { ...group, name } : group
          )),
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
    if (!group || !window.confirm(t('deleteGroupConfirm', { name: group.name }))) return;
    setGroupPreferences((current) => {
      const assignments = Object.fromEntries(
        Object.entries(current.assignments).filter(([, assignedGroupId]) => assignedGroupId !== groupId),
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

  function assignAgentToGroup(agentId: string, groupId: string | null) {
    if (!agents.some((item) => item.id === agentId)) return;
    setGroupPreferences((current) => {
      const assignments = { ...current.assignments };
      if (groupId) assignments[agentId] = groupId;
      else delete assignments[agentId];
      return {
        ...current,
        assignments,
        collapsed: { ...current.collapsed, [groupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false },
      };
    });
  }

  function clearSidebarDrag() {
    draggingSidebarItemRef.current = null;
    setDraggingSidebarItem(null);
    setDropGroupId(null);
    setDropRow(null);
  }

  function startSidebarDrag(event: DragEvent<HTMLElement>, source: WorkSidebarDragItem) {
    event.stopPropagation();
    clearSidebarDrag();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(`application/x-toolplane-${source.kind}`, source.id);
    draggingSidebarItemRef.current = source;
    setDraggingSidebarItem(source);
  }

  function canReorderSidebarItem(source: WorkSidebarDragItem, target: WorkSidebarDragItem, preferences = groupPreferences) {
    if (source.kind !== target.kind || source.id === target.id) return false;
    if (source.kind === 'agent' && target.kind === 'agent') {
      const sourceAgent = agents.find((item) => item.id === source.id);
      const targetAgent = agents.find((item) => item.id === target.id);
      return Boolean(sourceAgent && targetAgent && (
        (preferences.assignments[source.id] ?? null) !== (preferences.assignments[target.id] ?? null)
        || sourceAgent.pinned === targetAgent.pinned
      ));
    }
    if (source.kind === 'agent' || target.kind === 'agent' || source.agentId !== target.agentId) return false;
    const section = source.kind === 'session' ? items : conversations;
    return section.some((item) => item.id === source.id && item.agentId === source.agentId)
      && section.some((item) => item.id === target.id && item.agentId === target.agentId);
  }

  function moveSidebarItem(source: WorkSidebarDragItem, target: WorkSidebarDragItem, edge: SidebarDropEdge) {
    setGroupPreferences((current) => {
      if (!canReorderSidebarItem(source, target, current)) return current;
      if (source.kind === 'agent' && target.kind === 'agent') {
        const targetGroupId = current.assignments[target.id];
        const assignments = { ...current.assignments };
        if (targetGroupId) assignments[source.id] = targetGroupId;
        else delete assignments[source.id];
        return {
          ...current,
          assignments,
          collapsed: { ...current.collapsed, [targetGroupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false },
          entityOrder: reorderSidebarItems(sortSidebarItems(agents, current.entityOrder), source.id, target.id, edge),
        };
      }
      if (source.kind === 'agent') return current;
      // Keep both complete sections in the saved order, including search-hidden rows.
      const agentItems = [...items, ...conversations].filter((item) => item.agentId === source.agentId);
      return {
        ...current,
        conversationOrder: {
          ...current.conversationOrder,
          [source.agentId]: reorderSidebarItems(
            sortSidebarItems(agentItems, current.conversationOrder?.[source.agentId]), source.id, target.id, edge,
          ),
        },
      };
    });
  }

  function sidebarRowDropProps(target: WorkSidebarDragItem) {
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        setDropGroupId(null);
        const source = draggingSidebarItemRef.current;
        if (!source || !canReorderSidebarItem(source, target)) {
          setDropRow(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropRow({ kind: target.kind, id: target.id, edge: getSidebarDropEdge(event.clientY, event.currentTarget.getBoundingClientRect()) });
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropRow(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        const source = draggingSidebarItemRef.current;
        if (source && canReorderSidebarItem(source, target)) {
          event.preventDefault();
          moveSidebarItem(source, target, getSidebarDropEdge(event.clientY, event.currentTarget.getBoundingClientRect()));
        }
        clearSidebarDrag();
      },
    };
  }

  function reorderSidebarWithKeyboard(event: KeyboardEvent<HTMLElement>, source: WorkSidebarDragItem) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    event.stopPropagation();
    let rows: WorkSidebarDragItem[];
    if (source.kind === 'agent') {
      rows = sidebarAgentEntries.flatMap((entry) => entry.kind === 'agent'
        && (groupPreferences.assignments[entry.item.agent.id] ?? null) === (groupPreferences.assignments[source.id] ?? null)
        && (!entry.groupId || sessionQuery.trim() || !groupPreferences.collapsed[entry.groupId])
        ? [{ kind: 'agent' as const, id: entry.item.agent.id }] : []);
    } else {
      const agent = visibleAgents.find((item) => item.agent.id === source.agentId);
      rows = (source.kind === 'session' ? agent?.sessions ?? [] : agent?.channels ?? [])
        .map((item) => ({ kind: source.kind, id: item.id, agentId: source.agentId }));
    }
    const index = rows.findIndex((item) => item.id === source.id);
    const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target && canReorderSidebarItem(source, target)) {
      moveSidebarItem(source, target, event.key === 'ArrowUp' ? 'before' : 'after');
    }
    clearSidebarDrag();
  }

  function renderAgentGroup(entry: Extract<WorkSidebarEntry, { kind: 'group' }>) {
    const expanded = Boolean(sessionQuery.trim()) || !groupPreferences.collapsed[entry.id];
    const targetGroupId = entry.editable ? entry.id : null;
    const label = expanded ? t('hideGroup', { name: entry.name }) : t('showGroup', { name: entry.name });
    return (
      <li key={entry.id} data-sidebar-group-id={entry.id} className="py-1">
        <div
          onDragOver={(event) => {
            event.stopPropagation();
            setDropRow(null);
            const source = draggingSidebarItemRef.current;
            const agentId = source?.kind === 'agent' ? source.id : null;
            const assignedGroupId = agentId ? groupPreferences.assignments[agentId] ?? null : null;
            if (!agentId || !agents.some((item) => item.id === agentId) || assignedGroupId === targetGroupId) {
              setDropGroupId(null);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropGroupId(entry.id);
          }}
          onDragLeave={(event) => {
            event.stopPropagation();
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropGroupId(null);
          }}
          onDrop={(event) => {
            event.stopPropagation();
            const source = draggingSidebarItemRef.current;
            if (source?.kind === 'agent') {
              event.preventDefault();
              assignAgentToGroup(source.id, targetGroupId);
            }
            clearSidebarDrag();
          }}
          className={cx(
            'group/sidebar-group flex h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground',
            dropGroupId === entry.id && 'bg-muted ring-1 ring-inset ring-brand/50',
          )}
        >
          <button
            type="button"
            aria-label={label}
            aria-expanded={expanded}
            title={label}
            onClick={() => setGroupPreferences((current) => ({
              ...current,
              collapsed: { ...current.collapsed, [entry.id]: !current.collapsed[entry.id] },
            }))}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
          >
            <Folder className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="text-[10px] text-muted-foreground">{entry.count}</span>
            <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
          {entry.editable ? (
            <>
              <button type="button" aria-label={t('renameGroup')} title={t('renameGroup')} onClick={() => setGroupEditor({ id: entry.id, name: entry.name })} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-background hover:text-foreground">
                <Pencil className="size-3.5" />
              </button>
              <button type="button" aria-label={t('deleteGroup')} title={t('deleteGroup')} onClick={() => deleteAgentGroup(entry.id)} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-background hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
            </>
          ) : null}
        </div>
      </li>
    );
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
  const localCommand = Boolean(parseRuntimeCommand(draft));

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
          <div className="flex h-8 items-center gap-1 px-1">
            <Link href={`/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`} aria-label={tAgents('addAgent')} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-[13px] text-foreground hover:bg-muted">
              <Plus className="size-3.5 shrink-0" />
              <span className="truncate">{tAgents('addAgent')}</span>
            </Link>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" aria-label={t('listOptions')} title={t('listOptions')} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                  <ListFilter className="size-3.5" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content side="bottom" align="end" sideOffset={4} aria-label={t('listOptions')} className="z-50 w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                  <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('listOptions')}</p>
                  {agents.length ? (
                    <>
                      <Popover.Close asChild>
                        <button type="button" onClick={() => setAllAgentSections(false)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                          <ChevronsUpDown className="size-4" />
                          {t('expandAll')}
                        </button>
                      </Popover.Close>
                      <Popover.Close asChild>
                        <button type="button" onClick={() => setAllAgentSections(true)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                          <ChevronsDownUp className="size-4" />
                          {t('collapseAll')}
                        </button>
                      </Popover.Close>
                    </>
                  ) : null}
                  <div className="my-1 h-px bg-border" />
                  <Popover.Close asChild>
                    <button type="button" onClick={() => setGroupEditor({ id: null, name: '' })} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                      <FolderPlus className="size-4" />
                      {t('newGroup')}
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <Link href={`/app/${encodeURIComponent(slug)}/agents?returnTo=${encodeURIComponent(workReturnTo)}`} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-accent">
                      <Settings2 className="size-4" />
                      {tAgents('manageAgents')}
                    </Link>
                  </Popover.Close>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <ul>
            {sidebarAgentEntries.map((entry) => {
              if (entry.kind === 'group') return renderAgentGroup(entry);
              const { agent: itemAgent, sessions: agentSessions, channels: agentChannels } = entry.item;
              if (entry.groupId && !sessionQuery.trim() && groupPreferences.collapsed[entry.groupId]) return null;
              const expanded = Boolean(sessionQuery)
                || (expandedAgents[itemAgent.id] ?? (itemAgent.id === activeAgentId || agentChannels.length > 0));
              const row = (
                <div data-sidebar-entity-id={itemAgent.id} {...sidebarRowDropProps({ kind: 'agent', id: itemAgent.id })} className={cx(
                  'group relative flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors',
                  itemAgent.id === activeAgentId ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60',
                  draggingSidebarItem?.kind === 'agent' && draggingSidebarItem.id === itemAgent.id && 'opacity-50',
                  sidebarDropIndicatorClassName(dropRow?.kind === 'agent' && dropRow.id === itemAgent.id ? dropRow.edge : undefined),
                )}>
                  <button
                    type="button"
                    draggable
                    aria-label={t('moveToGroup')}
                    title={t('moveToGroup')}
                    onDragStart={(event) => startSidebarDrag(event, { kind: 'agent', id: itemAgent.id })}
                    onDragEnd={clearSidebarDrag}
                    onKeyDown={(event) => reorderSidebarWithKeyboard(event, { kind: 'agent', id: itemAgent.id })}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <GripVertical className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`agent-work-sessions-${itemAgent.id}`}
                    title={expanded ? tAgents('hideConversations') : tAgents('showConversations')}
                    onClick={() => setExpandedAgents((current) => ({ ...current, [itemAgent.id]: !expanded }))}
                    className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] outline-none"
                  >
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
                    <span aria-hidden="true" className="-ml-1.5 hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex">
                      <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                    </span>
                  </button>
                  <SidebarActionRail hasLeadingSlot revealOnCellFocus>
                    <SidebarEntityActionsMenu
                      actionsLabel={tAgents('agentActions', { name: itemAgent.name })}
                      deleteLabel={common('delete')}
                      editLabel={common('edit')}
                      onDelete={() => setDeleteAgentTarget(itemAgent)}
                      onEdit={() => router.push(agentSettingsHref(slug, itemAgent.id, workReturnTo))}
                      onTogglePin={() => void toggleAgentPin(itemAgent)}
                      pinned={itemAgent.pinned}
                      pinLabel={tAgents('pinAgent')}
                      unpinLabel={tAgents('unpinAgent')}
                    />
                    {itemAgent.supportsWork ? (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedAgents((current) => ({ ...current, [itemAgent.id]: true }));
                          startNewWork(itemAgent.id);
                        }}
                        aria-label={`${t('newWork')} · ${itemAgent.name}`}
                        title={t('newWork')}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    ) : null}
                  </SidebarActionRail>
                </div>
              );
              return (
                <li key={`agent-${itemAgent.id}`} className={cx('py-0.5', entry.groupId && 'ml-2 border-l border-border/60 pl-1')}>
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
                          <Link href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(itemAgent.id)}`} onClick={() => startNewWork(itemAgent.id)}>
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
                        <li
                          key={item.id}
                          data-sidebar-conversation-id={item.id}
                          draggable
                          onDragStart={(event) => startSidebarDrag(event, { kind: 'session', id: item.id, agentId: itemAgent.id })}
                          onDragEnd={clearSidebarDrag}
                          {...sidebarRowDropProps({ kind: 'session', id: item.id, agentId: itemAgent.id })}
                          className={cx(
                            'group/session relative py-0.5',
                            draggingSidebarItem?.kind === 'session' && draggingSidebarItem.id === item.id && 'opacity-50',
                            sidebarDropIndicatorClassName(dropRow?.kind === 'session' && dropRow.id === item.id ? dropRow.edge : undefined),
                          )}
                        >
                          <Link
                            href={workHref(slug, item.id)}
                            draggable={false}
                            onKeyDown={(event) => reorderSidebarWithKeyboard(event, { kind: 'session', id: item.id, agentId: itemAgent.id })}
                            onClick={() => { setDraftSelectionKey(null); setMobilePane('work'); }}
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
                      )) : !agentChannels.length ? (
                        <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">{t('noSessions')}</li>
                      ) : null}
                      {agentChannels.length > 0 && <li className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">{tAgents(agentChannels.every((item) => item.source) ? 'channels' : 'chat')}</li>}
                      {agentChannels.map((item) => (
                        <li
                          key={item.id}
                          data-sidebar-conversation-id={item.id}
                          draggable
                          onDragStart={(event) => startSidebarDrag(event, { kind: 'conversation', id: item.id, agentId: itemAgent.id })}
                          onDragEnd={clearSidebarDrag}
                          {...sidebarRowDropProps({ kind: 'conversation', id: item.id, agentId: itemAgent.id })}
                          className={cx(
                            'relative py-0.5',
                            draggingSidebarItem?.kind === 'conversation' && draggingSidebarItem.id === item.id && 'opacity-50',
                            sidebarDropIndicatorClassName(dropRow?.kind === 'conversation' && dropRow.id === item.id ? dropRow.edge : undefined),
                          )}
                        >
                          <Link
                            href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(item.agentId)}&c=${encodeURIComponent(item.id)}`}
                            draggable={false}
                            onKeyDown={(event) => reorderSidebarWithKeyboard(event, { kind: 'conversation', id: item.id, agentId: itemAgent.id })}
                            onClick={() => { setDraftSelectionKey(null); setMobilePane('work'); }}
                            scroll={false}
                            aria-current={item.id === conversation?.id ? 'page' : undefined}
                            title={item.label}
                            className={cx('flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px]', item.id === conversation?.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60')}
                          >
                            {item.source ? <Radio className="size-3.5 shrink-0 text-muted-foreground" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />}
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          </Link>
                        </li>
                      ))}
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
            {(selected || conversation) && controlAgent ? (
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
                confirmationMessage={(conversation?.messages.length || selected?.messages.length) ? t('modelSwitchConfirm') : undefined}
                hermesConversation={controlAgent.runtimeKind === 'hermes' ? {
                  id: conversation?.id ?? selected?.conversationId ?? null,
                  profile: controlHermesSelection?.profile ?? 'default',
                  provider: controlHermesSelection?.provider ?? null,
                  model: controlHermesSelection?.model ?? null,
                  hasMessages: Boolean(conversation?.messages.length || selected?.messages.length),
                  editable: conversation ? !conversation.readOnly : !selected || MESSAGEABLE_STATUSES.has(selected.status),
                  forkOnProfileChange: false,
                } : undefined}
                onHermesDraftChange={!selected && !conversation ? (selection) => {
                  setHermesDraftSelection({ agentId: controlAgent.id, ...selection });
                } : undefined}
                onHermesSelectionSaved={conversation ? async () => router.refresh() : selected ? refreshSelected : undefined}
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
              disabled={Boolean(selected || conversation)}
              options={(selected || conversation ? selectedAgent?.sandboxes ?? [] : sandboxOptions).map((item) => ({
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
              locked={Boolean(selected || conversation)}
              workspaceRoot={controlWorkspaceRoot}
              onChange={setWorkingDirectory}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selected && selected.status !== 'idle' ? (
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
            {controlSandbox && !controlSandbox.running && controlSandbox.status === 'provisioning' ? (
              <span className="hidden items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground md:flex">
                <Loader2 className="size-3 animate-spin" />
                {tSandboxes('starting')}
              </span>
            ) : controlSandbox && !controlSandbox.running ? (
              <form action={startSandboxAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="sandboxId" value={controlSandbox.id} />
                <SubmitButton pendingLabel={tSandboxes('starting')} flash={false} className="ui-button-secondary h-8 px-2 text-xs">
                  <Play className="size-3.5" />
                  {tSandboxes('start')}
                </SubmitButton>
              </form>
            ) : null}
            {selected || conversation ? (
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

        {visibleError ? <p role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{visibleError}</p> : null}
        {conversation && !conversation.readOnly && controlAgent ? (
          <AgentConversation
            key={conversation.id}
            activeConversationId={conversation.id}
            agentId={controlAgent.id}
            agentName={controlAgent.name}
            ready={controlAgent.ready}
            runtimeKind={controlAgent.runtimeKind}
            initialMessages={conversation.messages.filter((message) => !messageCompaction(message)) as HermesUIMessage[]}
            initialReasoningEffort={conversation.reasoningEffort ?? 'default'}
            reasoningAvailable={controlAgent.runtimeKind === 'hermes'}
            creatingConversation={false}
            ensureConversation={async () => conversation.id}
            attachmentUploadUrl={controlAgent.runtimeKind === 'hermes' ? undefined : `/api/v1/workspaces/${workspaceId}/attachments`}
            mcpPromptApiPath={`/api/v1/agents/${controlAgent.id}/prompts`}
            mcpResourceApiPath={`/api/v1/agents/${controlAgent.id}/composer`}
            onBusyChange={setConversationBusy}
            onConversationChanged={() => router.refresh()}
          />
        ) : <div className="relative min-h-0 flex-1">
          <div
            ref={transcriptViewportRef}
            data-ui="work.transcript"
            onScroll={handleTranscriptScroll}
            className="h-full overflow-y-auto [overflow-anchor:none]"
          >
            {selected || conversation ? (
              <>
                <WorkTranscript
                  agentName={controlAgent?.name ?? t('agent')}
                  modelName={conversation?.hermesModel ?? selected?.hermesModel ?? selectedAgent?.model ?? null}
                  messages={conversation?.messages ?? selected?.messages ?? []}
                  streamText={streamText}
                  streamActivities={streamActivities}
                  streamStartedAt={streamStartedAt}
                  streamRuntimeKind={streamRuntimeKind}
                  streamModelName={streamModelName}
                  sessionStartedAt={selected?.startedAt}
                  sessionCompletedAt={selected?.completedAt}
                  streaming={selectedActive}
                />
                {selected?.artifacts.length ? (
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
          {!followingTranscript && (selected || conversation) ? (
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
        </div>}

        {!conversation && <div className="shrink-0 bg-background px-3 pb-3 sm:px-5 sm:pb-4">
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
              <WorkComposer
                key={composerScope}
                agentId={controlAgent?.id}
                sandboxId={controlSandbox?.id}
                workSessionId={selected?.id}
                conversationId={selected?.conversationId}
                commands={commands}
                draft={draft}
                onDraftChange={setDraft}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                references={references}
                onReferencesChange={(items) => setReferenceSelection({ scope: composerScope, items })}
                disabled={Boolean(busy) || running}
                supportsAttachments={controlSandbox?.kind === 'docker' || controlSandbox?.kind === 'hermes'}
                onSubmit={(event) => void sendMessage(event)}
                onNewTask={() => startNewWork(selected?.agentId ?? agentId)}
                onError={setError}
                onPendingChange={setComposerPending}
                waitingQuestion={selected?.waitingQuestion}
                toolbarStart={<>
                    {controlAgent?.runtimeKind === 'hermes' ? (
                      <ReasoningEffortControl
                        value={reasoningEffort}
                        disabled={Boolean(busy) || running}
                        onChange={setReasoningEffort}
                      />
                    ) : null}
                    <span className="flex min-w-0 items-center gap-1.5 truncate px-1 text-[11px] text-muted-foreground">
                      <TerminalSquare className="size-3.5 shrink-0" />
                      {runtimeLabel(selected?.runtimeKind ?? agent?.runtimeKind)}
                    </span>
                </>}
                toolbarEnd={<>
                    <ConversationContextUsage busy={running} usage={contextUsage} />
                    {running ? (
                      <button type="button" disabled={!selected || busy === 'cancel'} onClick={() => void postAction('cancel')} aria-label={t('cancel')} title={t('cancel')} className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-destructive hover:bg-muted disabled:opacity-50">
                        {busy === 'cancel' ? <Loader2 className="size-[18px] animate-spin" /> : <CirclePause className="size-5" />}
                      </button>
                    ) : (
                      <button type="submit" disabled={!draft.trim() || (!canSend && !localCommand) || Boolean(busy) || composerPending} aria-label={t('sendInput')} title={t('sendInput')} className="mr-0.5 mt-px flex size-[30px] shrink-0 items-center justify-center text-brand transition-all duration-200 disabled:cursor-not-allowed disabled:text-muted-foreground/50">
                        {busy === 'create' || busy === 'input' ? <Loader2 className="size-[18px] animate-spin" /> : <Send className="size-[22px]" />}
                      </button>
                    )}
                </>}
              />
            )}
            {!selected && agent && !agent.ready ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('configureAgent')}</p> : null}
            {!selected && agent?.ready && !sandboxOptions.length ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('attachSandbox')}</p> : null}
            {!selected && activeSandbox && !activeSandbox.running && activeSandbox.status !== 'provisioning' && agent?.runtimeKind !== 'hermes' ? <p className="px-2 pt-2 text-xs text-amber-700 dark:text-amber-300">{t('stopped')}</p> : null}
          </div>
        </div>}
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

      <SidebarGroupDialog
        initialName={groupEditor?.name ?? ''}
        open={Boolean(groupEditor)}
        title={t(groupEditor?.id ? 'renameGroup' : 'newGroup')}
        nameLabel={t('groupName')}
        placeholder={t('groupNamePlaceholder')}
        cancelLabel={common('cancel')}
        submitLabel={groupEditor?.id ? common('save') : common('create')}
        onClose={() => setGroupEditor(null)}
        onSubmit={saveAgentGroup}
      />

      <Dialog open={Boolean(deleteAgentTarget)} onOpenChange={(open) => { if (!open) setDeleteAgentTarget(null); }}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent className="!max-w-md">
            <DialogTitle>{tAgents('deleteAgent')}</DialogTitle>
            <DialogDescription>{tAgents('deleteThisAgentAndItsSandboxesAndAllItsConversations')}</DialogDescription>
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
