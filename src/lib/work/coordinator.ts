import 'server-only';
import { posix } from 'node:path';
import type { Prisma } from '@prisma/client';
import { Type, type ToolCall } from '@earendil-works/pi-ai';
import { db } from '@/lib/db';
import { getAgentForRun } from '@/lib/agents/queries';
import { ensureConversationRuntimeSession } from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { buildAgentToolSet } from '@/lib/agents/run';
import { agentTool, type AgentToolSet } from '@/lib/agents/agent-tool';
import { toolKey } from '@/lib/agents/tools';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import { runNativeAgent, uiMessagesToPi } from '@/lib/agents/native';
import { isDedicatedSandboxRuntimeKind, isWorkRuntimeKind } from '@/lib/agents/runtime-kind';
import { runDedicatedSandboxTurn } from '@/lib/agents/sandbox-turn';
import type { SandboxRuntimeActivity } from '@/lib/agents/sandbox-runtime';
import {
  runHermesWork,
  stopHermesWorkRun,
  type HermesWorkApproval,
} from '@/lib/agents/hermes/work';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from '@/lib/agents/hermes/runtime';
import type { ContextUsageSnapshot } from '@/lib/context-usage';
import { effectiveStatus } from '@/lib/process/supervisor';
import { normalizeWorkDirectory } from './sessions';
import {
  finishWorkOutput,
  publishWorkActivity,
  publishWorkOutput,
  registerWorkRun,
  startWorkOutput,
  unregisterWorkRun,
} from './run-control';

const MAX_CONCURRENT_WORK = 2;
const APPROVAL_POLL_MS = 500;
const MAX_REASONING_CHARACTERS = 40_000;

type RuntimeSnapshot = {
  providerId?: string | null;
  model?: string | null;
  systemPrompt?: string | null;
  agentMaxSteps?: number;
  deploymentIds?: string[];
  installedSkillIds?: string[];
  knowledgeBaseIds?: string[];
  workingDirectory?: string;
  runtimeId?: string | null;
  hermesRunId?: string | null;
};

type RuntimeMessage = {
  id: string;
  role: string;
  parts: Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
    providerMetadata?: unknown;
    filename?: unknown;
  }>;
};

type WorkOutcome =
  | { kind: 'running' }
  | { kind: 'complete'; summary: string; artifacts: string[] }
  | { kind: 'waiting_user'; question: string };

type WorkToolPart = {
  type: 'work-tool';
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
};

type WorkTracePart = WorkToolPart | {
  type: 'reasoning';
  text: string;
  state: 'done';
} | {
  type: 'work-runtime';
  runtimeKind: string;
  status: 'completed' | 'failed' | 'cancelled';
};

type CoordinatorState = {
  draining: boolean;
  active: Set<string>;
  timer?: ReturnType<typeof setInterval>;
  reconciled: boolean;
};

const coordinatorGlobal = globalThis as unknown as { __workCoordinator?: CoordinatorState };
const state = coordinatorGlobal.__workCoordinator ?? {
  draining: false,
  active: new Set<string>(),
  reconciled: false,
};
coordinatorGlobal.__workCoordinator = state;

function snapshot(value: Prisma.JsonValue | null): RuntimeSnapshot {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RuntimeSnapshot
    : {};
}

function resolveWorkPath(workingDirectory: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const input = value.trim().replace(/\\/g, '/') || '.';
  if (input === '/workspace' || input.startsWith('/workspace/')) {
    return normalizeWorkDirectory(input);
  }
  if (input.startsWith('/')) return null;
  if (workingDirectory !== '.' && (input === workingDirectory || input.startsWith(`${workingDirectory}/`))) {
    return normalizeWorkDirectory(input);
  }
  return normalizeWorkDirectory(posix.join(workingDirectory, input));
}

export function scopeWorkToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  workingDirectory: string,
): Record<string, unknown> {
  const base = normalizeWorkDirectory(workingDirectory) ?? '.';
  if (toolName === 'shell_exec' || toolName === 'process_exec') {
    return { ...args, cwd: resolveWorkPath(base, args.cwd ?? '.') ?? args.cwd };
  }
  if (toolName === 'list_dir') {
    return { ...args, path: resolveWorkPath(base, args.path ?? '.') ?? args.path };
  }
  if (['read_file', 'write_file', 'download_file', 'delete_file'].includes(toolName)) {
    const path = resolveWorkPath(base, args.path);
    return path ? { ...args, path } : args;
  }
  return args;
}

