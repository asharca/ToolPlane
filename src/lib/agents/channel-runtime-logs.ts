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
  let redacted = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  const logs = globalThis.__toolplaneAgentChannelLogs.get(connectionId) ?? [];
  for (const line of redacted.trim().split(/\r?\n/).filter(Boolean)) {
    logs.push({ timestamp: Date.now(), level, message: line.slice(0, 2000) });
  }
  // ponytail: last 200 entries in memory, use persistent logs when restart history is needed.
  globalThis.__toolplaneAgentChannelLogs.set(connectionId, logs.slice(-200));
  return redacted.trim().slice(0, 2000);
}

export function getAgentChannelLogs(connectionId: string) {
  return globalThis.__toolplaneAgentChannelLogs?.get(connectionId) ?? [];
}

export function clearAgentChannelLogs(connectionId: string) {
  globalThis.__toolplaneAgentChannelLogs?.delete(connectionId);
}
