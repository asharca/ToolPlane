import 'server-only';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, mcpRpc, type McpTool } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';

export function toolKey(deploymentId: string, toolName: string): string {
  const dep = deploymentId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '');
  const name = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${dep}__${name}`;
}

type LogEntry = {
  workspaceId: string;
  deploymentId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody?: string | null;
  responseBody?: string | null;
};

export type ToolDeps = {
  liveStatus: (id: string) => string | null;
  listMcpTools: (id: string) => Promise<McpTool[]>;
  mcpRpc: (
    id: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  logRequest: (entry: LogEntry) => Promise<void>;
};

const defaultDeps: ToolDeps = { liveStatus, listMcpTools, mcpRpc, logRequest };

export async function buildToolSet(
  deploymentIds: string[],
  workspaceId: string,
  deps: ToolDeps = defaultDeps,
): Promise<ToolSet> {
  const set: ToolSet = {};
  for (const deploymentId of deploymentIds) {
    if (deps.liveStatus(deploymentId) !== 'running') continue;
    const tools = await deps.listMcpTools(deploymentId);
    for (const t of tools) {
      set[toolKey(deploymentId, t.name)] = tool({
        description: t.description ?? t.name,
        inputSchema: jsonSchema((t.inputSchema ?? { type: 'object', properties: {} }) as JSONSchema7),
        execute: async (args: Record<string, unknown>) => {
          // Agent tool calls go straight to the MCP process (not through the
          // gateway route), so record them here too — otherwise agent-driven
          // usage would be invisible in observability. Same path shape as the
          // gateway so it shows in the deployment's Logs and the workspace stats.
          const start = Date.now();
          const result = await deps.mcpRpc(deploymentId, 'tools/call', {
            name: t.name,
            arguments: args,
          });
          void deps
            .logRequest({
              workspaceId,
              deploymentId,
              method: 'POST',
              path: `/mcp/${deploymentId}/rpc#tools/call:${t.name}`,
              statusCode: result ? 200 : 502,
              durationMs: Date.now() - start,
              requestBody: JSON.stringify({ name: t.name, arguments: args }).slice(0, 16000),
              responseBody: JSON.stringify(result ?? { error: 'unreachable' }).slice(0, 16000),
            })
            .catch(() => {});
          return result ?? { error: `MCP deployment ${deploymentId} is not reachable.` };
        },
      });
    }
  }
  return set;
}
