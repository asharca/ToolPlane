/** Shared presentation data; this module must never import credentials or server code. */
export const A2A_DOCS = {
  console: 'https://github.com/asharca/ToolPlane/blob/main/docs/A2A_CONSOLE.zh-CN.md',
  public: 'https://github.com/asharca/ToolPlane/blob/main/docs/A2A_NATIVE.zh-CN.md',
  local: 'https://github.com/asharca/ToolPlane/blob/main/docs/A2A_LOCAL_COLLABORATION.zh-CN.md',
};

export function a2aDeploymentOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('A2A requires a configured HTTPS origin (HTTP is allowed on loopback).');
  }
  return url.origin;
}

export function a2aConnectionInfo(origin: string, slug: string, agentId: string, endpointId?: string | null) {
  const base = a2aDeploymentOrigin(origin);
  const local = new URL(`/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/local`, base).href;
  const rpc = endpointId ? new URL(`/api/v1/agent-endpoints/${encodeURIComponent(endpointId)}/a2a`, base).href : null;
  return { localRpc: local, localCard: local, publicRpc: rpc, publicCard: rpc ? `${rpc}/.well-known/agent-card.json` : null };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Tokens remain shell environment references, never interpolated into examples. */
export function a2aCurlExample(url: string, mode: 'local' | 'public', method: 'card' | 'SendMessage' | 'GetTask' | 'SubscribeToTask' | 'CancelTask') {
  const variable = mode === 'local' ? 'TOOLPLANE_ACCOUNT_TOKEN' : 'TOOLPLANE_A2A_TOKEN';
  const headers = `  -H "Authorization: Bearer $${variable}"`;
  if (method === 'card') return `curl --fail-with-body ${quote(url)} \\\n${headers}`;
  const params = method === 'SendMessage'
    ? { message: { messageId: 'REPLACE_WITH_UNIQUE_MESSAGE_ID', role: 'ROLE_USER', parts: [{ text: 'Hello from an A2A client.' }] }, configuration: { returnImmediately: true, historyLength: 0 } }
    : { id: 'REPLACE_WITH_TASK_ID' };
  return `curl --fail-with-body${method === 'SubscribeToTask' ? ' --no-buffer' : ''} ${quote(url)} \\\n${headers} \\\n  -H 'Content-Type: application/json' \\\n  -H 'A2A-Version: 1.0' \\\n  -d ${quote(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }, null, 2))}`;
}

export type A2AConsoleView = {
  canManage: boolean;
  local: { enabled: boolean; supported: boolean; ready: boolean };
  endpoint: null | { id: string; enabled: boolean; ready: boolean; revision: number | null;
    clients: Array<{ id: string; name: string; status: string; keys: Array<{
      id: string; name: string; prefix: string; revokedAt: string | null; expiresAt: string | null;
    }> }> };
  connections: ReturnType<typeof a2aConnectionInfo> | null;
};
