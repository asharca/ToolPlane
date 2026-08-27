import 'server-only';
import { posix } from 'node:path';
import {
  ensureHermesRuntimeReady,
  type HermesRuntimeWriteLease,
} from './runtime';

export type HermesWorkAgent = {
  id: string;
  workspaceId: string;
  runtime: { id: string; kind: string } | null;
};

type MaybePromise<T> = T | Promise<T>;

export type HermesWorkMessageDelta = {
  runId: string;
  timestamp: number;
  delta: string;
};

export type HermesWorkReasoning = {
  runId: string;
  timestamp: number;
  text: string;
};

export type HermesWorkToolStarted = {
  runId: string;
  timestamp: number;
  tool: string;
  preview?: string;
};

export type HermesWorkToolCompleted = {
  runId: string;
  timestamp: number;
  tool: string;
  duration: number;
  error: boolean;
};

export type HermesWorkSubagent = {
  event: 'subagent.start' | 'subagent.complete';
  runId: string;
  timestamp: number;
  preview?: string;
  goal?: string;
  taskCount?: number;
  taskIndex?: number;
  subagentId?: string;
  childSessionId?: string;
  parentId?: string;
  depth?: number;
  model?: string;
  toolCount?: number;
  status?: string;
  summary?: string;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  apiCalls?: number;
  costUsd?: number;
  filesRead?: number;
  filesWritten?: number;
  outputTail?: string;
};

export type HermesWorkApproval = {
  runId: string;
  timestamp: number;
  command: string;
  description: string;
  patternKey?: string;
  patternKeys: string[];
  choices: string[];
  allowPermanent: boolean;
  allowSession: boolean;
  smartDenied: boolean;
};

export type HermesWorkRunTerminal =
  | {
    event: 'run.completed';
    runId: string;
    timestamp: number;
    output: string;
    usage?: HermesWorkUsage;
  }
  | {
    event: 'run.failed';
    runId: string;
    timestamp: number;
    error: string;
  }
  | {
    event: 'run.cancelled';
    runId: string;
    timestamp: number;
  };

export type HermesWorkUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type HermesWorkRunResult = {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  error?: string;
  usage?: HermesWorkUsage;
};

export type RunHermesWorkParams = {
  agent: HermesWorkAgent;
  task: string;
  instructions?: string;
  workingDirectory: string;
  sessionId: string;
  sessionKey: string;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  timeoutMs?: number;
  onRunStarted?: (runId: string) => MaybePromise<void>;
  onMessageDelta?: (event: HermesWorkMessageDelta) => MaybePromise<void>;
  onReasoningAvailable?: (event: HermesWorkReasoning) => MaybePromise<void>;
  onToolStarted?: (event: HermesWorkToolStarted) => MaybePromise<void>;
  onToolCompleted?: (event: HermesWorkToolCompleted) => MaybePromise<void>;
  onSubagent?: (event: HermesWorkSubagent) => MaybePromise<void>;
  onApproval?: (event: HermesWorkApproval) => MaybePromise<'allow' | 'deny'>;
  onRunTerminal?: (event: HermesWorkRunTerminal) => MaybePromise<void>;
};

type RawEvent = Record<string, unknown> & { event?: unknown };

const HERMES_WORKSPACE = '/opt/data/workspace';
const REQUIRED_RUN_FEATURES = [
  'run_submission',
  'run_events_sse',
  'run_stop',
  'run_approval_response',
] as const;

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function workingDirectory(value: string): string {
  const input = value.trim().replace(/\\/g, '/');
  const relative = input === '.' || input === '/workspace' || input === HERMES_WORKSPACE
    ? '.'
    : input.startsWith('/workspace/')
      ? input.slice('/workspace/'.length)
      : input.startsWith(`${HERMES_WORKSPACE}/`)
        ? input.slice(HERMES_WORKSPACE.length + 1)
        : input;
  if (!relative || relative.includes('\0') || relative.startsWith('/')) {
    throw new Error('Invalid Hermes working directory.');
  }
  const resolved = posix.resolve(HERMES_WORKSPACE, relative);
  if (resolved !== HERMES_WORKSPACE && !resolved.startsWith(`${HERMES_WORKSPACE}/`)) {
    throw new Error('Hermes working directory must stay inside its workspace.');
  }
  return resolved;
}

function requestInstructions(directory: string, instructions?: string): string {
  return [
    instructions?.trim(),
    `The working directory for this task is ${directory}. Perform and verify the requested work there.`,
  ].filter(Boolean).join('\n\n');
}

function headers(sessionId: string, sessionKey: string, json = false): HeadersInit {
  return {
    ...(json ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' }),
    'x-hermes-session-id': sessionId,
    'x-hermes-session-key': sessionKey,
  };
}

async function responseError(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => '')).trim().slice(0, 1_000);
  return new Error(text || `Hermes runtime returned ${response.status}.`);
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function postRunAction(
  baseUrl: string,
  runId: string,
  action: 'approval' | 'stop',
  sessionId: string,
  sessionKey: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: headers(sessionId, sessionKey, true),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
}

