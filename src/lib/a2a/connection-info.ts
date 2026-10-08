/** Shared presentation data; this module must never import credentials or server code. */
export function a2aDeploymentOrigin(raw: string): string {
  const url = new URL(raw);
  // Only literal RFC1918 addresses qualify; public hosts still require HTTPS.
  const developmentLan = process.env.NODE_ENV === 'development'
    && /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !developmentLan)) {
    throw new Error('A2A requires HTTPS (HTTP is allowed on loopback and private IPv4 addresses in development).');
  }
  return url.origin;
}

export function a2aConnectionInfo(origin: string, slug: string, agentId: string, endpointId?: string | null) {
  const base = a2aDeploymentOrigin(origin);
  const local = new URL(`/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/local`, base).href;
  const rpc = endpointId ? new URL(`/api/v1/agent-endpoints/${encodeURIComponent(endpointId)}/a2a`, base).href : null;
  return { localRpc: local, localCard: local, publicRpc: rpc, publicCard: rpc ? `${rpc}/.well-known/agent-card.json` : null, publicMcp: rpc ? `${rpc}/mcp` : null };
}

export type A2AConsoleView = {
  channels?: Array<{ id: string; name: string; platform: string; enabled: boolean; mine: boolean }>;
  canManage: boolean;
  local: { enabled: boolean; supported: boolean; ready: boolean };
  endpoint: null | { id: string; enabled: boolean; ready: boolean; revision: number | null;
    clients: Array<{ id: string; name: string; status: string; keys: Array<{
      id: string; name: string; prefix: string; revokedAt: string | null; expiresAt: string | null;
    }> }> };
  connections: ReturnType<typeof a2aConnectionInfo> | null;
};