function withWorkingDirectory(
  tools: AgentToolSet,
  deploymentId: string,
  workingDirectory: string,
): AgentToolSet {
  const scoped = { ...tools };
  for (const name of ['shell_exec', 'process_exec', 'list_dir', 'read_file', 'write_file', 'download_file', 'delete_file']) {
    const key = toolKey(deploymentId, name);
    const tool = scoped[key];
    if (!tool) continue;
    scoped[key] = {
      ...tool,
      execute: (args: Record<string, unknown>, ...rest: unknown[]) =>
        tool.execute(scopeWorkToolArgs(name, args, workingDirectory), ...rest),
    };
  }
  return scoped;
}

export function filterWorkArtifacts(values: unknown, workingDirectory = '.'): string[] {
  const base = normalizeWorkDirectory(workingDirectory) ?? '.';
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const candidate = value.trim();
    if (!candidate || candidate.length > 1_000 || candidate.includes('\0')) return [];
    const path = resolveWorkPath(base, candidate);
    if (!path) return [];
    const resolved = posix.resolve('/workspace', path);
    return resolved === '/workspace' || resolved.startsWith('/workspace/') ? [resolved] : [];
  }).slice(0, 100);
}

export function requiresWorkApproval(toolName: string): boolean {
  if (toolName === 'complete_work' || toolName === 'request_user_input') return false;
  const name = toolName.split('__').at(-1) ?? toolName;
  if (['knowledge_search', 'sandbox_info', 'skill_list_attached', 'skill_read_file'].includes(name)) return false;
  return !/^(?:read|get|list|search|find|stat|inspect|describe|query|lookup|fetch)(?:_|$)/i.test(name);
}

export function hasWorkBudget(
  stepCount: number,
  maxSteps: number,
  deadlineAt: Date | null,
  now = new Date(),
) {
  return stepCount < maxSteps && (!deadlineAt || deadlineAt > now);
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('Work cancelled');
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseWorkSlot(workSessionId: string) {
  if (state.active.delete(workSessionId)) kickWorkCoordinator();
}

async function acquireWorkSlot(workSessionId: string, signal: AbortSignal) {
  while (!state.active.has(workSessionId) && state.active.size >= MAX_CONCURRENT_WORK) {
    await abortableDelay(100, signal);
  }
  if (signal.aborted) throw abortError(signal);
  state.active.add(workSessionId);
}

async function waitForApproval(approvalId: string, signal: AbortSignal): Promise<'allowed' | 'denied'> {
  while (true) {
    if (signal.aborted) throw abortError(signal);
    const approval = await db.workApproval.findUnique({
      where: { id: approvalId },
      select: { status: true },
    });
    if (!approval || approval.status === 'denied' || approval.status === 'expired') return 'denied';
    if (approval.status === 'allowed') return 'allowed';
    await abortableDelay(APPROVAL_POLL_MS, signal);
  }
}

function withApprovals(
  tools: AgentToolSet,
  work: { id: string; workspaceId: string },
  controller: AbortController,
  currentOutcome: () => WorkOutcome,
  nextToolCallId: (toolName: string) => string | undefined,
): AgentToolSet {
  const { signal } = controller;
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      if (signal.aborted) throw abortError(signal);
      if (currentOutcome().kind !== 'running') throw new Error('Work is waiting or already complete.');
      if (!requiresWorkApproval(name)) return tool.execute(args);
      const toolCallId = nextToolCallId(name) ?? crypto.randomUUID();
      const approval = await db.$transaction(async (tx) => {
        const waiting = await tx.workSession.updateMany({
          where: { id: work.id, workspaceId: work.workspaceId, status: 'running' },
          data: { status: 'waiting_approval' },
        });
        if (!waiting.count) return null;
        return tx.workApproval.create({
          data: {
            workSessionId: work.id,
            toolCallId,
            toolName: name,
            input: args as Prisma.InputJsonValue,
          },
        });
      });
      if (!approval) throw new Error('Work is no longer running.');
      releaseWorkSlot(work.id);
      const decision = await waitForApproval(approval.id, signal);
      if (decision === 'denied') {
        const error = `Approval denied for ${name}.`;
        await db.workSession.updateMany({
          where: { id: work.id, workspaceId: work.workspaceId, status: 'waiting_approval' },
          data: { status: 'failed', error, completedAt: new Date() },
        });
        controller.abort(new Error(error));
        throw new Error(error);
      }
      await acquireWorkSlot(work.id, signal);
      const resumed = await db.workSession.updateMany({
        where: { id: work.id, workspaceId: work.workspaceId, status: 'waiting_approval' },
        data: { status: 'running' },
      });
      if (resumed.count !== 1 || signal.aborted) {
        releaseWorkSlot(work.id);
        throw signal.aborted ? abortError(signal) : new Error('Work is no longer waiting for approval.');
      }
      return tool.execute(args);
    },
  }] as const));
}

