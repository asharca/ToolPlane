import {
  withMcpToolCatalog,
  type McpToolDefinition,
} from "@/lib/process/mcp-tool-catalog";

export type McpInspectorConnection = {
  sandboxId: string;
  connectedAt: string;
  definitionChecksum: string;
  runtimeFilesChecksum: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readMcpInspectorConnection(
  value: unknown,
): McpInspectorConnection | null {
  const connection = record(record(value)?.mcpInspector);
  const sandboxId =
    typeof connection?.sandboxId === "string" ? connection.sandboxId : "";
  const connectedAt =
    typeof connection?.connectedAt === "string" ? connection.connectedAt : "";
  const definitionChecksum = connection?.definitionChecksum;
  const runtimeFilesChecksum = connection?.runtimeFilesChecksum;
  return sandboxId &&
    sandboxId.length <= 256 &&
    connectedAt &&
    Number.isFinite(Date.parse(connectedAt)) &&
    typeof definitionChecksum === "string" &&
    /^[a-f0-9]{64}$/.test(definitionChecksum) &&
    typeof runtimeFilesChecksum === "string" &&
    /^[a-f0-9]{64}$/.test(runtimeFilesChecksum)
    ? { sandboxId, connectedAt, definitionChecksum, runtimeFilesChecksum }
    : null;
}

export function withMcpInspectorConnection(
  value: unknown,
  tools: McpToolDefinition[],
  sandboxId: string,
  pin: { definitionChecksum: string; runtimeFilesChecksum: string },
  connectedAt = new Date().toISOString(),
): Record<string, unknown> {
  return {
    ...withMcpToolCatalog(value, tools),
    mcpInspector: { sandboxId, connectedAt, ...pin },
  };
}
