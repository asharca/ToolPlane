import 'server-only';

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt, SignJWT, jwtVerify } from 'jose';
import { db } from '@/lib/db';
import { runtimeEnv } from '@/lib/runtime-env';
import { normalizedOrigin } from './cors';
import {
  takeAgentApiAuthAttemptLimit,
  takeAgentApiAuthFailureLimit,
} from './rate-limit';

export const AGENT_API_KEY_PREFIX = 'tp_agent_';
export const AGENT_CLIENT_TOKEN_PREFIX = 'tp_client_';
export const AGENT_CLIENT_TOKEN_MAX_AGE_SECONDS = 15 * 60;
export const AGENT_CLIENT_TOKEN_DEFAULT_AGE_SECONDS = 15 * 60;
export const AGENT_API_MAX_TIMEOUT_SECONDS = 840;

const CLIENT_TOKEN_ISSUER = 'toolplane-agent-api';
const AGENT_API_KEY_BYTES = 32;

export type AgentApiCredentialType = 'api_key' | 'client_token';
export type AgentApiScope =
  | 'responses:create'
  | 'responses:read'
  | 'conversations:read'
  | 'conversations:delete'
  | 'client_tokens:create'
  | (string & {});

export type AgentApiLimits = {
  rpm: number;
  dailyRequests: number;
  maxConcurrent: number;
  timeoutSeconds: number;
  retentionDays: number;
};

export type AgentApiPrincipal = {
  credentialType: AgentApiCredentialType;
  endpointId: string;
  endpointPublicId: string;
  workspaceId: string;
  sourceAgentId: string;
  revisionId: string;
  clientId: string;
  keyId: string | null;
  subjectHash: string | null;
  origin: string | null;
  scopes: AgentApiScope[];
  limits: AgentApiLimits;
  rateBuckets: {
    endpointRpm: number;
    clientRpm: number;
    endpointDaily: number;
    clientDaily: number;
  };
};

export type CreateAgentApiKeyInput = {
  clientId: string;
  endpointPublicId: string;
  workspaceId: string;
  sourceAgentId: string;
  name: string;
  expiresAt?: Date | null;
};