function workHostTools(
  setOutcome: (outcome: WorkOutcome) => void,
  workingDirectory: string,
): AgentToolSet {
  return {
    complete_work: agentTool({
      name: 'complete_work',
      description: 'Finish the current turn after satisfying and verifying the user request.',
      parameters: Type.Object({
        summary: Type.String({ description: 'Concise result and verification summary.' }),
        artifacts: Type.Optional(Type.Array(Type.String({ description: 'Relative workspace path or /workspace path.' }))),
      }),
      execute: async ({ summary, artifacts }: { summary: string; artifacts?: string[] }) => {
        const cleanSummary = String(summary ?? '').trim().slice(0, 100_000);
        if (!cleanSummary) throw new Error('A completion summary is required.');
        const safe = filterWorkArtifacts(artifacts, workingDirectory);
        setOutcome({ kind: 'complete', summary: cleanSummary, artifacts: safe });
        return { accepted: true, artifacts: safe };
      },
    }),
    request_user_input: agentTool({
      name: 'request_user_input',
      description: 'Pause durable work when a specific user decision or missing value is required.',
      parameters: Type.Object({ question: Type.String({ description: 'One concrete question for the user.' }) }),
      execute: async ({ question }: { question: string }) => {
        const cleanQuestion = String(question ?? '').trim().slice(0, 20_000);
        if (!cleanQuestion) throw new Error('A question is required.');
        setOutcome({ kind: 'waiting_user', question: cleanQuestion });
        return { accepted: true };
      },
    }),
  };
}

function workSystemPrompt(
  workingDirectory: string,
  sandboxHarness = false,
  workspaceRoot = '/workspace',
): string {
  const displayPath = workingDirectory === '.' ? workspaceRoot : `${workspaceRoot}/${workingDirectory}`;
  return [
    'You are working in a durable multi-turn session inside an authorized sandbox.',
    `Your current working directory is ${displayPath}. Sandbox command and file tool paths are resolved relative to it.`,
    'Use the available tools to perform and verify the work. Do not merely describe commands the user should run.',
    sandboxHarness
      ? 'When the current request is satisfied and verified, return a concise result. Ask one concrete question only when user input is required.'
      : 'Call complete_work when the current user request is satisfied and verified.',
    ...(sandboxHarness ? [] : ['Call request_user_input only when a concrete user decision or missing value blocks progress.']),
    'Returning a final response completes only the current turn. The Work session remains available for later messages.',
  ].filter(Boolean).join('\n\n');
}

function latestWorkTask(messages: RuntimeMessage[], fallback: string | null): string {
  const projected = uiMessagesToPi(messages).filter((message) => message.role === 'user').at(-1);
  const content = projected?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
      : '';
  return text.trim() || fallback?.trim() || '';
}