async function readSse(
  response: Response,
  handle: (event: RawEvent) => Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error('Hermes runtime returned an empty event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = async (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const parsed = JSON.parse(data) as RawEvent;
    if (parsed && typeof parsed === 'object') await handle(parsed);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        await consume(block);
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
    if (buffer.trim()) await consume(buffer);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function usage(value: unknown): HermesWorkUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    inputTokens: number(raw.input_tokens),
    outputTokens: number(raw.output_tokens),
    totalTokens: number(raw.total_tokens),
  };
}

function terminalFromStatus(runId: string, value: Record<string, unknown>): HermesWorkRunTerminal | null {
  const status = string(value.status);
  const timestamp = number(value.updated_at) || Date.now() / 1_000;
  if (status === 'completed') {
    return { event: 'run.completed', runId, timestamp, output: string(value.output), usage: usage(value.usage) };
  }
  if (status === 'failed') {
    return { event: 'run.failed', runId, timestamp, error: string(value.error) || 'Hermes run failed.' };
  }
  if (status === 'cancelled') return { event: 'run.cancelled', runId, timestamp };
  return null;
}

function result(terminal: HermesWorkRunTerminal, streamedText: string): HermesWorkRunResult {
  if (terminal.event === 'run.completed') {
    return {
      runId: terminal.runId,
      status: 'completed',
      text: terminal.output || streamedText,
      ...(terminal.usage ? { usage: terminal.usage } : {}),
    };
  }
  if (terminal.event === 'run.failed') {
    return { runId: terminal.runId, status: 'failed', text: streamedText, error: terminal.error };
  }
  return { runId: terminal.runId, status: 'cancelled', text: streamedText };
}

