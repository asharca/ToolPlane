import type { ReactNode } from 'react';
import { McpRequestLogs } from '@/components/dashboard/McpRequestLogs';

export type ObservabilityLogView = {
  id: string;
  deploymentId: string | null;
  deploymentHref: string | null;
  deploymentName: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  time: string;
};

export function ObservabilityLogs({ logs, searchControls }: { logs: ObservabilityLogView[]; searchControls?: ReactNode }) {
  return <McpRequestLogs logs={logs} showServer searchControls={searchControls} />;
}