async function resolveHermesWorkApproval(
  work: { id: string; workspaceId: string },
  controller: AbortController,
  request: HermesWorkApproval,
  toolCallId: string,
): Promise<'allow' | 'deny'> {
  const approval = await db.$transaction(async (tx) => {
    const waiting = await tx.workSession.updateMany({
      where: { id: work.id, workspaceId: work.workspaceId, status: 'running' },
      data: { status: 'waiting_approval' },
    });
    if (!waiting.count) return null;
    return tx.workApproval.create({
      data: {
        workSessionId: work.id,
        toolCallId,
        toolName: 'Hermes command',
        input: {
          command: request.command,
          description: request.description,
          patternKeys: request.patternKeys,
          choices: request.choices,
        },
      },
    });
  });
  if (!approval) throw new Error('Work is no longer running.');
  releaseWorkSlot(work.id);
  const decision = await waitForApproval(approval.id, controller.signal);
  await acquireWorkSlot(work.id, controller.signal);
  const resumed = await db.workSession.updateMany({
    where: { id: work.id, workspaceId: work.workspaceId, status: 'waiting_approval' },
    data: { status: 'running' },
  });
  if (resumed.count !== 1 || controller.signal.aborted) {
    releaseWorkSlot(work.id);
    throw controller.signal.aborted ? abortError(controller.signal) : new Error('Work is no longer waiting for approval.');
  }
  return decision === 'allowed' ? 'allow' : 'deny';
}

async function appendAssistantResult(
  conversationId: string,
  text: string,
  trace: WorkTracePart[],
  contextUsage?: ContextUsageSnapshot,
) {
  const parts: Prisma.InputJsonValue[] = [
    ...trace as unknown as Prisma.InputJsonValue[],
    ...(text ? [{ type: 'text', text, state: 'done' } as Prisma.InputJsonValue] : []),
    ...(contextUsage ? [{ type: 'data-context-usage', data: contextUsage } as Prisma.InputJsonValue] : []),
  ];
  if (!parts.length) return;
  await db.message.create({
    data: { conversationId, role: 'assistant', parts, textCharacters: text.length },
  });
}