export type AgentApiKeyView = {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type ListAgentApiKeysInput = {
  clientId: string;
  endpointPublicId: string;
  workspaceId: string;
  sourceAgentId: string;
};

export type RevokeAgentApiKeyInput = {
  keyId: string;
  endpointPublicId: string;
  workspaceId: string;
  sourceAgentId: string;
  now?: Date;
};

export type MintAgentClientTokenInput = {
  endpointId: string;
  endpointPublicId: string;
  clientId: string;
  subject: string;
  scopes: readonly AgentApiScope[];
  expiresInSeconds?: number;
  origin?: string | null;
  now?: Date;
};

export type AgentApiScopeRequirement = AgentApiScope | readonly AgentApiScope[];

const safeKeySelect = {
  id: true,
  clientId: true,
  name: true,
  prefix: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

function signingKey(): Uint8Array {
  const secret = runtimeEnv('AUTH_SECRET');
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

function normalizedScopes(scopes: readonly AgentApiScope[]): AgentApiScope[] {
  return [...new Set(scopes.flatMap((scope) => {
    const value = String(scope).trim();
    return value && value.length <= 100 && /^[a-z0-9_*:-]+$/i.test(value)
      ? [value as AgentApiScope]
      : [];
  }))];
}

function requiredScopes(requirement?: AgentApiScopeRequirement): AgentApiScope[] | null {
  if (!requirement) return [];
  const raw = typeof requirement === 'string' ? [requirement] : [...requirement];
  const normalized = normalizedScopes(raw);
  return normalized.length === new Set(raw.map((scope) => String(scope).trim())).size
    ? normalized
    : null;
}

export function hasAgentApiScope(
  scopes: readonly AgentApiScope[],
  requirement?: AgentApiScopeRequirement,
): boolean {
  const available = new Set(scopes);
  const required = requiredScopes(requirement);
  return required !== null
    && required.every((scope) => available.has(scope) || available.has('*'));
}

export function generateAgentApiKey(): string {
  return `${AGENT_API_KEY_PREFIX}${randomBytes(AGENT_API_KEY_BYTES).toString('base64url')}`;
}

export function hashAgentApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function agentApiKeyPrefix(token: string): string {
  return `${token.slice(0, AGENT_API_KEY_PREFIX.length + 8)}...`;
}

export function isAgentApiKey(token: string): boolean {
  return new RegExp(`^${AGENT_API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`).test(token);
}

export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

/**
 * HMAC namespacing avoids storing or correlating a customer's raw end-user id.
 * Including both endpoint and API client prevents the same subject from being
 * linkable across published Agents or sharing a runtime across integrations.
 */
export function hashAgentApiSubject(endpointId: string, clientId: string, subject: string): string {
  const value = subject.trim();
  if (!endpointId || !clientId || !value || value.length > 200) {
    throw new Error('Agent API subject is invalid');
  }
  return createHmac('sha256', signingKey())
    .update('toolplane:agent-api:subject\0')
    .update(endpointId)
    .update('\0')
    .update(clientId)
    .update('\0')
    .update(value)
    .digest('base64url');
}

function positiveMinimum(...values: number[]): number {
  const valid = values.filter((value) => Number.isSafeInteger(value) && value > 0);
  return valid.length ? Math.min(...valid) : 1;
}

function limitsFor(client: {
  rpmLimit: number;
  dailyRequestLimit: number;
  maxConcurrent: number;
  endpoint: {
    rpmLimit: number;
    dailyRequestLimit: number;
    maxConcurrent: number;
    timeoutSeconds: number;
    retentionDays: number;
  };
}): AgentApiLimits {
  return {
    rpm: positiveMinimum(client.rpmLimit, client.endpoint.rpmLimit),
    dailyRequests: positiveMinimum(client.dailyRequestLimit, client.endpoint.dailyRequestLimit),
    maxConcurrent: positiveMinimum(client.maxConcurrent, client.endpoint.maxConcurrent),
    timeoutSeconds: positiveMinimum(client.endpoint.timeoutSeconds, AGENT_API_MAX_TIMEOUT_SECONDS),
    retentionDays: Math.max(0, client.endpoint.retentionDays),
  };
}

function rateBucketsFor(client: {
  rpmLimit: number;
  dailyRequestLimit: number;
  endpoint: { rpmLimit: number; dailyRequestLimit: number };
}): AgentApiPrincipal['rateBuckets'] {
  return {
    endpointRpm: client.endpoint.rpmLimit,
    clientRpm: client.rpmLimit,
    endpointDaily: client.endpoint.dailyRequestLimit,
    clientDaily: client.dailyRequestLimit,
  };
}

function validEndpointOwner(client: {
  endpoint: {
    workspaceId: string;
    sourceAgent: { workspaceId: string };
    workspace: { owner: { status: string } };
  };
}): boolean {
  return client.endpoint.workspace.owner.status === 'active'
    && client.endpoint.sourceAgent.workspaceId === client.endpoint.workspaceId;
}

export async function createAgentApiKey(
  input: CreateAgentApiKeyInput,
): Promise<{ token: string; record: AgentApiKeyView }> {
  const name = input.name.trim();
  const now = new Date();
  if (!name || name.length > 100) throw new Error('Agent API key name is invalid');
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    throw new Error('Agent API key expiry must be in the future');
  }

  const client = await db.agentApiClient.findFirst({
    where: {
      id: input.clientId,
      status: 'active',
      endpoint: {
        publicId: input.endpointPublicId,
        workspaceId: input.workspaceId,
        sourceAgentId: input.sourceAgentId,
      },
    },
    select: {
      id: true,
    },
  });
  if (!client) throw new Error('Agent API client not found');

  const token = generateAgentApiKey();
  const record = await db.agentApiKey.create({
    data: {
      clientId: client.id,
      name,
      prefix: agentApiKeyPrefix(token),
      tokenHash: hashAgentApiKey(token),
      expiresAt: input.expiresAt ?? null,
    },
    select: safeKeySelect,
  });
  return { token, record };
}

export function listAgentApiKeys(input: ListAgentApiKeysInput): Promise<AgentApiKeyView[]> {
  return db.agentApiKey.findMany({
    where: {
      clientId: input.clientId,
      client: {
        endpoint: {
          publicId: input.endpointPublicId,
          workspaceId: input.workspaceId,
          sourceAgentId: input.sourceAgentId,
        },
      },
    },
    select: safeKeySelect,
    orderBy: { createdAt: 'desc' },
  });
}

export async function revokeAgentApiKey(input: RevokeAgentApiKeyInput): Promise<boolean> {
  const result = await db.agentApiKey.updateMany({
    where: {
      id: input.keyId,
      revokedAt: null,
      client: {
        endpoint: {
          publicId: input.endpointPublicId,
          workspaceId: input.workspaceId,
          sourceAgentId: input.sourceAgentId,
          workspace: { owner: { status: 'active' } },
        },
      },
    },
    data: { revokedAt: input.now ?? new Date() },
  });
  return result.count === 1;
}

async function apiKeyPrincipal(
  token: string,
  endpointPublicId: string,
  requirement: AgentApiScopeRequirement | undefined,
  now: Date,
): Promise<AgentApiPrincipal | null> {
  if (!isAgentApiKey(token)) return null;
  const key = await db.agentApiKey.findFirst({
    where: {
      tokenHash: hashAgentApiKey(token),
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      client: {
        status: 'active',
        endpoint: {
          publicId: endpointPublicId,
          status: 'active',
          currentRevisionId: { not: null },
          workspace: { owner: { status: 'active' } },
        },
      },
    },
    select: {
      id: true,
      client: {
        select: {
          id: true,
          status: true,
          scopes: true,
          rpmLimit: true,
          dailyRequestLimit: true,
          maxConcurrent: true,
          endpoint: {
            select: {
              id: true,
              publicId: true,
              workspaceId: true,
              sourceAgentId: true,
              currentRevisionId: true,
              rpmLimit: true,
              dailyRequestLimit: true,
              maxConcurrent: true,
              timeoutSeconds: true,
              retentionDays: true,
              sourceAgent: { select: { workspaceId: true } },
              workspace: { select: { owner: { select: { status: true } } } },
            },
          },
        },
      },
    },
  });
  if (!key || !key.client.endpoint.currentRevisionId || !validEndpointOwner(key.client)) return null;
  const scopes = normalizedScopes(key.client.scopes);
  if (!hasAgentApiScope(scopes, requirement)) return null;

  const touched = await db.agentApiKey.updateMany({
    where: {
      id: key.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      client: {
        status: 'active',
        endpoint: {
          publicId: endpointPublicId,
          status: 'active',
          workspace: { owner: { status: 'active' } },
        },
      },
    },
    data: { lastUsedAt: now },
  });
  if (touched.count !== 1) return null;
  return {
    credentialType: 'api_key',
    endpointId: key.client.endpoint.id,
    endpointPublicId: key.client.endpoint.publicId,
    workspaceId: key.client.endpoint.workspaceId,
    sourceAgentId: key.client.endpoint.sourceAgentId,
    revisionId: key.client.endpoint.currentRevisionId,
    clientId: key.client.id,
    keyId: key.id,
    subjectHash: null,
    origin: null,
    scopes,
    limits: limitsFor(key.client),
    rateBuckets: rateBucketsFor(key.client),
  };
}

export async function verifyAgentApiKey(
  authorization: string | null,
  endpointPublicId: string,
  requirement?: AgentApiScopeRequirement,
  now = new Date(),
): Promise<AgentApiPrincipal | null> {
  const token = bearerToken(authorization);
  if (!token?.startsWith(AGENT_API_KEY_PREFIX)) return null;
  return apiKeyPrincipal(token, endpointPublicId, requirement, now);
}

function clientTokenOrigin(input: string | null | undefined): string | null {
  if (input == null || input === '') return null;
  const origin = normalizedOrigin(input);
  if (!origin) throw new Error('Agent client token origin is invalid');
  return origin;
}

export async function mintAgentClientToken(
  input: MintAgentClientTokenInput,
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const expiresInSeconds = input.expiresInSeconds ?? AGENT_CLIENT_TOKEN_DEFAULT_AGE_SECONDS;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1
    || expiresInSeconds > AGENT_CLIENT_TOKEN_MAX_AGE_SECONDS) {
    throw new Error(`Agent client tokens may live for at most ${AGENT_CLIENT_TOKEN_MAX_AGE_SECONDS} seconds`);
  }
  const scopes = normalizedScopes(input.scopes);
  if (!scopes.length) throw new Error('Agent client token must have at least one scope');
  const origin = clientTokenOrigin(input.origin);

  const client = await db.agentApiClient.findFirst({
    where: {
      id: input.clientId,
      endpointId: input.endpointId,
      status: 'active',
      endpoint: {
        publicId: input.endpointPublicId,
        status: 'active',
        currentRevisionId: { not: null },
        workspace: { owner: { status: 'active' } },
      },
    },
    select: {
      id: true,
      scopes: true,
      endpoint: {
        select: {
          id: true,
          publicId: true,
          workspaceId: true,
          allowedOrigins: true,
          sourceAgent: { select: { workspaceId: true } },
          workspace: { select: { owner: { select: { status: true } } } },
        },
      },
    },
  });
  if (!client || !validEndpointOwner(client) || !hasAgentApiScope(client.scopes, scopes)) {
    throw new Error('Agent API client is unavailable or cannot grant the requested scopes');
  }
  if (origin && !client.endpoint.allowedOrigins.some((allowed) => normalizedOrigin(allowed) === origin)) {
    throw new Error('Agent client token origin is not allowed by this endpoint');
  }

  const subjectHash = hashAgentApiSubject(client.endpoint.id, client.id, input.subject);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + expiresInSeconds) * 1000);
  const signed = await new SignJWT({
    token_use: 'agent_client',
    endpoint_id: client.endpoint.id,
    endpoint_public_id: client.endpoint.publicId,
    client_id: client.id,
    subject_hash: subjectHash,
    origin,
    scopes,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(CLIENT_TOKEN_ISSUER)
    .setAudience(client.endpoint.publicId)
    .setSubject(subjectHash)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .sign(signingKey());
  return { token: `${AGENT_CLIENT_TOKEN_PREFIX}${signed}`, expiresAt };
}

async function clientTokenPrincipal(
  token: string,
  endpointPublicId: string,
  requirement: AgentApiScopeRequirement | undefined,
  requestOrigin: string | null,
  now: Date,
): Promise<AgentApiPrincipal | null> {
  if (!token.startsWith(AGENT_CLIENT_TOKEN_PREFIX)) return null;
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token.slice(AGENT_CLIENT_TOKEN_PREFIX.length), signingKey(), {
      algorithms: ['HS256'],
      issuer: CLIENT_TOKEN_ISSUER,
      audience: endpointPublicId,
      currentDate: now,
      clockTolerance: 5,
    }));
  } catch {
    return null;
  }

  const endpointId = typeof payload.endpoint_id === 'string' ? payload.endpoint_id : null;
  const tokenEndpointPublicId = typeof payload.endpoint_public_id === 'string'
    ? payload.endpoint_public_id
    : null;
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : null;
  const subjectHash = typeof payload.subject_hash === 'string' ? payload.subject_hash : null;
  const claimOrigin = typeof payload.origin === 'string' ? normalizedOrigin(payload.origin) : null;
  const scopes = Array.isArray(payload.scopes)
    ? normalizedScopes(payload.scopes.filter((scope): scope is AgentApiScope => typeof scope === 'string'))
    : [];
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : null;
  const expiresAt = typeof payload.exp === 'number' ? payload.exp : null;
  if (
    payload.token_use !== 'agent_client'
    || !endpointId || tokenEndpointPublicId !== endpointPublicId || !clientId || !subjectHash
    || payload.sub !== subjectHash || !scopes.length
    || issuedAt === null || expiresAt === null || expiresAt <= issuedAt
    || expiresAt - issuedAt > AGENT_CLIENT_TOKEN_MAX_AGE_SECONDS
    || issuedAt > Math.floor(now.getTime() / 1000) + 5
    || (payload.origin !== null && claimOrigin === null)
  ) return null;

  let normalizedRequestOrigin: string | null;
  try {
    normalizedRequestOrigin = clientTokenOrigin(requestOrigin);
  } catch {
    return null;
  }
  if (claimOrigin !== normalizedRequestOrigin) return null;

  const client = await db.agentApiClient.findFirst({
    where: {
      id: clientId,
      endpointId,
      status: 'active',
      endpoint: {
        publicId: endpointPublicId,
        status: 'active',
        currentRevisionId: { not: null },
        workspace: { owner: { status: 'active' } },
      },
    },
    select: {
      id: true,
      scopes: true,
      rpmLimit: true,
      dailyRequestLimit: true,
      maxConcurrent: true,
      endpoint: {
        select: {
          id: true,
          publicId: true,
          workspaceId: true,
          sourceAgentId: true,
          currentRevisionId: true,
          allowedOrigins: true,
          rpmLimit: true,
          dailyRequestLimit: true,
          maxConcurrent: true,
          timeoutSeconds: true,
          retentionDays: true,
          sourceAgent: { select: { workspaceId: true } },
          workspace: { select: { owner: { select: { status: true } } } },
        },
      },
    },
  });
  if (!client || !client.endpoint.currentRevisionId || !validEndpointOwner(client)) return null;
  if (!hasAgentApiScope(client.scopes, scopes) || !hasAgentApiScope(scopes, requirement)) return null;
  if (claimOrigin && !client.endpoint.allowedOrigins.some(
    (allowed) => normalizedOrigin(allowed) === claimOrigin,
  )) return null;

  return {
    credentialType: 'client_token',
    endpointId: client.endpoint.id,
    endpointPublicId: client.endpoint.publicId,
    workspaceId: client.endpoint.workspaceId,
    sourceAgentId: client.endpoint.sourceAgentId,
    revisionId: client.endpoint.currentRevisionId,
    clientId: client.id,
    keyId: null,
    subjectHash,
    origin: claimOrigin,
    scopes,
    limits: limitsFor(client),
    rateBuckets: rateBucketsFor(client),
  };
}

