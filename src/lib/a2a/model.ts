import { Artifact, Message, Role, StreamResponse, Task, TaskStatus, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotCancelableError, UnsupportedOperationError } from '@a2a-js/sdk/errors';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_SDK_VERSION = '1.2.0';
export const LOCAL_OUTPUT_MODES = ['text/plain', 'text/markdown', 'text/x-diff', 'application/json', 'application/octet-stream'];
export const acceptsOutput = (modes: readonly string[], mediaType: string) => !modes.length || modes.some((mode) => mode === '*/*' || mode === mediaType || mode === mediaType.split('/')[0] + '/*');
// ponytail: only character/byte limits read env; counters stay fixed because
// nothing tunes them yet. Widen when an operator actually asks.
const DEFAULT_A2A_LIMITS = {
  bodyBytes: 262_144, inputCharacters: 20_000, outputCharacters: 65_536,
  snapshotBytes: 524_288, publishArtifactBytes: 32_768, messagesPerTask: 32, artifactsPerTask: 16,
  tasksPerContext: 128, contextsPerClient: 100, tasksPerClient: 1_000,
  workerConcurrency: 4, deadlineSeconds: 840, pollMs: 250,
} as const;
type A2ALimitField = keyof typeof DEFAULT_A2A_LIMITS;
type A2ALimits = Record<A2ALimitField, number>;
const ENV_A2A_LIMIT_KEYS = {
  bodyBytes: 'TOOLPLANE_A2A_BODY_BYTES',
  inputCharacters: 'TOOLPLANE_A2A_INPUT_CHARACTERS',
  outputCharacters: 'TOOLPLANE_A2A_OUTPUT_CHARACTERS',
  snapshotBytes: 'TOOLPLANE_A2A_SNAPSHOT_BYTES',
  publishArtifactBytes: 'TOOLPLANE_A2A_PUBLISH_ARTIFACT_BYTES',
} as const satisfies Partial<Record<keyof A2ALimits, string>>;
function positiveSafeInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function resolveA2ALimits(): A2ALimits {
  const limits: A2ALimits = { ...DEFAULT_A2A_LIMITS };
  for (const entry of Object.entries(ENV_A2A_LIMIT_KEYS) as [keyof typeof ENV_A2A_LIMIT_KEYS, string][]) {
    const raw = process.env[entry[1]];
    const configured = positiveSafeInteger(raw);
    if (raw && !configured) throw new Error(`Invalid ${entry[1]}.`);
    if (configured) limits[entry[0]] = configured;
  }
  return limits;
}
export const A2A_LIMITS: Readonly<A2ALimits> = resolveA2ALimits();
export const TERMINAL = [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED];
export const INTERRUPTED = [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED];
export const ACTIVE = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];
export const terminal = (state: TaskState) => TERMINAL.includes(state);
export const settled = (state: TaskState) => terminal(state) || INTERRUPTED.includes(state);

export function assertTransition(from: TaskState, to: TaskState) {
  const states = [...ACTIVE, ...TERMINAL, ...INTERRUPTED];
  if (!states.includes(from) || !states.includes(to)) throw new UnsupportedOperationError('Unrecognized task state.');
  if (terminal(from)) throw new UnsupportedOperationError('A terminal task cannot be changed. Submit a new task.');
  const allowed = from === TaskState.TASK_STATE_SUBMITTED
    ? [TaskState.TASK_STATE_WORKING, ...TERMINAL]
    : from === TaskState.TASK_STATE_WORKING ? [...TERMINAL, ...INTERRUPTED]
    : [...TERMINAL, TaskState.TASK_STATE_SUBMITTED];
  if (!allowed.includes(to)) throw new UnsupportedOperationError('Invalid task state transition.');
}
export function assertCancelable(task: Task) {
  if (terminal(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) throw new TaskNotCancelableError();
}
export function historyView(task: Task, length?: number, includeArtifacts = true): Task {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new RequestMalformedError('historyLength must be non-negative.');
  const result = structuredClone(task);
  if (length !== undefined) result.history = length === 0 ? [] : result.history.slice(-length);
  if (!includeArtifacts) result.artifacts = [];
  return result;
}
export function statusEvent(task: Task): StreamResponse {
  return StreamResponse.fromJSON({ statusUpdate: {
    taskId: task.id, contextId: task.contextId, status: task.status ? TaskStatus.toJSON(task.status) : undefined,
  } });
}
export function taskEvent(task: Task): StreamResponse {
  return StreamResponse.fromJSON({ task: Task.toJSON(task) });
}
export function agentMessage(task: Task, text: string): Message {
  return Message.fromJSON({ messageId: crypto.randomUUID(), contextId: task.contextId,
    taskId: task.id, role: Role.ROLE_AGENT, parts: [{ text }] });
}
export function textArtifact(text: string): Artifact {
  return Artifact.fromJSON({ artifactId: crypto.randomUUID(), name: 'result',
    parts: [{ mediaType: 'text/plain', text }] });
}
/** Database and wire payloads always go through official ProtoJSON serializers. */
export function jsonTask(task: Task) { return Task.toJSON(task) as Record<string, unknown>; }
export function jsonEvent(event: StreamResponse) { return StreamResponse.toJSON(event) as Record<string, unknown>; }
