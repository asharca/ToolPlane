'use client';
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph';
import { ButtonLink } from '@/components/motion/button';

import { Button } from '@/components/motion/button';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';


import {
  Bot,
  Boxes,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  Clock3,
  Minimize2,
  Cpu,
  FileText,
  FileOutput,
  Folder,
  FolderPlus,
  ListFilter,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  Radio,
  Settings2,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import { AISidebar, type SidebarResource, type SidebarResourceMove } from '@/components/agents/ai-sidebar';
import { ChatApp, ChatAppSidebarTrigger } from '@/components/dashboard/chat/ChatApp';
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarInset,
  AnimatedSidebarRail,
} from '@/components/motion/animated-sidebar';
import { AgentModelDialog } from '@/components/dashboard/agents/AgentModelDialog';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import { ReasoningEffortControl } from '@/components/dashboard/agents/ReasoningEffortControl';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import { ConversationContextUsage } from '@/components/dashboard/ConversationComposer';
import { WorkComposer } from './WorkComposer';
import type { ComposerReference } from '@/lib/work/composer-types';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { SidebarGroupDialog } from '@/components/dashboard/SidebarGroupDialog';
import { AssistantMarkdown } from '@/components/dashboard/ConversationMessage';
import { Message, MessageAvatar, MessageBubble, MessageBubbleContent, MessageContent, MessageFooter, MessageGroup, MessageHeader } from '@/components/agents/message';
import { StreamingResponse } from '@/components/agents/streaming-response';
import { MessageScroller } from '@/components/agents/message-scroller';
import { AgentActivity } from '@/components/agents/agent-activity';
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result';
import { ToolApproval } from '@/components/agents/tool-approval';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import { resolveContextUsage } from '@/lib/context-usage';
import { deleteAgentAction, pinAgentAction } from '@/lib/agents/actions';
import { normalizeReasoningEffort, type ReasoningEffort } from '@/lib/agents/constants';
import { displayMessagingUserText, type ParsedMessagingSession } from '@/lib/agents/messaging';
import { activeConversationMessages, isConversationControl, messageCompaction } from '@/lib/agents/conversation-context';
import { COMMAND_RESULT_PART, parseRuntimeCommand, sessionRuntimeCommands } from '@/lib/agents/runtime-commands';
import type { executeRuntimeCommand } from '@/lib/agents/runtime-command-service';
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
  sortSidebarItems,
  reorderSidebarItems,
  type SidebarGroupPreferences,
} from '@/lib/sidebar-groups';
import { usePersistentSidebarGroups } from '@/lib/use-persistent-sidebar-groups';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { CenterMorphModal, CenterMorphModalClose, CenterMorphModalContent } from '@/components/motion/center-morph-modal';

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

type WorkPanel = 'files' | 'terminal';

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
const MESSAGEABLE_STATUSES = new Set(['idle', 'waiting_user', 'completed', 'failed']);
const ARCHIVABLE_STATUSES = new Set(['idle', 'completed', 'failed', 'cancelled']);
const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];
const EMPTY_EXPANDED_AGENTS: Record<string, boolean> = {};
const UNGROUPED_SIDEBAR_GROUP_ID = '__ungrouped__';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}


function sidebarIssueTone(status: string): 'error' | 'warning' | 'running' | null {
  if (['error', 'failed', 'copy_failed', 'restore_failed', 'restore_cleanup_required'].includes(status)) return 'error';
  if (['setup_required', 'stopped', 'waiting_user', 'waiting_approval'].includes(status)) return 'warning';
  if (status === 'running') return 'running';
  return null;
}

function agentSidebarIssueTone(agent: WorkAgent | undefined, hasRunningSession: boolean): 'error' | 'warning' | 'running' | null {
  if (!agent) return null;
  const sandboxTones = agent.sandboxes.map((sandbox) => sidebarIssueTone(sandbox.status ?? '')).filter((tone) => tone !== 'running');
  if (sandboxTones.includes('error')) return 'error';
  if (sandboxTones.includes('warning') || (agent.supportsWork && !agent.ready)) return 'warning';
  if (hasRunningSession) return 'running';
  return null;
}

