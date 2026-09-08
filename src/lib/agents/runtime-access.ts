import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { runtimeEnv } from '@/lib/runtime-env';
import { getLogContext, enrichLogContext } from '@/lib/observability/context';

export const AGENT_RUNTIME_TOKEN_MAX_TTL_SECONDS = 60 * 60;
export const AGENT_RUNTIME_TOKEN_HEADER = 'x-toolplane-runtime-token';

export type AgentRuntimeTokenPayload = {
  workspaceId: string;
  agentId: string;
  sandboxId: string;
  providerId: string;
  deploymentIds: string[];
  exp: number;
  traceId?: string;
  parentSpanId?: string;
};

const TOKEN_ISSUER = 'toolplane';
const TOKEN_AUDIENCE = 'agent-runtime';
const MAX_DEPLOYMENTS = 100;

function secretKey(): Uint8Array {
  const secret = runtimeEnv('AUTH_SECRET');
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validDeploymentIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_DEPLOYMENTS
    && value.every(validId);
}

export async function createAgentRuntimeToken(
  payload: AgentRuntimeTokenPayload,
  now = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  if (
    !validId(payload.workspaceId)
    || !validId(payload.agentId)
    || !validId(payload.sandboxId)
    || !validId(payload.providerId)
    || !validDeploymentIds(payload.deploymentIds)
    || !Number.isSafeInteger(payload.exp)
    || payload.exp <= issuedAt
    || payload.exp > issuedAt + AGENT_RUNTIME_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new Error('Agent runtime token payload is invalid.');
  }

  return new SignJWT({
    workspaceId: payload.workspaceId,
    agentId: payload.agentId,
    sandboxId: payload.sandboxId,
    providerId: payload.providerId,
    deploymentIds: [...new Set(payload.deploymentIds)],
    traceId: getLogContext()?.traceId,
    parentSpanId: getLogContext()?.spanId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(payload.exp)
    .sign(secretKey());
}

export async function verifyAgentRuntimeToken(
  token: string,
  now = Date.now(),
): Promise<AgentRuntimeTokenPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      currentDate: new Date(now),
    });
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    if (
      !validId(payload.workspaceId)
      || !validId(payload.agentId)
      || !validId(payload.sandboxId)
      || !validId(payload.providerId)
      || !validDeploymentIds(payload.deploymentIds)
      || typeof issuedAt !== 'number'
      || typeof expiresAt !== 'number'
      || issuedAt > Math.floor(now / 1000) + 60
      || expiresAt - issuedAt > AGENT_RUNTIME_TOKEN_MAX_TTL_SECONDS
      || (payload.traceId !== undefined && (typeof payload.traceId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.traceId)))
      || (payload.parentSpanId !== undefined && (typeof payload.parentSpanId !== 'string' || !/^[a-f0-9]{16}$/.test(payload.parentSpanId)))
    ) return null;

    return {
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
      sandboxId: payload.sandboxId,
      providerId: payload.providerId,
      deploymentIds: [...new Set(payload.deploymentIds)],
      exp: expiresAt,
      ...(typeof payload.traceId === 'string' ? { traceId: payload.traceId } : {}),
      ...(typeof payload.parentSpanId === 'string' ? { parentSpanId: payload.parentSpanId } : {}),
    };
  } catch {
    return null;
  }
}

export function bindRuntimeLogContext(payload: AgentRuntimeTokenPayload) {
  enrichLogContext({ workspaceId: payload.workspaceId, agentId: payload.agentId, providerId: payload.providerId,
    ...(payload.traceId ? { traceId: payload.traceId, parentSpanId: payload.parentSpanId } : {}) });
}

export async function agentRuntimeTokenFromRequest(
  req: Pick<Request, 'headers'>,
): Promise<AgentRuntimeTokenPayload | null> {
  const bearer = /^Bearer\s+([^\s]+)$/i
    .exec(req.headers.get('authorization')?.trim() ?? '')?.[1];
  const token = req.headers.get(AGENT_RUNTIME_TOKEN_HEADER)?.trim()
    || bearer
    || req.headers.get('x-api-key')?.trim()
    || '';
  return verifyAgentRuntimeToken(token);
}

export function sandboxRuntimeOrigin(): string {
  const developmentOrigin = runtimeEnv('NODE_ENV') === 'development' && runtimeEnv('PORT')
    ? `http://localhost:${runtimeEnv('PORT')}`
    : undefined;
  const configured = runtimeEnv('TOOLPLANE_RUNTIME_ORIGIN')
    || runtimeEnv('TOOLPLANE_HERMES_CALLBACK_URL')
    || developmentOrigin
    || runtimeEnv('NEXT_PUBLIC_APP_URL')
    || `http://localhost:${runtimeEnv('PORT') || '3000'}`;
  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ToolPlane runtime origin must use http or https.');
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
    url.hostname = 'host.docker.internal';
  }
  return url.origin;
}

export function runtimeModelProxyBase(providerId: string): string {
  return `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/model/${encodeURIComponent(providerId)}`;
}

export function runtimeMcpProxyUrl(deploymentId: string): string {
  return `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/mcp/${encodeURIComponent(deploymentId)}/rpc`;
}

export function runtimeProviderUrl(
  baseUrl: string,
  path: readonly string[],
  search = '',
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider URL must use http or https.');
  }
  if (path.some((part) => !part || part === '.' || part === '..' || /[/\\]/.test(part))) {
    throw new Error('Provider proxy path is invalid.');
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  const baseLastPart = prefix.split('/').at(-1);
  const appendedPath = baseLastPart && path[0] === baseLastPart ? path.slice(1) : path;
  url.pathname = `${prefix}/${appendedPath.map(encodeURIComponent).join('/')}`
    .replace(/\/$/, appendedPath.length ? '' : '/');
  url.search = search;
  url.hash = '';
  return url.toString();
}
