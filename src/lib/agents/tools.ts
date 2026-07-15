import 'server-only';
import { createHash } from 'node:crypto';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';
import { liveStatus } from '@/lib/process/supervisor';
import { listMcpTools, mcpRpc, type McpTool } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';
import {
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
  loadMcpToolPolicies,
  type McpToolPolicy,
} from '@/lib/workspace/mcp-tool-exposure';

function shortHash(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function toolKey(deploymentId: string, toolName: string): string {
  const dep = shortHash(deploymentId, 12);
  const name = toolName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'tool';
  const toolHash = shortHash(`${deploymentId}:${toolName}`, 8);
  return `d_${dep}__${name}_${toolHash}`;
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
  loadMcpToolPolicies: (
    deploymentIds: readonly string[],
    workspaceId: string,
  ) => Promise<Map<string, McpToolPolicy>>;
};

const defaultDeps: ToolDeps = {
  liveStatus,
  listMcpTools,
  mcpRpc,
  logRequest,
  loadMcpToolPolicies,
};

export async function buildToolSet(
  deploymentIds: string[],
  workspaceId: string,
  deps: ToolDeps = defaultDeps,
): Promise<ToolSet> {
  const set: ToolSet = {};
  const policies = await deps.loadMcpToolPolicies(deploymentIds, workspaceId);
  for (const deploymentId of deploymentIds) {
    const policy = policies.get(deploymentId);
    if (!policy) continue;
    if (deps.liveStatus(deploymentId) !== 'running') continue;
    const tools = filterMcpToolsForAi(await deps.listMcpTools(deploymentId), policy);
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
          const currentPolicy = (await deps.loadMcpToolPolicies([deploymentId], workspaceId))
            .get(deploymentId);
          if (!isMcpToolExposedToAi(currentPolicy, t.name)) {
            const denied = { error: `MCP tool ${t.name} is not exposed to AI.` };
            void deps.logRequest({
              workspaceId,
              deploymentId,
              method: 'POST',
              path: `/mcp/${deploymentId}/rpc#tools/call:${t.name}`,
              statusCode: 403,
              durationMs: Date.now() - start,
              requestBody: JSON.stringify({ name: t.name, arguments: args }).slice(0, 16000),
              responseBody: JSON.stringify(denied),
            }).catch(() => {});
            return denied;
          }
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
