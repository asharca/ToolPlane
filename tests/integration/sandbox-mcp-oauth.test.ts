// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from '@/lib/db';
import { handleSandboxOAuth } from '@/lib/sandboxes/oauth-http';
import { handleSandboxMcp } from '@/lib/sandboxes/mcp-http';
import { hashSandboxMcpToken, resolveSandboxMcpGrant } from '@/lib/sandboxes/mcp-access';
import { sandboxMcpResource, sandboxProtectedResourceMetadata, sandboxAuthorizationMetadata } from '@/lib/sandboxes/oauth-policy';
import { handleSandboxMcpTokens } from '@/lib/sandboxes/mcp-management';

const mocks = vi.hoisted(() => ({ principal: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestPrincipal: mocks.principal }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: (_id: string, status: string) => status }));
vi.mock('@/lib/process/mcp-client', () => ({ mcpRpc: mocks.rpc, listMcpTools: async () => [
  { name: 'sandbox_info', description: 'Inspect this sandbox', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'shell_exec', description: 'Execute a command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'private_admin_api', inputSchema: { type: 'object' } },
] }));
const origin = 'https://toolplane.test';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
let userId: string, outsiderId: string, workspaceId: string, sandboxId: string, deploymentId: string;
let oauthClient: { client_id: string; client_secret?: string };
const createdClients: string[] = [];
const verifier = 'test-verifier-'.repeat(5);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const post = (action: 'token' | 'authorize' | 'revoke', params: Record<string, string>, headers: Record<string, string> = {}) => handleSandboxOAuth(
  new Request(`${origin}/api/v1/sandbox-oauth/${action}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params) }), action);
function authorizeUrl(extra: Record<string, string> = {}) {
  return `${origin}/api/v1/sandbox-oauth/authorize?${new URLSearchParams({
    client_id: oauthClient.client_id, redirect_uri: callback, resource: sandboxMcpResource(sandboxId),
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'sandbox:read sandbox:write sandbox:execute offline_access', state: 'test-state', ...extra,
  })}`;
}
async function browserConsent(url = authorizeUrl(), scopes = ['sandbox:read', 'offline_access']) {
  const page = await handleSandboxOAuth(new Request(url), 'authorize');
  expect(page.status).toBe(200);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const html = await page.text();
  expect(html).not.toContain('name="sandbox:execute" value="yes" checked');
  const signed = /name="consent" value="([^"]+)"/.exec(html)![1];
  const params = { consent: signed, decision: 'allow', ...Object.fromEntries(scopes.map((s) => [s, 'yes'])) };
  const response = await post('authorize', params, { origin, cookie });
  expect(response.status).toBe(303);
  const redirect = new URL(response.headers.get('location')!);
  expect(redirect.searchParams.get('iss')).toBe(origin); expect(redirect.searchParams.get('state')).toBe('test-state');
  return { code: redirect.searchParams.get('code')!, signed, cookie, params };
}
async function tokenFor(scopes?: string[]) {
  const { code } = await browserConsent(undefined, scopes);
  const response = await post('token', { grant_type: 'authorization_code', client_id: oauthClient.client_id,
    code, code_verifier: verifier, redirect_uri: callback, resource: sandboxMcpResource(sandboxId) });
  expect(response.status).toBe(200);
  return await response.json() as OAuthTokens;
}
const refreshParams = (refresh: string) => ({ grant_type: 'refresh_token', client_id: oauthClient.client_id,
  refresh_token: refresh, resource: sandboxMcpResource(sandboxId) });

beforeAll(async () => {
  vi.stubEnv('TOOLPLANE_PUBLIC_URL', origin);
  vi.stubEnv('AUTH_SECRET', 'isolated-sandbox-oauth-test-secret-not-production');
  const id = randomUUID();
  const user = await db.user.create({ data: { email: `sandbox-mcp-${id}@test.invalid`, passwordHash: 'test-only' } }); userId = user.id;
  const outsider = await db.user.create({ data: { email: `sandbox-outsider-${id}@test.invalid`, passwordHash: 'test-only' } }); outsiderId = outsider.id;
  const workspace = await db.workspace.create({ data: { slug: `sandbox-mcp-${id}`, name: 'Sandbox OAuth test', ownerId: userId } }); workspaceId = workspace.id;
  const deployment = await db.deployment.create({ data: { workspaceId, source: 'sandbox', status: 'running' } }); deploymentId = deployment.id;
  const sandbox = await db.sandbox.create({ data: { workspaceId, deploymentId, name: 'OAuth test sandbox', slug: 'test', kind: 'ssh' } }); sandboxId = sandbox.id;
  const registration = await handleSandboxOAuth(new Request(`${origin}/api/v1/sandbox-oauth/register`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT test', redirect_uris: [callback], token_endpoint_auth_method: 'none' }),
  }), 'register');
  expect(registration.status).toBe(201); oauthClient = await registration.json(); createdClients.push(oauthClient.client_id);
});
beforeEach(async () => {
  mocks.principal.mockResolvedValue({ credential: 'session', user: { id: userId }, token: null });
  mocks.rpc.mockReset(); mocks.rpc.mockResolvedValue({ content: [{ type: 'text', text: '{"kind":"ssh"}' }] });
  await db.user.update({ where: { id: userId }, data: { status: 'active' } });
  await db.sandbox.update({ where: { id: sandboxId }, data: { kind: 'ssh' } });
  await db.deployment.update({ where: { id: deploymentId }, data: { status: 'running', mcpToolExposure: 'all', mcpAllowedTools: [] } });
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  await db.sandboxMcpOAuthClient.deleteMany({ where: { id: { in: createdClients } } });
  for (const id of [userId, outsiderId].filter(Boolean)) await db.user.delete({ where: { id } });
  await db.$disconnect(); vi.unstubAllEnvs();
});

describe('sandbox OAuth with PostgreSQL and genuine MCP SDK', () => {
  it('challenges unauthenticated clients with discoverable resource metadata, not an HTML login', async () => {
    const response = await handleSandboxMcp(new Request(sandboxMcpResource(sandboxId)), sandboxId);
    expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('location')).toBeNull(); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('returns to the original authorization request after ToolPlane login; never auto-consents', async () => {
    mocks.principal.mockResolvedValue(null);
    const response = await handleSandboxOAuth(new Request(authorizeUrl()), 'authorize');
    expect(response.status).toBe(303); const next = new URL(response.headers.get('location')!);
    expect(next.pathname).toBe('/app/login'); expect(next.searchParams.get('next')).toContain('code_challenge=');
  });
  it('binds consent to a browser nonce, same-origin session and immutable request', async () => {
    const flow = await browserConsent();
    expect((await post('authorize', flow.params, { origin, cookie: 'wrong=nonce' })).status).toBe(403);
    expect((await post('authorize', flow.params, { origin: 'https://evil.test', cookie: flow.cookie })).status).toBe(403);
    expect((await post('authorize', { ...flow.params, consent: flow.signed + 'changed' }, { origin, cookie: flow.cookie })).status).toBe(403);
  });
  it('rejects unregistered redirects without redirecting, and includes issuer on valid error callbacks', async () => {
    const bad = await handleSandboxOAuth(new Request(authorizeUrl({ redirect_uri: 'https://evil.test/cb' })), 'authorize');
    expect(bad.status).toBe(400); expect(bad.headers.get('location')).toBeNull();
    const downgrade = await handleSandboxOAuth(new Request(authorizeUrl({ code_challenge_method: 'plain' })), 'authorize');
    const location = new URL(downgrade.headers.get('location')!); expect(location.searchParams.get('iss')).toBe(origin);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });
  it('does not authorize outsiders or protected Hermes runtimes', async () => {
    mocks.principal.mockResolvedValue({ credential: 'session', user: { id: outsiderId } });
    const denied = await handleSandboxOAuth(new Request(authorizeUrl()), 'authorize');
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    mocks.principal.mockResolvedValue({ credential: 'session', user: { id: userId } });
    await db.sandbox.update({ where: { id: sandboxId }, data: { kind: 'hermes' } });
    const hermes = await handleSandboxOAuth(new Request(authorizeUrl()), 'authorize');
    expect(new URL(hermes.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
  it('enforces PKCE, redirect, audience and single-use authorization codes', async () => {
    const { code } = await browserConsent();
    const params = { grant_type: 'authorization_code', client_id: oauthClient.client_id, code, code_verifier: verifier, redirect_uri: callback, resource: sandboxMcpResource(sandboxId) };
    for (const change of [{ code_verifier: 'x'.repeat(64) }, { redirect_uri: 'https://evil.test/cb' }, { resource: sandboxMcpResource('another') }]) {
      expect((await post('token', { ...params, ...change })).status).toBe(400);
    }
    const results = await Promise.all([post('token', params), post('token', params)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
  it('stores hashes only and binds access to a live user, workspace and one sandbox', async () => {
    const token = await tokenFor(); const grant = await resolveSandboxMcpGrant(sandboxId, token.access_token);
    expect(grant?.allowedTools).toContain('read_file'); expect(grant?.allowedTools).not.toContain('shell_exec');
    const row = await db.sandboxMcpToken.findUniqueOrThrow({ where: { id: grant!.id }, include: { refreshTokens: true } });
    expect(JSON.stringify(row)).not.toContain(token.access_token); expect(JSON.stringify(row)).not.toContain(token.refresh_token!);
    expect(await resolveSandboxMcpGrant('other-sandbox', token.access_token)).toBeNull();
    await db.user.update({ where: { id: userId }, data: { status: 'suspended' } });
    expect(await resolveSandboxMcpGrant(sandboxId, token.access_token)).toBeNull();
  });
  it('rotates refresh credentials, retains the absolute expiry and revokes the family on replay', async () => {
    const original = await tokenFor();
    const response = await post('token', refreshParams(original.refresh_token!)); expect(response.status).toBe(200);
    const rotated = await response.json() as OAuthTokens;
    expect(rotated.refresh_token).not.toBe(original.refresh_token); expect(rotated.access_token).not.toBe(original.access_token);
    expect(await resolveSandboxMcpGrant(sandboxId, original.access_token)).toBeNull();
    expect(await resolveSandboxMcpGrant(sandboxId, rotated.access_token)).not.toBeNull();
    expect((await post('token', refreshParams(original.refresh_token!))).status).toBe(400);
    expect(await resolveSandboxMcpGrant(sandboxId, rotated.access_token)).toBeNull();
    expect((await post('token', refreshParams(rotated.refresh_token!))).status).toBe(400);
  });
  it('allows expired access to refresh but not scope escalation or wrong-resource refresh', async () => {
    const token = await tokenFor();
    await db.sandboxMcpToken.update({ where: { tokenHash: hashSandboxMcpToken(token.access_token) }, data: { expiresAt: new Date(0) } });
    expect((await post('token', { ...refreshParams(token.refresh_token!), scope: 'sandbox:execute offline_access' })).status).toBe(400);
    expect((await post('token', { ...refreshParams(token.refresh_token!), resource: sandboxMcpResource('other') })).status).toBe(400);
    expect((await post('token', refreshParams(token.refresh_token!))).status).toBe(200);
  });
  it('revokes both access and refresh via the OAuth revocation endpoint', async () => {
    const token = await tokenFor();
    expect((await post('revoke', { client_id: oauthClient.client_id, token: token.refresh_token! })).status).toBe(200);
    expect(await resolveSandboxMcpGrant(sandboxId, token.access_token)).toBeNull();
    expect((await post('token', refreshParams(token.refresh_token!))).status).toBe(400);
  });
  it('lists only approved tools and executes through the genuine SDK Streamable HTTP transport', async () => {
    const token = await tokenFor();
    const fetcher: typeof fetch = async (url, init) => handleSandboxMcp(new Request(url, init), sandboxId);
    const transport = new StreamableHTTPClientTransport(new URL(sandboxMcpResource(sandboxId)), {
      fetch: fetcher, requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
    });
    const client = new Client({ name: 'ChatGPT-contract-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      const { tools } = await client.listTools(); expect(tools.map((t) => t.name)).toEqual(['sandbox_info', 'read_file']);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({ name: 'sandbox_info', arguments: {} }); expect(result.isError).not.toBe(true);
      const blocked = await client.callTool({ name: 'shell_exec', arguments: { command: 'echo should-not-execute' } });
      expect(blocked.isError).toBe(true); expect(mocks.rpc).toHaveBeenCalledTimes(1);
      await db.deployment.update({ where: { id: deploymentId }, data: { mcpToolExposure: 'allowlist', mcpAllowedTools: [] } });
      expect((await client.listTools()).tools).toHaveLength(0);
    } finally { await client.close(); }
  });
  it('discovers PRM/AS, registers dynamically and completes PKCE using the SDK OAuth client', async () => {
    let info: OAuthClientInformationFull | undefined; let tokens: OAuthTokens | undefined;
    let codeVerifier = ''; let browserUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      clientMetadata: { client_name: 'SDK OAuth interoperability test', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => info,
      saveClientInformation: (value) => { info = value; createdClients.push(value.client_id); },
      tokens: () => tokens, saveTokens: (value) => { tokens = value; },
      redirectToAuthorization: (url) => { browserUrl = url; },
      saveCodeVerifier: (value) => { codeVerifier = value; }, codeVerifier: () => codeVerifier,
      state: () => 'test-state',
    };
    const fetcher: typeof fetch = async (url, init) => {
      const req = new Request(url, init); const path = new URL(req.url).pathname;
      if (path.includes('oauth-protected-resource')) return Response.json(sandboxProtectedResourceMetadata(sandboxId));
      if (path === '/.well-known/oauth-authorization-server') return Response.json(sandboxAuthorizationMetadata());
      if (path.endsWith('/register')) return handleSandboxOAuth(req, 'register');
      if (path.endsWith('/token')) return handleSandboxOAuth(req, 'token');
      throw new Error(`Unexpected SDK request: ${path}`);
    };
    const options = { serverUrl: new URL(sandboxMcpResource(sandboxId)), fetchFn: fetcher, scope: 'sandbox:read offline_access' };
    expect(await auth(provider, options)).toBe('REDIRECT');
    expect(browserUrl).toBeDefined();
    const { code } = await browserConsent(browserUrl!.href);
    expect(await auth(provider, { ...options, authorizationCode: code })).toBe('AUTHORIZED');
    expect(tokens?.refresh_token).toBeTruthy(); expect(await resolveSandboxMcpGrant(sandboxId, tokens!.access_token)).not.toBeNull();
  });
  it('does not accept a sandbox token for grant management, even with a session cookie', async () => {
    const token = await tokenFor(); mocks.principal.mockResolvedValue(null);
    const response = await handleSandboxMcpTokens(new Request(`${origin}/api/v1/sandboxes/${sandboxId}/mcp-tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, cookie: 'session=ignored' },
    }), sandboxId);
    expect(response.status).toBe(401);
  });
});