async function executeWork(workSessionId: string) {
  const work = await db.workSession.findUnique({
    where: { id: workSessionId },
    include: {
      sandbox: { include: { deployment: true } },
      conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
    },
  });
  if (!work) {
    finishWorkOutput(workSessionId);
    return;
  }
  if (work.status === 'cancelling') {
    await db.workSession.updateMany({
      where: { id: work.id, workspaceId: work.workspaceId, status: 'cancelling' },
      data: { status: 'idle', error: null, waitingQuestion: null, completedAt: new Date() },
    });
    finishWorkOutput(work.id);
    return;
  }
  if (work.status !== 'running') {
    finishWorkOutput(work.id);
    return;
  }
  const controller = new AbortController();
  registerWorkRun(work.id, controller);
  startWorkOutput(work.id);
  publishWorkActivity(work.id, {
    id: 'runtime',
    type: 'runtime',
    status: 'running',
    runtimeKind: work.runtimeKind,
  });
  const toolTrace = new Map<string, WorkToolPart>();
  let reasoningText = '';
  let reasoningActive = false;
  let runtimeStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
  let tracePersisted = false;
  let contextUsage: ContextUsageSnapshot | undefined;

  const finishReasoning = () => {
    if (!reasoningActive) return;
    reasoningActive = false;
    publishWorkActivity(work.id, {
      id: 'reasoning',
      type: 'reasoning',
      status: 'completed',
      ...(reasoningText ? { text: reasoningText } : {}),
    });
  };
  const onActivity = (activity: SandboxRuntimeActivity) => {
    if (activity.type === 'reasoning') {
      if (activity.delta && reasoningText.length < MAX_REASONING_CHARACTERS) {
        reasoningText += activity.delta.slice(0, MAX_REASONING_CHARACTERS - reasoningText.length);
      }
      reasoningActive = activity.status === 'running';
      publishWorkActivity(work.id, {
        id: 'reasoning',
        type: 'reasoning',
        status: activity.status,
        ...(reasoningText ? { text: reasoningText } : {}),
      });
      return;
    }
    finishReasoning();
    if (!activity.toolCallId) return;
    const previous = toolTrace.get(activity.toolCallId);
    const part: WorkToolPart = {
      type: 'work-tool',
      toolCallId: activity.toolCallId,
      toolName: activity.toolName ?? previous?.toolName ?? 'Tool',
      input: activity.input === undefined ? (previous?.input ?? null) : activity.input,
      ...(activity.output === undefined ? {} : { output: activity.output }),
      isError: activity.status === 'failed' || activity.isError === true,
      status: activity.status,
    };
    toolTrace.set(activity.toolCallId, { ...previous, ...part });
    publishWorkActivity(work.id, {
      id: `tool:${activity.toolCallId}`,
      type: 'tool',
      status: activity.status,
      toolCallId: activity.toolCallId,
      toolName: part.toolName,
      input: part.input,
      ...(part.output === undefined ? {} : { output: part.output }),
      isError: part.isError,
    });
  };
  const settleUnfinishedTools = (status: 'failed' | 'cancelled') => {
    for (const [toolCallId, part] of toolTrace) {
      if (part.status !== 'running') continue;
      const settled = { ...part, status, isError: status === 'failed' };
      toolTrace.set(toolCallId, settled);
      publishWorkActivity(work.id, {
        id: `tool:${toolCallId}`,
        type: 'tool',
        status,
        toolCallId,
        toolName: settled.toolName,
        input: settled.input,
        isError: settled.isError,
      });
    }
  };
  const traceParts = (): WorkTracePart[] => {
    const parts: WorkTracePart[] = [
      ...(reasoningText ? [{ type: 'reasoning' as const, text: reasoningText, state: 'done' as const }] : []),
      ...toolTrace.values(),
    ];
    return runtimeStatus === 'completed' && parts.length
      ? parts
      : [{ type: 'work-runtime', runtimeKind: work.runtimeKind, status: runtimeStatus }, ...parts];
  };
  try {
    const stillRunning = await db.workSession.count({ where: { id: work.id, status: 'running' } });
    if (!stillRunning) return;
    if (!isWorkRuntimeKind(work.runtimeKind)) {
      throw new Error(`Unsupported Work runtime: ${work.runtimeKind}`);
    }
    if (!work.sandbox) {
      throw new Error('Work sandbox is unavailable.');
    }
    if (
      work.runtimeKind !== 'hermes'
      && effectiveStatus(work.sandbox.deploymentId, work.sandbox.deployment.status) !== 'running'
    ) {
      throw new Error('Work sandbox is not running.');
    }
    const agent = await getAgentForRun(work.agentId, work.workspaceId);
    if (!agent) throw new Error('Work Agent no longer exists.');
    if (agent.runtimeKind !== work.runtimeKind) {
      throw new Error('The Agent runtime changed after this Work session was created. Start a new Work session.');
    }
    const saved = snapshot(work.runtimeSnapshot);
    const provider = agent.provider;
    const model = agent.model;
    if (work.runtimeKind === 'hermes') {
      if (
        agent.runtime?.kind !== 'hermes'
        || agent.runtime.sandboxId !== work.sandbox.id
        || (saved.runtimeId && saved.runtimeId !== agent.runtime.id)
      ) {
        throw new Error('The Hermes runtime sandbox changed after this Work session was created. Start a new Work session.');
      }
      if (!agent.modelProviders.length) throw new Error('Hermes Work Agent has no configured model provider.');
    } else if (!provider || !model) {
      throw new Error('Work Agent has no configured model.');
    }
    const workingDirectory = normalizeWorkDirectory(saved.workingDirectory ?? '.') ?? '.';

    const resolved = resolveAgentTools(agent, work.sandboxId);
    const deploymentIds = saved.deploymentIds ? new Set(saved.deploymentIds) : null;
    const skillIds = saved.installedSkillIds ? new Set(saved.installedSkillIds) : null;
    const knowledgeBaseIds = saved.knowledgeBaseIds ? new Set(saved.knowledgeBaseIds) : null;
    resolved.deploymentIds = resolved.deploymentIds.filter((id) =>
      resolved.sandboxDeploymentIds.includes(id) || !deploymentIds || deploymentIds.has(id));
    resolved.skills = resolved.skills.filter((skill) =>
      !skillIds || skillIds.has((skill as { id?: string }).id ?? ''));
    // Work V1 cannot propagate per-tool approvals through nested Agent runs.
    resolved.subAgents = [];
    if (resolved.knowledgeBases && knowledgeBaseIds) {
      resolved.knowledgeBases = resolved.knowledgeBases.filter((link) => knowledgeBaseIds.has(link.knowledgeBase.id));
    }

    const outcome: { current: WorkOutcome } = { current: { kind: 'running' } };
    const runtimeMessages: RuntimeMessage[] = work.conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts as RuntimeMessage['parts'],
    }));
    let response: string;
    if (work.runtimeKind === 'hermes') {
      const runtimeSession = await ensureConversationRuntimeSession(
        work.workspaceId,
        work.agentId,
        work.conversationId,
      );
      if (!runtimeSession) throw new Error('Hermes Work conversation no longer exists.');
      const writeLease = acquireHermesRuntimeWriteLease(work.workspaceId, work.agentId);
      if (!writeLease) throw new Error(HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR);
      const activeTools = new Map<string, string[]>();
      const subagentTools = new Map<string, string>();
      let eventSequence = 0;
      try {
        const result = await runHermesWork({
          agent,
          task: latestWorkTask(runtimeMessages, work.task),
          instructions: workSystemPrompt(workingDirectory, true, '/opt/data/workspace'),
          workingDirectory,
          sessionId: runtimeSession.runtimeSessionId,
          sessionKey: runtimeSession.runtimeSessionKey,
          writeLease,
          signal: controller.signal,
          onRunStarted: async (runId) => {
            await db.workSession.updateMany({
              where: { id: work.id, status: 'running' },
              data: { runtimeSnapshot: { ...saved, hermesRunId: runId } },
            });
          },
          onMessageDelta: ({ delta }) => {
            finishReasoning();
            publishWorkOutput(work.id, delta);
          },
          onReasoningAvailable: ({ text }) => {
            if (text) onActivity({ type: 'reasoning', status: 'running', delta: `${text}\n` });
          },
          onToolStarted: ({ runId, tool, preview }) => {
            const toolName = tool || 'Hermes tool';
            const toolCallId = `hermes:${runId}:tool:${++eventSequence}`;
            activeTools.set(toolName, [...(activeTools.get(toolName) ?? []), toolCallId]);
            onActivity({
              type: 'tool',
              status: 'running',
              toolCallId,
              toolName,
              input: preview ? { preview } : null,
            });
          },
          onToolCompleted: ({ runId, tool, duration, error }) => {
            const toolName = tool || 'Hermes tool';
            const pending = activeTools.get(toolName) ?? [];
            const toolCallId = pending.shift() ?? `hermes:${runId}:tool:${++eventSequence}`;
            activeTools.set(toolName, pending);
            onActivity({
              type: 'tool',
              status: error ? 'failed' : 'completed',
              toolCallId,
              toolName,
              output: { durationSeconds: duration },
              isError: error,
            });
          },
          onSubagent: (event) => {
            const key = event.childSessionId || event.subagentId || String(event.taskIndex ?? eventSequence + 1);
            const toolCallId = event.event === 'subagent.start'
              ? `hermes:${event.runId}:subagent:${++eventSequence}`
              : subagentTools.get(key) ?? `hermes:${event.runId}:subagent:${++eventSequence}`;
            if (event.event === 'subagent.start') subagentTools.set(key, toolCallId);
            else subagentTools.delete(key);
            onActivity({
              type: 'tool',
              status: event.event === 'subagent.start' ? 'running' : event.status === 'failed' ? 'failed' : 'completed',
              toolCallId,
              toolName: 'delegate_task',
              input: event.event === 'subagent.start' ? { goal: event.goal ?? event.preview ?? '' } : undefined,
              output: event.event === 'subagent.complete'
                ? { status: event.status, summary: event.summary, output: event.outputTail }
                : undefined,
              isError: event.status === 'failed',
            });
          },
          onApproval: async (request) => {
            const toolCallId = `hermes:${request.runId}:approval:${++eventSequence}`;
            onActivity({
              type: 'tool',
              status: 'running',
              toolCallId,
              toolName: 'Hermes approval',
              input: { command: request.command, description: request.description },
            });
            const decision = await resolveHermesWorkApproval(work, controller, request, toolCallId);
            onActivity({
              type: 'tool',
              status: 'completed',
              toolCallId,
              toolName: 'Hermes approval',
              output: { decision },
              isError: decision === 'deny',
            });
            return decision;
          },
        });
        if (result.status === 'failed') throw new Error(result.error || 'Hermes run failed.');
        if (result.status === 'cancelled') throw new Error('Hermes run was cancelled.');
        response = result.text;
      } finally {
        writeLease.release();
      }
    } else if (isDedicatedSandboxRuntimeKind(work.runtimeKind)) {
      const system = [
        saved.systemPrompt ?? agent.systemPrompt,
        workSystemPrompt(workingDirectory, true),
      ].filter(Boolean).join('\n\n---\n\n');
      response = await runDedicatedSandboxTurn({
        agent,
        sandboxId: work.sandbox.id,
        systemPrompt: system,
        messages: runtimeMessages,
        skills: resolved.skills,
        deploymentIds: resolved.deploymentIds.filter((id) => !resolved.sandboxDeploymentIds.includes(id)),
        workingDirectory,
        signal: controller.signal,
        onTextDelta: (delta) => {
          finishReasoning();
          publishWorkOutput(work.id, delta);
        },
        onActivity,
        onContextUsage: (usage) => { contextUsage = usage; },
      });
    } else {
      if (!provider || !model) throw new Error('Work Agent has no configured model.');
      const calls = new Map<string, ToolCall[]>();
      const baseTools = await buildAgentToolSet(resolved, {
        workspaceId: work.workspaceId,
        depth: 0,
        visited: new Set([work.agentId]),
      });
      const approvedTools = withApprovals(
        { ...baseTools, ...workHostTools((next) => { outcome.current = next; }, workingDirectory) },
        work,
        controller,
        () => outcome.current,
        (toolName) => calls.get(toolName)?.shift()?.id,
      );
      const tools = withWorkingDirectory(
        approvedTools,
        work.sandbox.deploymentId,
        workingDirectory,
      );
      const system = [
        assembleSystemPrompt(saved.systemPrompt ?? agent.systemPrompt, resolved.skills, Boolean(resolved.knowledgeBases?.length)),
        workSystemPrompt(workingDirectory),
      ].filter(Boolean).join('\n\n---\n\n');
      response = await runNativeAgent({
        provider,
        modelId: model,
        systemPrompt: system,
        messages: uiMessagesToPi(runtimeMessages),
        tools,
        maxSteps: saved.agentMaxSteps ?? agent.maxSteps,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'toolcall_end') {
            calls.set(event.toolCall.name, [...(calls.get(event.toolCall.name) ?? []), event.toolCall]);
          }
        },
        onToolResult: async (toolCall, output, isError) => {
          await appendAssistantResult(work.conversationId, '', [{
            type: 'work-tool',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.arguments,
            output,
            isError,
            status: isError ? 'failed' : 'completed',
          }]);
        },
      });
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    const finalOutcome = outcome.current;
    const fallbackText = !response.trim() && finalOutcome.kind !== 'running'
      ? finalOutcome.kind === 'waiting_user' ? finalOutcome.question : finalOutcome.summary
      : response.trim();
    finishReasoning();
    settleUnfinishedTools('failed');
    publishWorkActivity(work.id, {
      id: 'runtime',
      type: 'runtime',
      status: 'completed',
      runtimeKind: work.runtimeKind,
    });
    await appendAssistantResult(work.conversationId, fallbackText, traceParts(), contextUsage);
    tracePersisted = true;
    if (finalOutcome.kind === 'complete') {
      await db.workSession.updateMany({
        where: { id: work.id, status: 'running' },
        data: {
          status: 'idle',
          result: finalOutcome.summary,
          artifacts: finalOutcome.artifacts,
          error: null,
          waitingQuestion: null,
          completedAt: new Date(),
        },
      });
    } else if (finalOutcome.kind === 'waiting_user') {
      await db.workSession.updateMany({
        where: { id: work.id, status: 'running' },
        data: { status: 'waiting_user', waitingQuestion: finalOutcome.question },
      });
    } else {
      await db.workSession.updateMany({
        where: { id: work.id, status: 'running' },
        data: {
          status: 'idle',
          result: null,
          error: null,
          waitingQuestion: null,
          completedAt: new Date(),
        },
      });
    }
  } catch (error) {
    runtimeStatus = controller.signal.aborted ? 'cancelled' : 'failed';
    finishReasoning();
    settleUnfinishedTools(runtimeStatus);
    publishWorkActivity(work.id, {
      id: 'runtime',
      type: 'runtime',
      status: runtimeStatus,
      runtimeKind: work.runtimeKind,
    });
    if (!tracePersisted) {
      try {
        await appendAssistantResult(work.conversationId, '', traceParts(), contextUsage);
        tracePersisted = true;
      } catch (traceError) {
        console.error(`[work] ${work.id} activity persistence failed`, traceError);
      }
    }
    if (!controller.signal.aborted) {
      await db.workSession.updateMany({
        where: { id: workSessionId, status: { in: ['running', 'waiting_approval'] } },
        data: {
          status: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          completedAt: new Date(),
        },
      });
    }
  } finally {
    unregisterWorkRun(workSessionId, controller);
    try {
      await db.workSession.updateMany({
        where: { id: workSessionId, status: 'cancelling' },
        data: { status: 'idle', error: null, waitingQuestion: null, completedAt: new Date() },
      });
    } finally {
      finishWorkOutput(workSessionId);
    }
  }
}

