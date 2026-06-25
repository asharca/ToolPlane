import 'server-only';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, mcpRpc, type McpTool } from '@/lib/process/mcp-client';

export function toolKey(deploymentId: string, toolName: string): string {
  const dep = deploymentId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '');
  const name = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${dep}__${name}`;
}

export type ToolDeps = {
  liveStatus: (id: string) => string | null;
  listMcpTools: (id: string) => Promise<McpTool[]>;
  mcpRpc: (
    id: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
};

const defaultDeps: ToolDeps = { liveStatus, listMcpTools, mcpRpc };

export async function buildToolSet(
  deploymentIds: string[],
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
          const result = await deps.mcpRpc(deploymentId, 'tools/call', {
            name: t.name,
            arguments: args,
          });
          return result ?? { error: `MCP deployment ${deploymentId} is not reachable.` };
        },
      });
    }
  }
  return set;
}
