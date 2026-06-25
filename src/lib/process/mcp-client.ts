import 'server-only';
import { livePort } from './supervisor';

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

// Issue a JSON-RPC request straight to a deployment's live process (used for
// server-rendered reads like tools/list). Returns the JSON-RPC `result` or
// null when the process is not reachable.
export async function mcpRpc(
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<Record<string, unknown> | null> {
  const port = livePort(deploymentId);
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    const json = await res.json();
    return (json?.result as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

export async function listMcpTools(deploymentId: string): Promise<McpTool[]> {
  const result = await mcpRpc(deploymentId, 'tools/list', undefined, 5000);
  return (result?.tools as McpTool[]) ?? [];
}
