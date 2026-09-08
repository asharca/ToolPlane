import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

export type LogContext = {
  requestId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  actorId?: string;
  workspaceId?: string;
  deploymentId?: string;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  channelId?: string;
  providerId?: string;
  model?: string;
  secrets?: readonly string[];
  suppressPayload?: boolean;
};

const globalLog = globalThis as unknown as { logContext?: AsyncLocalStorage<LogContext> };
const storage = globalLog.logContext ??= new AsyncLocalStorage<LogContext>();
export const newSpanId = () => randomBytes(8).toString('hex');
export const newRequestId = () => randomUUID();
export const getLogContext = () => storage.getStore();

export function withLogContext<T>(context: Partial<LogContext>, fn: () => T, detached = false): T {
  const parent = detached ? undefined : storage.getStore();
  const identities: Partial<LogContext> = {};
  for (const key of ['requestId', 'traceId', 'spanId', 'parentSpanId', 'actorId', 'workspaceId', 'deploymentId', 'agentId', 'runId', 'conversationId', 'channelId', 'providerId', 'model'] as const) {
    if (context[key] !== undefined) identities[key] = context[key];
  }
  return storage.run({
    ...parent,
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    parentSpanId: parent?.spanId,
    spanId: newSpanId(),
    ...identities,
    suppressPayload: context.suppressPayload ?? parent?.suppressPayload,
    secrets: [...(parent?.secrets ?? []), ...(context.secrets ?? [])],
  }, fn);
}

// Only call with identities resolved by the server's existing authorization flow.
export function enrichLogContext(context: Partial<LogContext>) {
  const current = storage.getStore();
  if (current) Object.assign(current, context, context.secrets ? { secrets: [...(current.secrets ?? []), ...context.secrets] } : {});
}
