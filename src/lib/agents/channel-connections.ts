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

export type AgentChannelConnectionView = {
  id: string;
  agentId: string;
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
    platform: platform.slug,
    platformLabel: platform.label,
    name: row.name,
    status: row.status,
    publicEndpointRequired: platform.publicEndpointRequired,
    setupFlow: platform.setupFlow,
    connectionMode: platform.connectionMode,
    runnerSupported: Boolean(hostedRunnerSpec(platform.slug)),
    credentialNames: asCredentialNames(row.credentials),
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

export async function listAgentChannelConnections(workspaceId: string, agentId: string) {
  const rows = await db.agentChannelConnection.findMany({
    where: { workspaceId, agentId },
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
  agentId: string;
  platform: string;
  name?: string;
  credentials: Record<string, string>;
}) {
  const platform = getMessagingPlatform(params.platform);
  if (!platform) return { error: `Unsupported platform: ${params.platform}` };
  const agent = await db.agent.findFirst({
    where: { id: params.agentId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!agent) return { error: 'Agent not found.' };

  const cleaned = cleanCredentials(params.credentials);
  const missing = missingCreateCredentialNames(platform, cleaned);
  if (missing.length) return { error: `Missing required credentials: ${missing.join(', ')}` };

  const token = createAgentChannelToken();
  const name = params.name?.trim() || platform.label;
  try {
    const row = await db.agentChannelConnection.create({
      data: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
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
    return { error: 'A channel with that platform and name already exists for this agent.' };
  }
}

export async function updateAgentChannelConnectionCredentials(params: {
  workspaceId: string;
  connectionId: string;
  credentials: Record<string, string>;
}) {
  const row = await db.agentChannelConnection.findFirst({
    where: { id: params.connectionId, workspaceId: params.workspaceId },
  });
  if (!row) return { error: 'Channel connection not found.' };
  const platform = getMessagingPlatform(row.platform);
  if (!platform) return { error: `Unsupported platform: ${row.platform}` };

  const current = decryptChannelCredentials(row.credentials);
  const next = { ...current, ...cleanCredentials(params.credentials) };
  const missing = missingCreateCredentialNames(platform, next);
  if (missing.length) return { error: `Missing required credentials: ${missing.join(', ')}` };

  const nextStatus = row.status === 'running' ? row.status : statusForCredentials(platform, next);
  const updated = await db.agentChannelConnection.update({
    where: { id: row.id },
    data: {
      status: nextStatus,
      lastError: null,
      credentials: encryptSecretRecord(next) as Prisma.InputJsonValue,
    },
  });
  return { connection: toView(updated) };
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