export async function verifyAgentClientToken(
  authorization: string | null,
  endpointPublicId: string,
  requirement?: AgentApiScopeRequirement,
  origin: string | null = null,
  now = new Date(),
): Promise<AgentApiPrincipal | null> {
  const token = bearerToken(authorization);
  if (!token?.startsWith(AGENT_CLIENT_TOKEN_PREFIX)) return null;
  return clientTokenPrincipal(token, endpointPublicId, requirement, origin, now);
}

/** Resolve only an Authorization Bearer credential. Cookies are never read. */
export async function resolveAgentApiPrincipal(
  request: Pick<Request, 'headers'>,
  endpointPublicId: string,
  requirement?: AgentApiScopeRequirement,
): Promise<AgentApiPrincipal | null> {
  await takeAgentApiAuthAttemptLimit(request);
  const authorization = request.headers.get('authorization');
  const token = bearerToken(authorization);
  if (!token) {
    await takeAgentApiAuthFailureLimit(request);
    return null;
  }
  const origin = request.headers.get('origin');
  if (token.startsWith(AGENT_CLIENT_TOKEN_PREFIX)) {
    const principal = await clientTokenPrincipal(token, endpointPublicId, requirement, origin, new Date());
    if (!principal) await takeAgentApiAuthFailureLimit(request);
    return principal;
  }
  // Permanent keys are server-to-server credentials and must not be accepted
  // from a browser-originated request.
  if (origin || !token.startsWith(AGENT_API_KEY_PREFIX)) {
    await takeAgentApiAuthFailureLimit(request);
    return null;
  }
  const principal = await apiKeyPrincipal(token, endpointPublicId, requirement, new Date());
  if (!principal) await takeAgentApiAuthFailureLimit(request);
  return principal;
}

