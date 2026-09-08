import { recordEvent } from '@/lib/observability/events';
import { db } from '@/lib/db';
import { redactText } from '@/lib/observability/redaction';

export type AgentChannelLogEntry = {
  timestamp: number;
  level: 'info' | 'error';
  message: string;
};

declare global {
  var __toolplaneAgentChannelLogs: Map<string, AgentChannelLogEntry[]> | undefined;
}

export function appendAgentChannelLog(connectionId: string, level: AgentChannelLogEntry['level'], message: string, secrets: string[] = []) {
  globalThis.__toolplaneAgentChannelLogs ??= new Map();
  const redacted = redactText(message, secrets);
  void recordEvent({ domain: 'channel', eventName: 'channel.log', channelId: connectionId, level,
    outcome: level === 'error' ? 'error' : 'success', message: redacted, secrets });
  const logs = globalThis.__toolplaneAgentChannelLogs.get(connectionId) ?? [];
  for (const line of redacted.trim().split(/\r?\n/).filter(Boolean)) {
    logs.push({ timestamp: Date.now(), level, message: line.slice(0, 2000) });
  }
  // Immediate local tail while the bounded persistent writer completes.
  globalThis.__toolplaneAgentChannelLogs.set(connectionId, logs.slice(-200));
  return redacted.trim().slice(0, 2000);
}

export function getAgentChannelLogs(connectionId: string) {
  return globalThis.__toolplaneAgentChannelLogs?.get(connectionId) ?? [];
}

export async function getPersistedAgentChannelLogs(workspaceId: string, connectionId: string) {
  const rows = await db.logEvent.findMany({ where: { workspaceId, channelId: connectionId, domain: 'channel' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  return rows.reverse().map((row) => ({ timestamp: row.occurredAt.getTime(), level: row.level === 'error' ? 'error' as const : 'info' as const, message: row.message }));
}

export function clearAgentChannelLogs(connectionId: string) {
  globalThis.__toolplaneAgentChannelLogs?.delete(connectionId);
}
