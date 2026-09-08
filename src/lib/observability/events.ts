import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getLogContext, withLogContext, type LogContext } from './context';
import { redactText, sanitizeLog } from './redaction';
import { getLogSettings } from './settings';
import { version } from '../../../package.json';

export type LogOutcome = 'success' | 'error' | 'timeout' | 'cancelled' | 'denied';
export type LogEntry = Partial<Omit<LogContext, 'secrets'>> & {
  domain: 'http' | 'mcp' | 'agent' | 'runtime' | 'channel' | 'plugin' | 'system';
  eventName: string;
  message?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  outcome?: LogOutcome;
  occurredAt?: Date;
  durationMs?: number;
  method?: string;
  path?: string;
  httpStatus?: number;
  rpcMethod?: string;
  toolName?: string;
  errorCode?: string;
  error?: unknown;
  attributes?: unknown;
  detail?: unknown;
  secrets?: readonly string[];
};

const state = globalThis as unknown as { logHealth?: { pending: number; failures: number; dropped: number; lastSuccess: string | null } };
export const logHealth = state.logHealth ??= { pending: 0, failures: 0, dropped: 0, lastSuccess: null };

export function errorOutcome(error: unknown): LogOutcome {
  return error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
    : error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error';
}

export async function recordEvent(entry: LogEntry): Promise<void> {
  try { await persistEvent(entry); } catch {
    logHealth.failures += 1;
    emit('{"eventName":"logging.write_failed","level":"error"}');
  }
}

function emit(line: string) {
  try {
    if (process.stderr.writableLength < 1_048_576) process.stderr.write(`${line}\n`);
  } catch { /* Logging must not interrupt a business request, even with a closed stderr. */ }
}

async function persistEvent(entry: LogEntry): Promise<void> {
  if (!getLogContext()) return withLogContext({}, () => recordEvent(entry));
  const { secrets: contextSecrets, suppressPayload: contextSuppressPayload, ...context } = getLogContext()!;
  const { error, attributes, detail, secrets: extraSecrets, suppressPayload, ...fields } = entry;
  const secrets = [...(contextSecrets ?? []), ...(extraSecrets ?? [])];
  const occurredAt = entry.occurredAt ?? new Date();
  const outcome = fields.outcome ?? (error ? errorOutcome(error) : 'success');
  const errorType = error instanceof Error ? error.name : error ? 'Error' : undefined;
  const safe = sanitizeLog({ ...context, ...fields,
    message: fields.message ?? (error instanceof Error ? error.message : fields.eventName),
    outcome, level: fields.level ?? (outcome === 'success' || outcome === 'cancelled' ? 'info' : 'error'),
    errorType,
    errorCode: fields.errorCode ?? (error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined),
  }, secrets, 8192).data as Record<string, unknown>;
  if (!safe || typeof safe !== 'object') throw new Error('Log metadata exceeds limit');
  safe.message = redactText(String(safe.message ?? entry.eventName), secrets).slice(0, 1024);
  const safeAttributes = sanitizeLog({ data: attributes ?? {}, instance: process.pid, version }, secrets, 4096).data;
  const fallback = { ...safe, occurredAt: occurredAt.toISOString(), attributes: safeAttributes, ...(error ? { error: sanitizeLog(error, secrets).data } : {}) };
  // All output is already sanitized. Never use console here (it can be captured).
  emit(JSON.stringify(fallback));
  if (logHealth.pending >= 32) {
    logHealth.dropped += 1;
    emit('{"eventName":"logging.dropped","reason":"backpressure"}');
    return;
  }
  logHealth.pending += 1;
  try {
    const settings = await getLogSettings();
    await db.$transaction(async (tx) => {
      if (!safe.workspaceId) {
        const resource = typeof safe.deploymentId === 'string' ? await tx.deployment.findUnique({ where: { id: safe.deploymentId }, select: { workspaceId: true } })
          : typeof safe.agentId === 'string' ? await tx.agent.findUnique({ where: { id: safe.agentId }, select: { workspaceId: true } })
          : typeof safe.channelId === 'string' ? await tx.agentChannelConnection.findUnique({ where: { id: safe.channelId }, select: { workspaceId: true } }) : null;
        if (resource) safe.workspaceId = resource.workspaceId;
      }
      const capture = !(contextSuppressPayload || suppressPayload) && settings.captures.some((item) => new Date(item.expiresAt).getTime() > Date.now() && safe[item.field] === item.id);
      const details = sanitizeLog({ ...(error ? { error } : {}), ...(capture && detail !== undefined ? { payload: detail } : {}) }, secrets);
      const hasDetail = Boolean(error) || (capture && detail !== undefined);
      await tx.logEvent.create({ data: {
        ...safe,
        domain: String(safe.domain), eventName: String(safe.eventName).slice(0, 128),
        message: String(safe.message), traceId: String(safe.traceId), spanId: String(safe.spanId),
        occurredAt,
        attributes: safeAttributes as Prisma.InputJsonValue,
        ...(hasDetail ? { detail: { create: {
          data: details.data as Prisma.InputJsonValue,
          truncated: details.truncated,
          expiresAt: new Date(Date.now() + settings.detailDays * 86_400_000),
        } } } : {}),
      } });
    }, { maxWait: 500, timeout: 1500 });
    logHealth.lastSuccess = new Date().toISOString();
  } finally { logHealth.pending -= 1; }
}

export async function observe<T>(entry: LogEntry, run: () => Promise<T>): Promise<T> {
  return withLogContext(entry, async () => {
    const start = performance.now();
    await recordEvent({ ...entry, eventName: `${entry.eventName}.started` });
    try {
      const result = await run();
      await recordEvent({ ...entry, eventName: `${entry.eventName}.completed`, durationMs: Math.round(performance.now() - start) });
      return result;
    } catch (error) {
      await recordEvent({ ...entry, eventName: `${entry.eventName}.failed`, error, durationMs: Math.round(performance.now() - start) });
      throw error;
    }
  });
}
