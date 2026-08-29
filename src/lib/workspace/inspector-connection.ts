import { withMcpToolCatalog, type McpToolDefinition } from '@/lib/process/mcp-tool-catalog';

export type McpInspectorConnection = {
  sandboxId: string;
  connectedAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readMcpInspectorConnection(value: unknown): McpInspectorConnection | null {
  const connection = record(record(value)?.mcpInspector);
  const sandboxId = typeof connection?.sandboxId === 'string' ? connection.sandboxId : '';
  const connectedAt = typeof connection?.connectedAt === 'string' ? connection.connectedAt : '';
  return sandboxId && sandboxId.length <= 256 && connectedAt && Number.isFinite(Date.parse(connectedAt))
    ? { sandboxId, connectedAt }
    : null;
}

export function withMcpInspectorConnection(
  value: unknown,
  tools: McpToolDefinition[],
  sandboxId: string,
  connectedAt = new Date().toISOString(),
): Record<string, unknown> {
  return {
    ...withMcpToolCatalog(value, tools),
    mcpInspector: { sandboxId, connectedAt },
  };
}
