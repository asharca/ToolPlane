import {
  McpRequestLogs,
  type McpRequestLogView,
} from '@/components/dashboard/McpRequestLogs';

export type LogEntry = McpRequestLogView;

/**
 * Keeps the deployment inspector's existing data contract while using the
 * shared request-log experience also used by workspace observability.
 */
export function DeploymentLogs({ logs }: { logs: LogEntry[] }) {
  return <McpRequestLogs logs={logs} refreshIntervalMs={5_000} />;
}