async function runClaimedWork(workSessionId: string) {
  try {
    await executeWork(workSessionId);
  } catch (error) {
    console.error(`[work] ${workSessionId} execution failed`, error);
  } finally {
    state.active.delete(workSessionId);
    kickWorkCoordinator();
  }
}

async function claimNextWork(): Promise<string | null> {
  while (true) {
    const work = await db.workSession.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, stepCount: true, maxSteps: true, deadlineAt: true, startedAt: true },
    });
    if (!work) return null;
    if (!hasWorkBudget(work.stepCount, work.maxSteps, work.deadlineAt)) {
      await db.workSession.updateMany({
        where: { id: work.id, status: 'queued' },
        data: {
          status: 'failed',
          error: work.stepCount >= work.maxSteps ? 'Work step budget exhausted.' : 'Work deadline exceeded.',
          completedAt: new Date(),
        },
      });
      finishWorkOutput(work.id);
      continue;
    }
    const claimed = await db.workSession.updateMany({
      where: { id: work.id, status: 'queued', stepCount: work.stepCount },
      data: {
        status: 'running',
        stepCount: { increment: 1 },
        error: null,
        waitingQuestion: null,
        ...(!work.startedAt ? { startedAt: new Date() } : {}),
      },
    });
    if (claimed.count) return work.id;
  }
}

