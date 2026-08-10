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

export class McpPayloadTooLargeError extends Error {
  constructor() {
    super('MCP payload exceeded the configured byte limit.');
    this.name = 'McpPayloadTooLargeError';
  }
}

type McpRpcOptions = {
  signal?: AbortSignal;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
};

async function readJsonResponse(response: Response, maxBytes?: number): Promise<unknown> {
  if (!maxBytes) return response.json();
  const announced = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(announced) && announced > maxBytes) throw new McpPayloadTooLargeError();
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('MCP response byte limit exceeded').catch(() => undefined);
        throw new McpPayloadTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

// Issue a JSON-RPC request straight to a deployment's live process (used for
// server-rendered reads like tools/list). Returns the JSON-RPC `result` or
// null when the process is not reachable.
export async function mcpRpc(
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
  options: McpRpcOptions = {},
): Promise<Record<string, unknown> | null> {
  const port = livePort(deploymentId);
  if (!port) return null;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    if (options.maxRequestBytes && new TextEncoder().encode(body).byteLength > options.maxRequestBytes) {
      throw new McpPayloadTooLargeError();
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
      cache: 'no-store',
    });
    const json = await readJsonResponse(res, options.maxResponseBytes) as {
      result?: Record<string, unknown>;
    } | null;
    return json?.result ?? null;
  } catch (error) {
    if (error instanceof McpPayloadTooLargeError) throw error;
    return null;
  }
}

export async function listMcpTools(
  deploymentId: string,
  options: McpRpcOptions = {},
): Promise<McpTool[]> {
  const result = await mcpRpc(deploymentId, 'tools/list', undefined, 5000, options);
  return (result?.tools as McpTool[]) ?? [];
}