function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'claude-code') return 'Claude Code';
  if (kind === 'dsh') return 'DeepSeek Harness';
  if (kind === 'hermes') return 'Hermes';
  if (kind === 'hermes-rpc') return 'Hermes RPC';
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
  const messageActionClassName = 'size-7 rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5';
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
    <MessageGroup spacing="default" className="mx-auto w-full max-w-3xl p-4">
      {transcript.map((message, messageIndex) => {
        if (messageCompaction(message)) return <CompactionNote key={message.id} message={message} />;
        const isStreamingMessage = message.id === 'work-stream';
        const actionVisibility = messageIndex === transcript.length - 1
          ? ''
          : 'opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto motion-reduce:transition-none';
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
                className={`inline-flex min-w-0 max-w-56 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1.5 text-xs text-foreground hover:bg-muted ${part.mediaType?.startsWith('image/') ? 'flex-wrap' : 'flex-nowrap'}`}
              >
                {part.mediaType?.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={part.url} alt={part.filename ?? agentsT('attachment')} className="max-h-48 w-full object-contain" />
                ) : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 truncate">{part.filename ?? agentsT('attachment')}</span>
              </a>
            ))}
          </div>
        ) : null;
        const messageBody = <>
              {attachmentLinks}
              {message.parts.filter((part) => part.reference).map((part, index) => <details key={index} className="my-1 text-xs"><summary className="cursor-pointer break-words">@{part.reference!.label}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{part.text}</pre></details>)}
              {message.role !== 'user' && (isStreamingMessage || visibleProcessParts.length) ? <div data-ui="work-process" className="w-full">
                <AgentActivity status={isStreamingMessage ? 'working' : 'complete'} defaultOpen={processFailed || processCancelled} collapseOnComplete={!processFailed && !processCancelled} activeLabel={<>{t('processing')} <WorkElapsed timing={messageTiming} live dataUi="work-process-duration" /></>} summary={<>{processFailed ? t('processFailed') : processCancelled ? t('processCancelled') : t('processed')} <WorkElapsed timing={messageTiming} dataUi="work-process-duration" /></>} items={visibleProcessParts.map((part, index) => ({
                  id: part.toolCallId ?? message.id + ':' + index,
                  type: 'text' as const,
                  content: part.type === 'reasoning' ? <div><p className="text-xs text-muted-foreground">{part.status === 'running' ? t('thinking') : t('thought')}</p><pre className="whitespace-pre-wrap break-words text-xs">{part.text}</pre></div> : part.type === 'work-runtime' ? <p className="text-xs text-muted-foreground">{part.status === 'cancelled' ? t('runtimeCancelled', { runtime: runtimeLabel(part.runtimeKind) }) : runtimeLabel(part.runtimeKind)}</p> : <ToolResult tool={workToolLabel(part)} title={part.status === 'running' ? t('toolRunning') : part.isError || part.status === 'failed' ? t('toolFailed') : part.status === 'cancelled' ? t('toolCancelled') : t('toolCompleted')} status={part.isError || part.status === 'failed' ? 'error' : part.status === 'cancelled' ? 'cancelled' : part.status === 'running' ? 'running' : 'success'} meta={formatWorkDuration(part.durationMs)} defaultOpen={part.status === 'running' || part.isError || part.status === 'failed'} copyText={part.output === undefined ? undefined : formatValue(part.output)}>
                    <p className="text-xs text-muted-foreground">{agentsT('toolInput')}</p><ToolResultOutput language="json">{formatValue(part.input)}</ToolResultOutput>
                    {part.output !== undefined ? <><p className="text-xs text-muted-foreground">{agentsT('toolOutput')}</p><ToolResultOutput language={typeof part.output === 'string' ? 'text' : 'json'}>{formatValue(part.output)}</ToolResultOutput></> : null}
                  </ToolResult>,
                }))} />
              </div> : null}
              {text ? message.role === 'user' ? <span className="whitespace-pre-wrap">{text}</span> : <AssistantMarkdown text={text} streaming={isStreamingMessage} /> : null}
        </>;
        return <Message key={message.id} from={message.role === 'user' ? 'user' : 'assistant'} data-message-id={message.id} aria-busy={isStreamingMessage || undefined}>
          <MessageAvatar>{message.role === 'user' ? <UserRound /> : <Bot />}</MessageAvatar>
          <MessageContent>
            <MessageHeader>
              <span>{message.role === 'user' ? agentsT('user') : agentName}</span>
              {messageModelName && message.role !== 'user' ? <span data-ui="assistant-reply-model" title={messageModelName} className="truncate">{messageModelName}</span> : null}
              {messageTime ? <time data-ui="work-message-time" dateTime={message.createdAt} title={messageTime.title}>{messageTime.label}</time> : null}
              <WorkElapsed timing={messageTiming} live={isStreamingMessage} dataUi="work-message-duration" />
            </MessageHeader>
            {message.role === 'user' ? <MessageBubble variant="soft"><MessageBubbleContent>{messageBody}</MessageBubbleContent></MessageBubble> : (
              <StreamingResponse status={isStreamingMessage ? 'streaming' : processFailed ? 'error' : 'complete'} copyText={text} announce={false} actionsClassName={actionVisibility}>
                {messageBody}
              </StreamingResponse>
            )}
            {message.role === 'user' && text ? <MessageFooter className={`gap-0.5 ${actionVisibility}`}><CopyButton text={text} label={common('copy')} iconOnly className={messageActionClassName} /></MessageFooter> : null}
          </MessageContent>
        </Message>;
      })}
    </MessageGroup>
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
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<'sessions' | 'work'>('work');
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:work-sidebar:${workspaceId}`,
    initialSidebarOpen,
    workSidebarCookieName(workspaceId),
  );
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
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [referenceSelection, setReferenceSelection] = useState<{ scope: string; items: ComposerReference[] }>({ scope: '', items: [] });
  const [composerPending, setComposerPending] = useState(false);
  const commandsT = useTranslations('console.runtimeCommands');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [desktopPanel, setDesktopPanel] = useState<WorkPanel | null>(null);
  const [mobilePanel, setMobilePanel] = useState<WorkPanel | null>(null);
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
  const workspacePanelOpen = Boolean(desktopPanel && controlSandbox);

  const activeAgentId = conversation?.agentId ?? selected?.agentId ?? agentId;
  const visibleAgents = useMemo<WorkSidebarAgent[]>(() => sortSidebarItems(agents, groupPreferences.entityOrder).map((item) => {
    const order = groupPreferences.conversationOrder?.[item.id];
    const agentSessions = sortSidebarItems(items.filter((session) => session.agentId === item.id), order);
    const agentChannels = sortSidebarItems(conversations.filter((entry) => entry.agentId === item.id), order).map((entry) => {
      if (!entry.source) return { ...entry, label: entry.title || tAgents('newChat') };
      const { platform, chatId } = entry.source;
      const platformLabel = tChannels.has(`platforms.${platform}`) ? tChannels(`platforms.${platform}`) : platform;
      return { ...entry, label: `${platformLabel} · ${chatId}` };
    });
    return { agent: item, sessions: agentSessions, channels: agentChannels };
  }), [agents, items, conversations, groupPreferences.entityOrder, groupPreferences.conversationOrder, tChannels, tAgents]);
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
      groups: groupPreferences.groups.map((group) => ({ group, agents: agentsByGroup.get(group.id) ?? [] })),
      ungrouped,
    };
  }, [groupPreferences.assignments, groupPreferences.groups, visibleAgents]);
  const sidebarResources = useMemo<SidebarResource[]>(() => {
    const agentResources = (entries: WorkSidebarAgent[]): SidebarResource[] => entries.map(({ agent: itemAgent, sessions: agentSessions, channels }) => ({
      id: `agent:${itemAgent.id}`,
      label: itemAgent.name,
      kind: 'project',
      children: [...agentSessions.map((item) => ({ id: `session:${item.id}`, label: item.title || item.task || t('untitled'), kind: 'file' as const })), ...channels.map((item) => ({ id: `conversation:${item.id}`, label: item.label, kind: 'bookmark' as const }))],
    }));
    if (!groupPreferences.groups.length) return agentResources(visibleAgents);
    return [
      ...groupedAgents.groups.map(({ group, agents: groupAgents }) => ({
        id: `group:${group.id}`, label: group.name, kind: 'folder' as const, children: agentResources(groupAgents),
      })),
      { id: 'group:ungrouped', label: t('ungrouped'), kind: 'folder' as const, children: agentResources(groupedAgents.ungrouped) },
    ];
  }, [groupPreferences.groups.length, groupedAgents, t, visibleAgents]);
  const activeResourceId = conversation ? `conversation:${conversation.id}` : selected ? `session:${selected.id}` : null;

  async function moveSidebarResource(move: SidebarResourceMove) {
    const [sourceKind, sourceId] = move.itemId.split(':', 2);
    const [targetKind, targetId] = move.targetId?.split(':', 2) ?? [];
    if (sourceKind === 'agent') {
      const targetAgent = targetKind === 'agent' ? agents.find((item) => item.id === targetId) : null;
      const targetGroupId = targetKind === 'group' && move.position === 'inside'
        ? targetId === 'ungrouped' ? null : targetId
        : targetAgent && (move.position === 'before' || move.position === 'after')
          ? groupPreferences.assignments[targetAgent.id] ?? null
          : undefined;
      if (targetGroupId === undefined || !agents.some((item) => item.id === sourceId)) throw new Error('Unsupported agent move');
      setGroupPreferences((current) => {
        const assignments = { ...current.assignments };
        if (targetGroupId) assignments[sourceId] = targetGroupId;
        else delete assignments[sourceId];
        const next = { ...current, assignments, collapsed: { ...current.collapsed, [targetGroupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false } };
        return targetAgent && (move.position === 'before' || move.position === 'after')
          ? { ...next, entityOrder: reorderSidebarItems(sortSidebarItems(agents, current.entityOrder), sourceId, targetId, move.position) }
          : next;
      });
      return;
    }
    const edge = move.position === 'before' ? 'before' : move.position === 'after' ? 'after' : null;
    if ((sourceKind !== 'session' && sourceKind !== 'conversation') || targetKind !== sourceKind || !targetId || !edge) {
      throw new Error('Unsupported resource move');
    }
    const source = (sourceKind === 'session' ? items : conversations).find((item) => item.id === sourceId);
    const target = (sourceKind === 'session' ? items : conversations).find((item) => item.id === targetId);
    if (!source || !target || source.agentId !== target.agentId) throw new Error('Resources must stay with their agent');
    const agentItems = [...items, ...conversations].filter((item) => item.agentId === source.agentId);
    setGroupPreferences((current) => ({
      ...current,
      conversationOrder: {
        ...current.conversationOrder,
        [source.agentId]: reorderSidebarItems(sortSidebarItems(agentItems, current.conversationOrder?.[source.agentId]), sourceId, targetId, edge),
      },
    }));
  }

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
  }, [creatingMode, selectedWorkSessionId, setItems, setLiveSelected]);

  const selectedActive = Boolean(selectedStatus && ACTIVE_STATUSES.has(selectedStatus));

  useEffect(() => {
    if (!selected?.titlePending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSelected();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [refreshSelected, selected?.titlePending]);

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

  const modelPicker = controlAgent ? (
    <AgentModelDialog
                key={`${controlAgent.id}:${controlAgent.model ?? ''}`}
                open={modelDialogOpen}
                onOpenChange={setModelDialogOpen}
                slug={slug}
                agent={{ ...controlAgent, providerId: controlAgent.providerId ?? null, providerIds: controlAgent.providerIds ?? [], model: controlAgent.model ?? null }}
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
                onHermesDraftChange={!selected && !conversation ? (selection) => setHermesDraftSelection({ agentId: controlAgent.id, ...selection }) : undefined}
                onHermesSelectionSaved={conversation ? async () => router.refresh() : selected ? refreshSelected : undefined}
      trigger={<Button type="button" aria-label={`${t('model')}: ${controlModelLabel}`} title={controlModelLabel} variant="ghost" size="sm" className="h-8 min-w-0 max-w-52 gap-1.5 rounded-xl px-2 text-xs text-muted-foreground"><Cpu className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{controlModelLabel}</span><ChevronDown className="size-3 shrink-0" /></Button>}
    />
  ) : null;

  return (
    <ChatApp
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      openMobile={mobilePane === 'sessions'}
      onOpenMobileChange={(open) => setMobilePane(open ? 'sessions' : 'work')}
      className="relative flex h-full min-w-0"
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AnimatedSidebar ariaLabel={tAgents('agents')} collapsible="offcanvas" className="h-full shrink-0" panelClassName="h-full min-h-0">
        <AnimatedSidebarContent className="gap-3 overflow-hidden px-2 py-3">

        <AnimatedSidebarGroup className="min-h-0 flex-1 p-0">
          <div className="flex h-9 shrink-0 items-center justify-between px-1">
            <ButtonLink href={`/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`} aria-label={tAgents('addAgent')} title={tAgents('addAgent')} variant="ghost" size="icon" className="shrink-0">
              <Plus className="size-4" />
            </ButtonLink>
            <MorphPopover open={listOptionsOpen} onOpenChange={setListOptionsOpen}>
              <MorphPopoverTrigger>
                <Button type="button" aria-label={t('listOptions')} variant={"ghost"} size={"icon"} className="flex shrink-0 items-center justify-center"><ListFilter className="size-3.5" /></Button>
              </MorphPopoverTrigger>
              <>
                <MorphPopoverContent side="bottom" align="end" sideOffset={4} className="z-50 w-52 p-1.5">
                  <ButtonLink href={`/app/${encodeURIComponent(slug)}/agents?tab=management&returnTo=${encodeURIComponent(workReturnTo)}`} onClick={() => setListOptionsOpen(false)} variant="ghost" size="sm" className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2">
                    <Settings2 className="size-4 shrink-0" />
                    <span>{tAgents('agentManagement')}</span>
                  </ButtonLink>
                  <div className="my-1 h-px bg-border" />
                  {agents.length ? (
                    <>
                      <Button type="button" onClick={() => setAllAgentSections(false)} variant="ghost" size="sm" className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2">
                        <ChevronsUpDown className="size-4 shrink-0" />
                        <span>{t('expandAll')}</span>
                      </Button>
                      <Button type="button" onClick={() => setAllAgentSections(true)} variant="ghost" size="sm" className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2">
                        <ChevronsDownUp className="size-4 shrink-0" />
                        <span>{t('collapseAll')}</span>
                      </Button>
                    </>
                  ) : null}
                  <div className="my-1 h-px bg-border" />
                  <Button type="button" onClick={() => setGroupEditor({ id: null, name: '' })} variant="ghost" size="sm" className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2">
                    <FolderPlus className="size-4 shrink-0" />
                    <span>{t('newGroup')}</span>
                  </Button>
                </MorphPopoverContent>
              </>
            </MorphPopover>
          </div>
          <AnimatedSidebarGroupContent className="min-h-0 flex-1 overflow-y-auto">
          {sidebarResources.length ? <AISidebar
            key={JSON.stringify([groupPreferences.collapsed, expandedAgents])}
            items={sidebarResources}
            activeId={activeResourceId}
            ariaLabel={tAgents('agents')}
            className="px-1"
            defaultExpandedIds={[
              ...groupPreferences.groups.filter((group) => !groupPreferences.collapsed[group.id]).map((group) => `group:${group.id}`),
              ...(groupPreferences.collapsed[UNGROUPED_SIDEBAR_GROUP_ID] ? [] : ['group:ungrouped']),
              ...visibleAgents.filter(({ agent: itemAgent, channels }) => expandedAgents[itemAgent.id] ?? (itemAgent.id === activeAgentId || channels.length > 0)).map(({ agent: itemAgent }) => `agent:${itemAgent.id}`),
            ]}
            onActiveChange={(id) => {
              setDraftSelectionKey(null);
              setMobilePane('work');
              const [kind, resourceId] = id.split(':', 2);
              if (kind === 'session') router.push(workHref(slug, resourceId));
              if (kind === 'conversation') router.push(`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversations.find((item) => item.id === resourceId)?.agentId ?? activeAgentId)}&c=${encodeURIComponent(resourceId)}`);
            }}
            onMove={moveSidebarResource}
            onRename={(resource, label) => {
              if (!resource.id.startsWith('group:') || resource.id === 'group:ungrouped') return;
              const id = resource.id.slice('group:'.length);
              setGroupPreferences((current) => ({ ...current, groups: current.groups.map((group) => group.id === id ? { ...group, name: label } : group) }));
            }}
            renderActions={(resource) => {
              const [kind, id] = resource.id.split(':', 2);
              const itemAgent = kind === 'agent' ? agents.find((item) => item.id === id) : null;
              if (!itemAgent?.supportsWork) return null;
              return (
                <button
                  type="button"
                  draggable={false}
                  aria-label={`${t('newWork')} ${itemAgent.name}`}
                  title={t('newWork')}
                  onClick={(event) => { event.stopPropagation(); startNewWork(itemAgent.id); }}
                  className="grid size-7 shrink-0 place-items-center rounded-lg outline-none opacity-0 transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
                >
                  <MessageSquarePlus aria-hidden="true" className="size-3.5" />
                </button>
              );
            }}
            renderIcon={(resource) => {
              const [kind, id] = resource.id.split(':', 2);
              if (kind === 'agent') {
                const itemAgent = agents.find((item) => item.id === id);
                const hasRunningSession = items.some((session) => session.agentId === id && session.status === 'running');
                const tone = agentSidebarIssueTone(itemAgent, hasRunningSession);
                return <span className="relative grid size-5 place-items-center"><Bot className="size-4" />{tone ? <span className={cx('absolute right-0 top-0 size-2 rounded-full ring-1 ring-background', tone === 'error' ? 'bg-destructive' : tone === 'warning' ? 'bg-amber-500' : 'bg-green-500')} /> : null}</span>;
              }
              if (kind === 'session') {
                const item = items.find((session) => session.id === id);
                const tone = sidebarIssueTone(item?.status ?? '');
                return tone ? <Circle className={cx('size-2 fill-current', tone === 'error' ? 'text-destructive' : tone === 'warning' ? 'text-amber-500' : 'text-green-500')} /> : null;
              }
              if (kind === 'conversation') return conversations.find((item) => item.id === id)?.source ? <Radio className="size-4" /> : <MessageSquare className="size-4" />;
              return <Folder className="size-4" />;
            }}
            renderMenu={(resource, controls) => {
              const [kind, id] = resource.id.split(':', 2);
              const action = (label: string, run: () => void) => <button type="button" onClick={() => { controls.close(); run(); }} className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-xs text-foreground hover:bg-muted">{label}</button>;
              const moveActions = <>
                {controls.moves.up ? action('Move up', controls.moves.up) : null}
                {controls.moves.down ? action('Move down', controls.moves.down) : null}
              </>;
              if (kind === 'group' && id !== 'ungrouped') return <>{action(t('renameGroup'), controls.rename)}{action(t('deleteGroup'), () => deleteAgentGroup(id))}</>;
              if (kind === 'agent') {
                const itemAgent = agents.find((item) => item.id === id);
                if (!itemAgent) return null;
                return <>
                  {itemAgent.supportsWork ? action(t('newWork'), () => startNewWork(itemAgent.id)) : null}
                  {action(tAgents('chat'), () => router.push(`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(itemAgent.id)}`))}
                  {action(tAgents('configureAgent'), () => router.push(agentSettingsHref(slug, itemAgent.id, workReturnTo)))}
                  {action(itemAgent.pinned ? tAgents('unpinAgent') : tAgents('pinAgent'), () => void toggleAgentPin(itemAgent))}
                  {action(tAgents('deleteAgent'), () => setDeleteAgentTarget(itemAgent))}
                  {moveActions}
                </>;
              }
              if (kind === 'session') {
                const item = items.find((session) => session.id === id);
                return item && ARCHIVABLE_STATUSES.has(item.status) ? <>{moveActions}{action(t('archive'), () => void archiveWork(id))}</> : moveActions;
              }
              if (kind === 'conversation') return moveActions;
              return null;
            }}
          /> : <p className="px-3 py-8 text-center text-xs text-muted-foreground">{tAgents('noAgentsYet')}</p>}
          </AnimatedSidebarGroupContent>
        </AnimatedSidebarGroup>
        </AnimatedSidebarContent>
        <AnimatedSidebarRail />
      </AnimatedSidebar>

      <AnimatedSidebarInset className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4">
          <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
            <ChatAppSidebarTrigger openLabel={t('showSidebar')} closeLabel={t('hideSidebar')}><PanelLeft className="size-4" /></ChatAppSidebarTrigger>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{selected?.title || selected?.task || controlAgent?.name || t('title')}</p>
              <p className="truncate text-[11px] text-muted-foreground">{controlAgent ? `${controlAgent.name} · ${runtimeLabel(selected?.runtimeKind ?? agent?.runtimeKind)}` : t('emptyDescription')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {controlSandbox ? <>
              <Button type="button" onClick={() => togglePanel('files')} aria-label={tSandboxes('files')} title={tSandboxes('files')} aria-pressed={desktopPanel === 'files'} variant="ghost" size="icon"><Folder className="size-4" /></Button>
              <Button type="button" onClick={() => togglePanel('terminal')} aria-label={tSandboxes('terminal')} title={tSandboxes('terminal')} aria-pressed={desktopPanel === 'terminal'} variant="ghost" size="icon"><TerminalSquare className="size-4" /></Button>
            </> : null}
          </div>
        </header>

        {conversation?.readOnly ? <div className="mx-auto w-full max-w-3xl px-4 py-2">{modelPicker}</div> : null}
        {visibleError ? <p role="alert" className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{visibleError}</p> : null}
        {conversation && !conversation.readOnly && controlAgent ? (
          <AgentConversation
            key={conversation.id}
            activeConversationId={conversation.id}
            agentId={controlAgent.id}
            agentName={controlAgent.name}
            ready={controlAgent.ready}
            runtimeKind={controlAgent.runtimeKind}
            modelName={controlHermesSelection?.model ?? controlAgent.model}
            modelPicker={modelPicker}
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
        ) : <MessageScroller key={selected?.id ?? conversation?.id ?? 'new'} label={t('title')} data-ui="work.transcript" busy={selectedActive} navigation="rail" className="min-h-0 flex-1">
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
                  <section className="mx-auto w-full max-w-3xl px-4 py-5">
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
        </MessageScroller>}

        {!conversation && <div className="mx-auto w-full max-w-3xl shrink-0 px-4">
          <div>
            {pendingApprovals.length ? <div className="space-y-3">{pendingApprovals.map((approval) => <ToolApproval key={approval.id} tool={approval.toolName} title={t('approvalRequired')} status={busy ? 'approving' : 'pending'} parameters={[{ id: 'input', label: t('details'), value: <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{formatValue(approval.input)}</pre> }]} onApprove={() => { if (!busy) void decideApproval(approval.id, 'allow'); }} onDeny={() => { if (!busy) void decideApproval(approval.id, 'deny'); }} />)}</div> : (
              <WorkComposer key={composerScope}
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
                supportsAttachments={controlSandbox?.kind === 'docker' || controlSandbox?.kind === 'hermes'}
                onError={setError}
                onPendingChange={setComposerPending}
                waitingQuestion={selected?.waitingQuestion}
                toolbarStart={<>
                    {modelPicker}
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
                disabled={Boolean(busy) || running || (!canSend && !localCommand) || composerPending}
                loading={running}
                onStop={selected && busy !== 'cancel' ? () => void postAction('cancel') : undefined}
                onSubmit={() => void sendMessage()}
                toolbarEnd={<ConversationContextUsage busy={running} usage={contextUsage} />}
              />
            )}
            {!selected && agent && !agent.ready ? <p className="px-2 pt-2 text-xs text-muted-foreground text-muted-foreground">{t('configureAgent')}</p> : null}
            {!selected && agent?.ready && !sandboxOptions.length ? <p className="px-2 pt-2 text-xs text-muted-foreground text-muted-foreground">{t('attachSandbox')}</p> : null}
            {!selected && activeSandbox && !activeSandbox.running && activeSandbox.status !== 'provisioning' && agent?.runtimeKind !== 'hermes' ? <p className="px-2 pt-2 text-xs text-muted-foreground text-muted-foreground">{t('stopped')}</p> : null}
          </div>
        </div>}
      </main>
      </AnimatedSidebarInset>

      {workspacePanelOpen ? (
        <aside className="hidden w-96 shrink-0 min-h-0 overflow-hidden bg-background xl:block">
          {controlSandbox ? (
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
      </div>

      {mobilePanel ? (
        <CenterMorphModal open={Boolean(mobilePanel)} onOpenChange={(open) => { if (!open) setMobilePanel(null); }}><CenterMorphModalContent ariaLabel={mobilePanel === 'files' ? tSandboxes('files') : tSandboxes('terminal')} closeButtonLabel={t('closeWorkspace')} className="flex h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col"><header className="flex h-16 shrink-0 items-center pl-3 pr-16">
          <span className="flex items-center gap-2 text-sm font-medium">
            {mobilePanel === 'files' ? <Folder className="size-4" /> : <TerminalSquare className="size-4" />}
            {mobilePanel === 'files' ? tSandboxes('files') : tSandboxes('terminal')}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {controlSandbox ? (
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
        </div></CenterMorphModalContent></CenterMorphModal>
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

      <CenterMorphModal open={Boolean(deleteAgentTarget)} onOpenChange={(open) => { if (!open) setDeleteAgentTarget(null); }}>
        <>
          
          <CenterMorphModalContent ariaLabel={tAgents('deleteAgent')} closeButtonLabel={tAgents('close')} className="max-w-md">
            <h2 className="pr-16 text-lg font-semibold">{tAgents('deleteAgent')}</h2>
            <p className="text-sm text-muted-foreground">{tAgents('deleteThisAgentAndItsSandboxesAndAllItsConversations')}</p>
            <form action={deleteAgentAction} className="flex justify-end gap-2">
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={deleteAgentTarget?.id ?? ''} />
              <input type="hidden" name="returnTo" value={`/app/${slug}/work`} />
              <CenterMorphModalClose>
                <Button type="button" variant={"secondary"} size={"sm"}>{tAgents('cancel')}</Button>
              </CenterMorphModalClose>
              <SubmitButton pendingLabel={tAgents('deleting')} >
                {tAgents('confirmDelete')}
              </SubmitButton>
            </form>
          </CenterMorphModalContent>
        </>
      </CenterMorphModal>
    </ChatApp>
  );
}