async function drainWorkQueue() {
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.active.size < MAX_CONCURRENT_WORK) {
      const workSessionId = await claimNextWork();
      if (!workSessionId) break;
      state.active.add(workSessionId);
      void runClaimedWork(workSessionId)
        .catch((error) => console.error(`[work] ${workSessionId} finalization failed`, error));
    }
  } finally {
    state.draining = false;
  }
}

export function kickWorkCoordinator() {
  void drainWorkQueue().catch((error) => console.error('[work] queue drain failed', error));
}

async function stopInterruptedHermesRuns() {
  const interrupted = await db.workSession.findMany({
    where: { runtimeKind: 'hermes', status: { in: ['running', 'waiting_approval', 'cancelling'] } },
    select: {
      runtimeSnapshot: true,
      agent: { select: { id: true, workspaceId: true, runtime: { select: { id: true, kind: true } } } },
    },
  });
  await Promise.all(interrupted.map(async (work) => {
    const runId = snapshot(work.runtimeSnapshot).hermesRunId?.trim();
    if (runId) await stopHermesWorkRun({ agent: work.agent, runId });
  }));
}

export async function startWorkCoordinator() {
  if (!state.reconciled) {
    const now = new Date();
    await stopInterruptedHermesRuns();
    await db.$transaction(async (tx) => {
      await tx.workApproval.updateMany({
        where: { status: 'pending', workSession: { status: 'waiting_approval' } },
        data: { status: 'expired', resolvedAt: now },
      });
      await tx.workSession.updateMany({
        where: { status: { in: ['running', 'waiting_approval'] } },
        data: {
          status: 'failed',
          error: 'Work was interrupted by a server restart. Review the transcript, then resume it.',
          completedAt: now,
        },
      });
      await tx.workSession.updateMany({
        where: { status: 'cancelling' },
        data: { status: 'idle', error: null, waitingQuestion: null, completedAt: now },
      });
    });
    state.reconciled = true;
  }
  // ponytail: single-node poller; add Postgres leases only when a second runtime worker exists.
  if (!state.timer) {
    state.timer = setInterval(kickWorkCoordinator, 1_000);
    state.timer.unref?.();
  }
  kickWorkCoordinator();
}
