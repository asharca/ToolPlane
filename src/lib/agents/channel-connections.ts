import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { encryptSecretRecord, decryptSecretRecord, encryptSecretText, decryptSecretText } from '@/lib/security/secrets';
import { createAgentChannelToken, hashAgentChannelToken, tokenPrefix } from '@/lib/agents/channel-token';
import { pairingFromConfig, type AgentChannelPairingState } from '@/lib/agents/channel-pairing-state';
import {
  getMessagingPlatform,
  missingCreateCredentialNames,
  missingStartCredentialNames,
  type MessagingPlatform,
  type MessagingPlatformSlug,
} from '@/lib/agents/platforms';
import { hostedRunnerSpec } from '@/lib/agents/platform-runner';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { agentChannelSandboxId, getChannelSandbox } from './channel-sandboxes';

export type AgentChannelConnectionView = {
  id: string;
  agentId: string | null;
  sandboxId: string | null;
  workspaceId: string;
  platform: MessagingPlatformSlug;
  platformLabel: string;
  name: string;
  status: string;
  publicEndpointRequired: boolean;
  setupFlow: string;
  connectionMode: string;
  runnerSupported: boolean;
  credentialNames: string[];
  credentialValues: Record<string, string>;
  missingStartCredentialNames: string[];
  pairing: AgentChannelPairingState | null;
  inboundToken: string;
  inboundTokenPrefix: string;
  runnerPid: number | null;
  lastError: string | null;
  lastStartedAt: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ChannelRow = Awaited<ReturnType<typeof db.agentChannelConnection.findFirstOrThrow>>;

function asCredentialNames(raw: Prisma.JsonValue | null): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw).sort();
}

function cleanCredentials(credentials: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(credentials)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value),
  );
}

function platformCredentials(platform: MessagingPlatform, credentials: Record<string, string>) {
  return Object.fromEntries(platform.credentials
    .filter((field) => typeof credentials[field.name] === 'string')
    .map((field) => [field.name, credentials[field.name].trim()]));
}

async function hasChannelAgent(workspaceId: string, agentId: string) {
  return Boolean(await db.agent.findFirst({
    where: { id: agentId, workspaceId, ...ORDINARY_AGENT_FILTER },
    select: { id: true },
  }));
}

function statusForCredentials(platform: MessagingPlatform, credentials: Record<string, string>) {
  if (missingStartCredentialNames(platform, credentials).length) return 'setup_required';
  if (platform.publicEndpointRequired) return 'waiting_callback';
  return 'stopped';
}