/**
 * OpenAI's GET /models has no model/path parameter. Since every credential is
 * bound to exactly one Endpoint, infer only that public id and then run the
 * normal fully-scoped verifier. Unverified JWT claims are used solely as a
 * lookup hint; clientTokenPrincipal still verifies signature, issuer,
 * audience, expiry, origin, client state, and scopes.
 */
export async function resolveAgentApiPrincipalForAnyEndpoint(
  request: Pick<Request, 'headers'>,
  requirement?: AgentApiScopeRequirement,
): Promise<AgentApiPrincipal | null> {
  await takeAgentApiAuthAttemptLimit(request);
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) {
    await takeAgentApiAuthFailureLimit(request);
    return null;
  }
  const origin = request.headers.get('origin');
  if (token.startsWith(AGENT_API_KEY_PREFIX)) {
    if (origin || !isAgentApiKey(token)) {
      await takeAgentApiAuthFailureLimit(request);
      return null;
    }
    const key = await db.agentApiKey.findUnique({
      where: { tokenHash: hashAgentApiKey(token) },
      select: { client: { select: { endpoint: { select: { publicId: true } } } } },
    });
    const principal = key
      ? await apiKeyPrincipal(token, key.client.endpoint.publicId, requirement, new Date())
      : null;
    if (!principal) await takeAgentApiAuthFailureLimit(request);
    return principal;
  }
  if (!token.startsWith(AGENT_CLIENT_TOKEN_PREFIX)) {
    await takeAgentApiAuthFailureLimit(request);
    return null;
  }
  let publicId: string | null = null;
  try {
    const payload = decodeJwt(token.slice(AGENT_CLIENT_TOKEN_PREFIX.length));
    publicId = typeof payload.endpoint_public_id === 'string' ? payload.endpoint_public_id : null;
  } catch {
    await takeAgentApiAuthFailureLimit(request);
    return null;
  }
  const principal = publicId
    ? await clientTokenPrincipal(token, publicId, requirement, origin, new Date())
    : null;
  if (!principal) await takeAgentApiAuthFailureLimit(request);
  return principal;
}
