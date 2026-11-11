import "server-only";
import { recordEvent, type LogEntry } from "./events";

export type SystemEventOptions = Omit<LogEntry, "domain" | "eventName"> & {
  domain?: LogEntry["domain"];
};

/**
 * Fire-and-forget operational event for background work and caught failures.
 * `eventName` is a stable dotted code (`scheduler.triggers.tick_failed`), never
 * free text: dashboards and error groups key on it. Put identities in their
 * columns (workspaceId, agentId, deploymentId, ...) and counts in `attributes`.
 */
export function logSystemEvent(
  eventName: string,
  options: SystemEventOptions = {},
): void {
  void recordEvent({ domain: "system", ...options, eventName });
}
