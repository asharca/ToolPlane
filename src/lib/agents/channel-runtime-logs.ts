import { recordEvent } from "@/lib/observability/events";
import { db } from "@/lib/db";
import { redactText } from "@/lib/observability/redaction";

export type AgentChannelLogEntry = {
  timestamp: number;
  level: "info" | "error";
  message: string;
};

declare global {
  var __toolplaneAgentChannelLogs:
    | Map<string, AgentChannelLogEntry[]>
    | undefined;
}

export function appendAgentChannelLog(
  connectionId: string,
  level: AgentChannelLogEntry["level"],
  message: string,
  secrets: string[] = [],
) {
  globalThis.__toolplaneAgentChannelLogs ??= new Map();
  const redacted = redactText(message, secrets);
  void recordEvent({
    domain: "channel",
    eventName: "channel.log",
    channelId: connectionId,
    level,
    outcome: level === "error" ? "error" : "success",
    message: redacted,
    secrets,
  });
  const logs = globalThis.__toolplaneAgentChannelLogs.get(connectionId) ?? [];
  logs.push({ timestamp: Date.now(), level, message: redacted });
  globalThis.__toolplaneAgentChannelLogs.set(connectionId, logs);
  return redacted;
}

export function getAgentChannelLogs(connectionId: string) {
  return globalThis.__toolplaneAgentChannelLogs?.get(connectionId) ?? [];
}

export async function getPersistedAgentChannelLogs(
  workspaceId: string,
  connectionId: string,
) {
  const rows = await db.logEvent.findMany({
    where: { workspaceId, channelId: connectionId, domain: "channel" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.reverse().map((row) => ({
    timestamp: row.occurredAt.getTime(),
    level: row.level === "error" ? ("error" as const) : ("info" as const),
    message: row.message,
  }));
}

export function clearAgentChannelLogs(connectionId: string) {
  globalThis.__toolplaneAgentChannelLogs?.delete(connectionId);
}