export async function runHermesWork(params: RunHermesWorkParams): Promise<HermesWorkRunResult> {
  if (!params.agent.runtime || params.agent.runtime.kind !== 'hermes') {
    throw new Error('Hermes runtime is not configured.');
  }
  const task = params.task.trim();
  const sessionId = params.sessionId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!task) throw new Error('Hermes Work requires a task.');
  if (!sessionId || !sessionKey) throw new Error('Hermes Work requires a session ID and key.');

  const signal = combinedSignal(params.signal, params.timeoutMs ?? 60 * 60_000);
  const ready = await ensureHermesRuntimeReady(params.agent.workspaceId, params.agent.id, {
    writeLease: params.writeLease,
    signal,
  });
  if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');
  const baseUrl = `http://127.0.0.1:${ready.port}/hermes`;
  let runId = '';
  let terminal: HermesWorkRunTerminal | null = null;
  let text = '';

  try {
    const capabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: headers(sessionId, sessionKey, true),
      signal,
      cache: 'no-store',
    });
    if (capabilitiesResponse.status === 404) {
      throw new Error('Hermes Work requires runtime v0.20.0 or newer. Upgrade this Agent\'s Hermes image.');
    }
    if (!capabilitiesResponse.ok) throw await responseError(capabilitiesResponse);
    const capabilities = await capabilitiesResponse.json() as { features?: Record<string, unknown> };
    const missingFeatures = REQUIRED_RUN_FEATURES.filter((feature) => capabilities.features?.[feature] !== true);
    if (missingFeatures.length) {
      throw new Error(
        `Hermes Work requires runtime v0.20.0 or newer. Upgrade this Agent's Hermes image (missing: ${missingFeatures.join(', ')}).`,
      );
    }

    const start = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: headers(sessionId, sessionKey, true),
      body: JSON.stringify({
        input: task,
        instructions: requestInstructions(workingDirectory(params.workingDirectory), params.instructions),
        session_id: sessionId,
      }),
      signal,
      cache: 'no-store',
    });
    if (!start.ok) throw await responseError(start);
    const started = await start.json() as { run_id?: unknown };
    runId = string(started.run_id);
    if (!runId) throw new Error('Hermes runtime did not return a run ID.');
    await params.onRunStarted?.(runId);

    const events = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: headers(sessionId, sessionKey),
      signal,
      cache: 'no-store',
    });
    if (!events.ok) throw await responseError(events);
    await readSse(events, async (raw) => {
      const event = string(raw.event);
      const timestamp = number(raw.timestamp);
      if (event === 'message.delta') {
        const delta = string(raw.delta);
        text += delta;
        if (delta) await params.onMessageDelta?.({ runId, timestamp, delta });
      } else if (event === 'reasoning.available') {
        await params.onReasoningAvailable?.({ runId, timestamp, text: string(raw.text) });
      } else if (event === 'tool.started') {
        await params.onToolStarted?.({
          runId,
          timestamp,
          tool: string(raw.tool),
          ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
        });
      } else if (event === 'tool.completed') {
        await params.onToolCompleted?.({
          runId,
          timestamp,
          tool: string(raw.tool),
          duration: number(raw.duration),
          error: raw.error === true,
        });
      } else if (event === 'subagent.start' || event === 'subagent.complete') {
        await params.onSubagent?.({
          event,
          runId,
          timestamp,
          ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
          ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
          ...(typeof raw.task_count === 'number' ? { taskCount: raw.task_count } : {}),
          ...(typeof raw.task_index === 'number' ? { taskIndex: raw.task_index } : {}),
          ...(typeof raw.subagent_id === 'string' ? { subagentId: raw.subagent_id } : {}),
          ...(typeof raw.child_session_id === 'string' ? { childSessionId: raw.child_session_id } : {}),
          ...(typeof raw.parent_id === 'string' ? { parentId: raw.parent_id } : {}),
          ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
          ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
          ...(typeof raw.tool_count === 'number' ? { toolCount: raw.tool_count } : {}),
          ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
          ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
          ...(typeof raw.duration_seconds === 'number' ? { durationSeconds: raw.duration_seconds } : {}),
          ...(typeof raw.input_tokens === 'number' ? { inputTokens: raw.input_tokens } : {}),
          ...(typeof raw.output_tokens === 'number' ? { outputTokens: raw.output_tokens } : {}),
          ...(typeof raw.reasoning_tokens === 'number' ? { reasoningTokens: raw.reasoning_tokens } : {}),
          ...(typeof raw.api_calls === 'number' ? { apiCalls: raw.api_calls } : {}),
          ...(typeof raw.cost_usd === 'number' ? { costUsd: raw.cost_usd } : {}),
          ...(typeof raw.files_read === 'number' ? { filesRead: raw.files_read } : {}),
          ...(typeof raw.files_written === 'number' ? { filesWritten: raw.files_written } : {}),
          ...(typeof raw.output_tail === 'string' ? { outputTail: raw.output_tail } : {}),
        });
      } else if (event === 'approval.request') {
        const approval: HermesWorkApproval = {
          runId,
          timestamp,
          command: string(raw.command),
          description: string(raw.description),
          ...(typeof raw.pattern_key === 'string' ? { patternKey: raw.pattern_key } : {}),
          patternKeys: strings(raw.pattern_keys),
          choices: strings(raw.choices),
          allowPermanent: raw.allow_permanent === true,
          allowSession: raw.allow_session === true,
          smartDenied: raw.smart_denied === true,
        };
        const choice = params.onApproval
          ? await awaitWithSignal(Promise.resolve(params.onApproval(approval)), signal)
          : 'deny';
        const response = await postRunAction(
          baseUrl,
          runId,
          'approval',
          sessionId,
          sessionKey,
          { choice: choice === 'allow' ? 'once' : 'deny' },
        );
        if (!response.ok) throw await responseError(response);
      } else if (event === 'run.completed') {
        terminal = {
          event,
          runId,
          timestamp,
          output: string(raw.output),
          usage: usage(raw.usage),
        };
        await params.onRunTerminal?.(terminal);
      } else if (event === 'run.failed') {
        terminal = { event, runId, timestamp, error: string(raw.error) || 'Hermes run failed.' };
        await params.onRunTerminal?.(terminal);
      } else if (event === 'run.cancelled') {
        terminal = { event, runId, timestamp };
        await params.onRunTerminal?.(terminal);
      }
    });

    if (!terminal) {
      const statusResponse = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        headers: headers(sessionId, sessionKey, true),
        signal,
        cache: 'no-store',
      });
      if (!statusResponse.ok) throw await responseError(statusResponse);
      const status = await statusResponse.json() as Record<string, unknown>;
      terminal = terminalFromStatus(runId, status);
      if (terminal) await params.onRunTerminal?.(terminal);
    }
    if (!terminal) throw new Error('Hermes run event stream ended before the run reached a terminal state.');
    return result(terminal, text);
  } catch (error) {
    if (runId && !terminal) {
      await postRunAction(baseUrl, runId, 'stop', sessionId, sessionKey).catch(() => undefined);
    }
    throw error;
  }
}

/** Best-effort cleanup for reconciliation; Hermes' stop endpoint needs API auth only. */
export async function stopHermesWorkRun(params: {
  agent: HermesWorkAgent;
  runId: string;
  writeLease?: HermesRuntimeWriteLease;
  timeoutMs?: number;
}): Promise<boolean> {
  const runId = params.runId.trim();
  if (!runId || !params.agent.runtime || params.agent.runtime.kind !== 'hermes') return false;
  try {
    const signal = AbortSignal.timeout(params.timeoutMs ?? 15_000);
    const ready = await ensureHermesRuntimeReady(params.agent.workspaceId, params.agent.id, {
      writeLease: params.writeLease,
      signal,
    });
    if (!ready.port) return false;
    const response = await fetch(
      `http://127.0.0.1:${ready.port}/hermes/v1/runs/${encodeURIComponent(runId)}/stop`,
      { method: 'POST', signal, cache: 'no-store' },
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
