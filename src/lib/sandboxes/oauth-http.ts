import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveRequestPrincipal } from '@/lib/auth/request-user';
import { withLogContext } from '@/lib/observability/context';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { hashSandboxMcpToken as hash, newSandboxMcpSecret, ownedSandbox } from './mcp-access';
import { sandboxMcpExportable } from './mcp-policy';
import { privateJson, readSandboxJson, RequestBodyError } from './http-body';
import {
  AUTHORIZE_PATH, CONSENT_COOKIE, exactParameter, isValidOAuthRedirect, parseSandboxScopes,
  pkceMatches, sandboxIdFromResource, sandboxPublicOrigin, toolsForSandboxScopes,
} from './oauth-policy';

const ACCESS_SECONDS = 3600;
const GRANT_MS = 30 * 86_400_000;
class OAuthError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
function fail(code: string, status = 400): never { throw new OAuthError(code, status); }
const opaque = (prefix: string) => `${prefix}_${randomBytes(32).toString('hex')}`;
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function secretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error('A strong AUTH_SECRET is required for OAuth consent.');
  return new TextEncoder().encode(secret);
}
// Bounded per-process admission control; production deployments should also
// rate-limit the public OAuth endpoints at their trusted reverse proxy.
const budget = new Map<string, { end: number; count: number }>();
function admit(key: string, maximum: number) {
  const now = Date.now();
  if (budget.size > 4096) for (const [k, v] of budget) if (v.end < now) budget.delete(k);
  let item = budget.get(key);
  if (!item || item.end < now) {
    if (!item && budget.size >= 4096) fail('temporarily_unavailable', 429);
    item = { end: now + 60_000, count: 0 }; budget.set(key, item);
  }
  if (++item.count > maximum) fail('temporarily_unavailable', 429);
}
async function readForm(req: Request) {
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') fail('invalid_request', 415);
  const reader = req.body?.getReader();
  if (!reader) fail('invalid_request');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) { await reader.cancel(); fail('invalid_request', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  for (const key of params.keys()) if (params.getAll(key).length !== 1) fail('invalid_request');
  return params;
}
function callback(redirectUri: string, state: string | null, result: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set('state', state);
  // Metadata advertises RFC 9207, so include iss on BOTH success and errors.
  url.searchParams.set('iss', sandboxPublicOrigin());
  return new Response(null, { status: 303, headers: { location: url.href, 'cache-control': 'no-store' } });
}
function consentCookie(value: string, maxAge: number) {
  return `${CONSENT_COOKIE}=${value}; Path=${AUTHORIZE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${sandboxPublicOrigin().startsWith('https:') ? '; Secure' : ''}`;
}
function finishConsent(response: Response) {
  response.headers.set('set-cookie', consentCookie('', 0)); return response;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const Consent = z.object({
  clientId: z.string(), sandboxId: z.string(), redirectUri: z.string(), resource: z.string(),
  state: z.string().nullable(), scopes: z.array(z.string()), codeChallenge: z.string(), nonce: z.string(),
});
type ConsentData = z.infer<typeof Consent>;

async function register(req: Request) {
  admit('register', 30);
  const registration = z.object({
    client_name: z.string().trim().min(1).max(100).default('MCP client'),
    redirect_uris: z.array(z.string().refine(isValidOAuthRedirect)).min(1).max(10),
    token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('client_secret_basic'),
    grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
    response_types: z.array(z.literal('code')).default(['code']),
  }).safeParse(await readSandboxJson(req));
  if (!registration.success || !registration.data.grant_types.includes('authorization_code')) fail('invalid_client_metadata');
  if (await db.sandboxMcpOAuthClient.count() >= 10_000) fail('temporarily_unavailable', 429);
  const data = registration.data;
  const id = opaque('mcpsbc');
  const secret = data.token_endpoint_auth_method === 'none' ? undefined : opaque('mcpsbs');
  await db.sandboxMcpOAuthClient.create({ data: {
    id, name: data.client_name, redirectUris: [...new Set(data.redirect_uris)],
    tokenEndpointAuthMethod: data.token_endpoint_auth_method, secretHash: secret ? hash(secret) : null,
  } });
  return privateJson({ ...data, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
}
async function authorizeGet(req: Request) {
  const params = new URL(req.url).searchParams;
  let clientId: string | null; let redirectUri: string | null; let state: string | null;
  try {
    clientId = exactParameter(params, 'client_id'); redirectUri = exactParameter(params, 'redirect_uri');
    state = exactParameter(params, 'state');
    for (const key of params.keys()) exactParameter(params, key);
  } catch { fail('invalid_request'); }
  if (!clientId || !redirectUri || (state && state.length > 2048)) fail('invalid_request');
  const client = await db.sandboxMcpOAuthClient.findUnique({ where: { id: clientId } });
  // Never redirect to an unregistered callback, including on errors.
  if (!client || !client.redirectUris.includes(redirectUri)) fail('invalid_request');
  let consent: ConsentData;
  try {
    const resource = params.get('resource') ?? '';
    const sandboxId = sandboxIdFromResource(resource);
    if (!sandboxId) fail('invalid_target');
    if (params.get('response_type') !== 'code') fail('unsupported_response_type');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail('invalid_request');
    let scopes: string[];
    try { scopes = parseSandboxScopes(params.get('scope')); } catch { fail('invalid_scope'); }
    consent = { clientId, sandboxId, resource, redirectUri, state, scopes,
      codeChallenge: challenge, nonce: randomBytes(24).toString('base64url') };
  } catch (error) {
    if (error instanceof OAuthError) return callback(redirectUri, state, { error: error.code });
    throw error;
  }
  const principal = await resolveRequestPrincipal(req);
  if (!principal) {
    const login = new URL('/app/login', sandboxPublicOrigin());
    login.searchParams.set('next', `${AUTHORIZE_PATH}?${params}`);
    return new Response(null, { status: 303, headers: { location: login.href, 'cache-control': 'no-store' } });
  }
  if (principal.credential !== 'session') return callback(redirectUri, state, { error: 'access_denied' });
  const sandbox = await ownedSandbox(consent.sandboxId, principal.user.id);
  if (!sandbox || !sandboxMcpExportable(sandbox.kind)) return callback(redirectUri, state, { error: 'access_denied' });
  admit(`authorize:${principal.user.id}`, 120);
  const signed = await new SignJWT(consent).setProtectedHeader({ alg: 'HS256', typ: 'toolplane-mcp-consent+jwt' })
    .setSubject(principal.user.id).setIssuer(sandboxPublicOrigin()).setAudience('sandbox-mcp-consent')
    .setIssuedAt().setExpirationTime('10m').sign(secretKey());
  const labels: Record<string, string> = {
    'sandbox:read': '读取沙箱信息与文件 / Read sandbox information and files',
    'sandbox:write': '写入、覆盖及删除文件 / Write, overwrite and delete files',
    'sandbox:execute': '执行命令，拥有沙箱账号权限 / Execute commands with sandbox account privileges',
    offline_access: '保持连接（最多 30 天，可随时撤销）/ Maintain access for up to 30 days',
  };
  const options = consent.scopes.map((scope) => `<label><input type="checkbox" name="${escapeHtml(scope)}" value="yes"${scope === 'sandbox:read' || scope === 'offline_access' ? ' checked' : ''}> ${escapeHtml(labels[scope])}</label>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ToolPlane · 沙箱授权</title><style>body{font:16px system-ui;max-width:680px;margin:8vh auto;padding:24px;line-height:1.6}label{display:block;margin:18px 0}button{padding:10px 22px;margin:10px 12px 0 0}code{overflow-wrap:anywhere}</style><h1>连接沙箱 / Connect sandbox</h1><p>应用：<strong>${escapeHtml(client.name)}</strong>（名称由客户端提供，不代表认证身份）</p><p>返回地址 / Callback: <code>${escapeHtml(redirectUri)}</code></p><p>沙箱：<strong>${escapeHtml(sandbox.name)}</strong> (${escapeHtml(sandbox.kind)})</p><p>仅授权此沙箱。文件中可能有机密；SSH / Connector 命令并非容器隔离，可能访问工作目录之外的数据和网络。只向可信应用授予执行权限。</p><form method="post" action="${AUTHORIZE_PATH}"><input type="hidden" name="consent" value="${escapeHtml(signed)}">${options}<button name="decision" value="allow">允许所选权限 / Allow</button><button name="decision" value="deny">拒绝 / Deny</button></form></html>`;
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'set-cookie': consentCookie(consent.nonce, 600),
  } });
}
async function authorizePost(req: Request) {
  if (req.headers.get('origin') !== sandboxPublicOrigin()) fail('access_denied', 403);
  const principal = await resolveRequestPrincipal(req);
  if (principal?.credential !== 'session') fail('access_denied', 403);
  const form = await readForm(req);
  let consent: ConsentData;
  try {
    const { payload } = await jwtVerify(form.get('consent') ?? '', secretKey(), {
      issuer: sandboxPublicOrigin(), audience: 'sandbox-mcp-consent', algorithms: ['HS256'],
      typ: 'toolplane-mcp-consent+jwt', subject: principal.user.id,
    });
    consent = Consent.parse(payload);
    const nonce = req.headers.get('cookie')?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${CONSENT_COOKIE}=`))?.slice(CONSENT_COOKIE.length + 1);
    if (!nonce || !equal(nonce, consent.nonce)) fail('access_denied', 403);
  } catch { fail('access_denied', 403); }
  const client = await db.sandboxMcpOAuthClient.findUnique({ where: { id: consent.clientId } });
  if (!client?.redirectUris.includes(consent.redirectUri)) fail('invalid_request');
  if (form.get('decision') !== 'allow') return finishConsent(callback(consent.redirectUri, consent.state, { error: 'access_denied' }));
  const scopes = consent.scopes.filter((scope) => form.get(scope) === 'yes');
  if (!toolsForSandboxScopes(scopes).length) return finishConsent(callback(consent.redirectUri, consent.state, { error: 'invalid_scope' }));
  const sandbox = await ownedSandbox(consent.sandboxId, principal.user.id);
  if (!sandbox || !sandboxMcpExportable(sandbox.kind)) return finishConsent(callback(consent.redirectUri, consent.state, { error: 'access_denied' }));
  const release = beginWorkspaceOperation(sandbox.workspaceId);
  if (!release) return finishConsent(callback(consent.redirectUri, consent.state, { error: 'temporarily_unavailable' }));
  try {
    admit(`authorize:${principal.user.id}`, 120);
    // Delete expired authorization codes opportunistically; refresh tombstones
    // remain until their family's absolute expiry for replay detection.
    await db.sandboxMcpOAuthCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const code = opaque('mcpsba');
    await db.sandboxMcpOAuthCode.create({ data: {
      codeHash: hash(code), clientId: consent.clientId, sandboxId: consent.sandboxId,
      userId: principal.user.id, redirectUri: consent.redirectUri, resource: consent.resource,
      scopes, codeChallenge: consent.codeChallenge, expiresAt: new Date(Date.now() + 300_000),
    } });
    return finishConsent(callback(consent.redirectUri, consent.state, { code }));
  } finally { release(); }
}
async function authenticateClient(req: Request, form: URLSearchParams) {
  let id = form.get('client_id'); let secret = form.get('client_secret');
  const authorization = req.headers.get('authorization');
  let basic = false;
  if (authorization !== null) {
    if (!/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization) || secret !== null) fail('invalid_client', 401);
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) fail('invalid_client', 401);
      const basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
      if (id && id !== basicId) fail('invalid_client', 401);
      id = basicId; secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')); basic = true;
    } catch { fail('invalid_client', 401); }
  }
  if (!id || id.length > 100) fail('invalid_client', 401);
  admit(`client:${id}`, 120);
  const client = await db.sandboxMcpOAuthClient.findUnique({ where: { id } });
  if (!client) fail('invalid_client', 401);
  if (client.tokenEndpointAuthMethod === 'none') {
    if (basic || secret !== null) fail('invalid_client', 401);
  } else {
    if (basic !== (client.tokenEndpointAuthMethod === 'client_secret_basic') || !secret || !client.secretHash
      || !timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(client.secretHash))) fail('invalid_client', 401);
  }
  return client;
}
async function exchange(req: Request) {
  const form = await readForm(req);
  const client = await authenticateClient(req, form);
  const resource = form.get('resource') ?? '';
  if (!sandboxIdFromResource(resource)) fail('invalid_target');
  if (form.get('grant_type') === 'authorization_code') {
    const code = await db.sandboxMcpOAuthCode.findUnique({ where: { codeHash: hash(form.get('code') ?? '') } });
    if (!code || code.clientId !== client.id || code.resource !== resource || code.redirectUri !== form.get('redirect_uri')
      || code.consumedAt || code.expiresAt <= new Date() || !pkceMatches(form.get('code_verifier') ?? '', code.codeChallenge)) fail('invalid_grant');
    const sandbox = await ownedSandbox(code.sandboxId, code.userId);
    if (!sandbox || !sandboxMcpExportable(sandbox.kind)) fail('invalid_grant');
    const release = beginWorkspaceOperation(sandbox.workspaceId);
    if (!release) fail('temporarily_unavailable', 409);
    try {
      const token = newSandboxMcpSecret(); const now = new Date(); const expiry = new Date(now.getTime() + GRANT_MS);
      const refresh = code.scopes.includes('offline_access') ? opaque('mcpsbr') : undefined;
      const created = await db.$transaction(async (tx) => {
        const used = await tx.sandboxMcpOAuthCode.updateMany({ where: {
          codeHash: code.codeHash, consumedAt: null, expiresAt: { gt: now },
        }, data: { consumedAt: now } });
        if (!used.count) return false;
        await tx.sandboxMcpToken.create({ data: {
          sandboxId: code.sandboxId, userId: code.userId, name: `OAuth: ${client.name}`,
          oauthClientId: client.id, oauthResource: resource, oauthScopes: code.scopes, oauthExpiresAt: expiry,
          tokenHash: token.tokenHash, prefix: token.prefix, allowedTools: toolsForSandboxScopes(code.scopes),
          expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000),
          ...(refresh ? { refreshTokens: { create: { tokenHash: hash(refresh), expiresAt: expiry } } } : {}),
        } });
        return true;
      });
      if (!created) fail('invalid_grant');
      return privateJson({ access_token: token.token, token_type: 'Bearer', expires_in: ACCESS_SECONDS,
        scope: code.scopes.join(' '), ...(refresh ? { refresh_token: refresh } : {}),
      });
    } finally { release(); }
  }
  if (form.get('grant_type') !== 'refresh_token') fail('unsupported_grant_type');
  const record = await db.sandboxMcpOAuthRefresh.findUnique({ where: { tokenHash: hash(form.get('refresh_token') ?? '') }, include: { grant: true } });
  const now = new Date();
  if (!record || record.grant.oauthClientId !== client.id || record.grant.oauthResource !== resource
    || record.expiresAt <= now || record.grant.revokedAt || !record.grant.oauthExpiresAt || record.grant.oauthExpiresAt <= now) fail('invalid_grant');
  const grant = record.grant;
  const sandbox = await ownedSandbox(grant.sandboxId, grant.userId);
  if (!sandbox || !sandboxMcpExportable(sandbox.kind)) fail('invalid_grant');
  let scopes = grant.oauthScopes;
  if (form.has('scope')) {
    try { scopes = parseSandboxScopes(form.get('scope')); } catch { fail('invalid_scope'); }
    if (scopes.some((scope) => !grant.oauthScopes.includes(scope))) fail('invalid_scope');
  }
  const release = beginWorkspaceOperation(sandbox.workspaceId);
  if (!release) fail('temporarily_unavailable', 409);
  try {
    const access = newSandboxMcpSecret(); const refresh = opaque('mcpsbr');
    const expiresIn = Math.min(ACCESS_SECONDS, Math.floor((record.expiresAt.getTime() - now.getTime()) / 1000));
    const rotated = await db.$transaction(async (tx) => {
      // Serialize refresh/revoke on the grant row; recheck state after locking.
      const locked = await tx.sandboxMcpToken.updateMany({ where: { id: grant.id, revokedAt: null }, data: { revokedAt: null } });
      if (!locked.count) return false;
      const used = await tx.sandboxMcpOAuthRefresh.updateMany({ where: { tokenHash: record.tokenHash, consumedAt: null }, data: { consumedAt: now } });
      if (!used.count) {
        // Commit family revocation even for replay of an older generation.
        await tx.sandboxMcpToken.update({ where: { id: grant.id }, data: { revokedAt: now } });
        return false;
      }
      await tx.sandboxMcpToken.update({ where: { id: grant.id }, data: {
        tokenHash: access.tokenHash, prefix: access.prefix, expiresAt: new Date(now.getTime() + expiresIn * 1000),
        oauthScopes: scopes, allowedTools: toolsForSandboxScopes(scopes),
      } });
      if (scopes.includes('offline_access')) await tx.sandboxMcpOAuthRefresh.create({ data: {
        tokenHash: hash(refresh), grantId: grant.id, expiresAt: record.expiresAt,
      } });
      return true;
    });
    if (!rotated) fail('invalid_grant');
    return privateJson({ access_token: access.token, token_type: 'Bearer', expires_in: expiresIn,
      scope: scopes.join(' '), ...(scopes.includes('offline_access') ? { refresh_token: refresh } : {}),
    });
  } finally { release(); }
}
async function revoke(req: Request) {
  const form = await readForm(req); const client = await authenticateClient(req, form);
  const tokenHash = hash(form.get('token') ?? '');
  const refresh = await db.sandboxMcpOAuthRefresh.findUnique({ where: { tokenHash }, select: { grantId: true } });
  await db.sandboxMcpToken.updateMany({ where: {
    oauthClientId: client.id, OR: [{ tokenHash }, ...(refresh ? [{ id: refresh.grantId }] : [])],
  }, data: { revokedAt: new Date() } });
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
export function handleSandboxOAuth(req: Request, action: 'register' | 'authorize' | 'token' | 'revoke'): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      sandboxPublicOrigin();
      if (action === 'authorize') return req.method === 'GET' ? await authorizeGet(req) : req.method === 'POST' ? await authorizePost(req) : fail('invalid_request', 405);
      if (req.method !== 'POST') fail('invalid_request', 405);
      if (req.headers.has('origin') && req.headers.get('origin') !== sandboxPublicOrigin()) fail('access_denied', 403);
      return action === 'register' ? await register(req) : action === 'token' ? await exchange(req) : await revoke(req);
    } catch (error) {
      const response = privateJson({ error: error instanceof OAuthError ? error.code : error instanceof RequestBodyError ? 'invalid_request' : 'server_error' },
        error instanceof OAuthError || error instanceof RequestBodyError ? error.status : 500);
      if (response.status === 401) response.headers.set('www-authenticate', 'Basic realm="toolplane-sandbox-oauth"');
      return response;
    }
  });
}