function toView(row: ChannelRow): AgentChannelConnectionView | null {
  const platform = getMessagingPlatform(row.platform);
  if (!platform) return null;
  const credentials = decryptChannelCredentials(row.credentials);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    sandboxId: row.sandboxId,
    platform: platform.slug,
    platformLabel: platform.label,
    name: row.name,
    status: row.status,
    publicEndpointRequired: platform.publicEndpointRequired,
    setupFlow: platform.setupFlow,
    connectionMode: platform.connectionMode,
    runnerSupported: Boolean(hostedRunnerSpec(platform.slug)),
    credentialNames: asCredentialNames(row.credentials),
    credentialValues: Object.fromEntries(platform.credentials
      .filter((field) => !field.secret && credentials[field.name] !== undefined)
      .map((field) => [field.name, credentials[field.name]])),
    missingStartCredentialNames: missingStartCredentialNames(platform, credentials),
    pairing: pairingFromConfig(row.config),
    inboundToken: decryptSecretText(row.inboundTokenSecret),
    inboundTokenPrefix: row.inboundTokenPrefix,
    runnerPid: row.runnerPid,
    lastError: row.lastError,
    lastStartedAt: row.lastStartedAt,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAgentChannelConnections(workspaceId: string, agentId?: string, sandboxId?: string) {
  const rows = await db.agentChannelConnection.findMany({
    where: { workspaceId, agentId, sandboxId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(toView).filter((row): row is AgentChannelConnectionView => Boolean(row));
}

export async function getAgentChannelConnection(workspaceId: string, connectionId: string) {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  return row ? toView(row) : null;
}

export async function getAgentChannelConnectionRaw(connectionId: string) {
  return db.agentChannelConnection.findUnique({ where: { id: connectionId } });
}

export async function createAgentChannelConnection(params: {
  workspaceId: string;
  agentId?: string | null;
  sandboxId?: string | null;
  platform: string;
  name?: string;
  credentials: Record<string, string>;
  draft?: boolean;
}) {
  const platform = getMessagingPlatform(params.platform);
  if (!platform) return { error: `Unsupported platform: ${params.platform}` };
  if (params.agentId && !await hasChannelAgent(params.workspaceId, params.agentId)) {
    return { error: 'Agent not found.' };
  }
  const sandboxId = params.sandboxId ?? (params.agentId ? await agentChannelSandboxId(params.workspaceId, params.agentId) : null);
  const sandbox = sandboxId ? await getChannelSandbox(params.workspaceId, sandboxId) : null;
  if (sandboxId && !sandbox) return { error: 'Sandbox not found.' };
  if (sandbox && params.agentId && params.agentId !== sandbox.agentId) return { error: 'Agent is not assigned to this sandbox.' };

  const cleaned = cleanCredentials(platformCredentials(platform, params.credentials));
  const missing = missingCreateCredentialNames(platform, cleaned);
  if (!params.draft && missing.length) return { error: `Missing required credentials: ${missing.join(', ')}` };

  const token = createAgentChannelToken();
  const name = params.name?.trim() || platform.label;
  try {
    const row = await db.agentChannelConnection.create({
      data: {
        workspaceId: params.workspaceId,
        agentId: sandbox ? sandbox.agentId : params.agentId,
        sandboxId,
        platform: platform.slug,
        name,
        status: statusForCredentials(platform, cleaned),
        config: {
          setupFlow: platform.setupFlow,
          connectionMode: platform.connectionMode,
          publicEndpointRequired: platform.publicEndpointRequired,
          runner: hostedRunnerSpec(platform.slug),
        },
        credentials: encryptSecretRecord(cleaned) as Prisma.InputJsonValue,
        inboundTokenHash: hashAgentChannelToken(token),
        inboundTokenSecret: encryptSecretText(token) as Prisma.InputJsonValue,
        inboundTokenPrefix: tokenPrefix(token),
      },
    });
    return { connection: toView(row) };
  } catch {
    return { error: 'A channel with that platform and name already exists in this sandbox.' };
  }
}

export async function updateAgentChannelConnectionCredentials(params: {
  workspaceId: string;
  connectionId: string;
  credentials: Record<string, string>;
  name?: string;
  agentId?: string | null;
}): Promise<{ error?: string; connection?: AgentChannelConnectionView | null }> {
  const row = await db.agentChannelConnection.findFirst({
    where: { id: params.connectionId, workspaceId: params.workspaceId },
  });
  if (!row) return { error: 'Channel connection not found.' };
  const platform = getMessagingPlatform(row.platform);
  if (!platform) return { error: `Unsupported platform: ${row.platform}` };
  if (params.agentId && !await hasChannelAgent(params.workspaceId, params.agentId)) {
    return { error: 'Agent not found.' };
  }
  const sandbox = row.sandboxId ? await getChannelSandbox(params.workspaceId, row.sandboxId) : null;
  if (row.sandboxId && (!sandbox || (params.agentId !== undefined && params.agentId !== sandbox.agentId))) {
    return { error: 'Use channel migration to change its sandbox and Agent.' };
  }
  const sandboxId = row.sandboxId ?? (params.agentId ? await agentChannelSandboxId(params.workspaceId, params.agentId) : null);
  if (params.name !== undefined && !params.name.trim()) return { error: 'Channel name is required.' };

  const current = decryptChannelCredentials(row.credentials);
  const changes = platformCredentials(platform, params.credentials);
  // Empty password inputs preserve secrets; empty non-secret fields clear allowlists/settings.
  for (const field of platform.credentials) {
    if (field.secret && !changes[field.name]) delete changes[field.name];
  }
  const next = cleanCredentials({ ...current, ...changes });

  const { liveAgentChannelStatus, stopAgentChannelRunner, startAgentChannelRunner } = await import('@/lib/agents/channel-runtime');
  const restart = liveAgentChannelStatus(row.id) !== 'stopped';
  if (restart) await stopAgentChannelRunner(params.workspaceId, row.id);
  try {
    const updated = await db.agentChannelConnection.update({
      where: { id: row.id },
      data: {
        name: params.name?.trim(),
        agentId: params.agentId,
        sandboxId,
        status: statusForCredentials(platform, next),
        lastError: null,
        credentials: encryptSecretRecord(next) as Prisma.InputJsonValue,
      },
    });
    if (restart && updated.agentId && !missingStartCredentialNames(platform, next).length) {
      const result = await startAgentChannelRunner(params.workspaceId, row.id);
      if (result.error) return result;
    }
    return { connection: await getAgentChannelConnection(params.workspaceId, updated.id) };
  } catch (error) {
    if (restart) await startAgentChannelRunner(params.workspaceId, row.id);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return { error: 'A channel with that platform and name already exists in this sandbox.' };
    }
    throw error;
  }
}

export async function moveAgentChannelConnection(workspaceId: string, connectionId: string, sandboxId: string) {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  const target = await getChannelSandbox(workspaceId, sandboxId);
  if (!target) return { error: 'Target sandbox not found.' };
  if (row.sandboxId === target.id && row.agentId === target.agentId) return {};
  const { liveAgentChannelStatus, startAgentChannelRunner, stopAgentChannelRunner } = await import('./channel-runtime');
  const restart = liveAgentChannelStatus(connectionId) !== 'stopped';
  await stopAgentChannelRunner(workspaceId, connectionId);
  let moved = false;
  try {
    await db.agentChannelConnection.update({ where: { id: connectionId }, data: {
      sandboxId: target.id, agentId: target.agentId, status: 'stopped', runnerPid: null, lastError: null,
    } });
    moved = true;
    if (restart && target.agentId) {
      const result = await startAgentChannelRunner(workspaceId, connectionId);
      if (result.error) throw new Error(result.error);
    }
    return {};
  } catch (error) {
    if (moved) {
      await stopAgentChannelRunner(workspaceId, connectionId);
      await db.agentChannelConnection.update({ where: { id: connectionId }, data: { sandboxId: row.sandboxId, agentId: row.agentId, status: 'stopped' } });
    }
    if (restart) await startAgentChannelRunner(workspaceId, connectionId);
    return { error: error && typeof error === 'object' && 'code' in error && error.code === 'P2002'
      ? 'The target sandbox already has a channel with this platform and name.' : 'Channel migration failed; its original binding was retained.' };
  }
}

export async function deleteAgentChannelConnection(workspaceId: string, connectionId: string) {
  await db.agentChannelConnection.deleteMany({ where: { id: connectionId, workspaceId } });
}

export async function updateAgentChannelStatus(
  workspaceId: string,
  connectionId: string,
  data: {
    status: string;
    runnerPid?: number | null;
    lastError?: string | null;
    lastStartedAt?: Date | null;
    lastEventAt?: Date | null;
  },
) {
  await db.agentChannelConnection.updateMany({ where: { id: connectionId, workspaceId }, data });
}

export async function touchAgentChannelEvent(connectionId: string) {
  await db.agentChannelConnection.update({
    where: { id: connectionId },
    data: { lastEventAt: new Date(), lastError: null },
  });
}

export async function findAgentChannelByInboundToken(connectionId: string, token: string) {
  const row = await db.agentChannelConnection.findFirst({
    where: { id: connectionId, inboundTokenHash: hashAgentChannelToken(token) },
  });
  return row;
}

export function decryptChannelCredentials(raw: Prisma.JsonValue | null): Record<string, string> {
  return decryptSecretRecord(raw);
}
