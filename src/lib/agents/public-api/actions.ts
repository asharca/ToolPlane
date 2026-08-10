'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { normalizedOrigin } from '@/lib/agents/public-api/cors';
import { createAgentEndpointId } from '@/lib/agents/public-api/ids';
import { abortAgentApiRun } from '@/lib/agents/public-api/run-control';
import {
  isPinnedPublicHermesImage,
  isPublicHermesImage,
} from '@/lib/agents/hermes/constants';
import { resolveDockerImageDigest } from '@/lib/sandboxes/runtime';
import {
  AGENT_API_MAX_TIMEOUT_SECONDS,
  createAgentApiKey,
  mintAgentClientToken,
  revokeAgentApiKey,
} from '@/lib/agents/public-api/auth';

export type AgentApiActionState = {
  error?: string;
  success?: boolean;
  savedAt?: string;
  endpointId?: string;
  clientId?: string;
  token?: string;
  expiresAt?: string;
};

type ManagementContext = {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceForUser>>>;
};

async function managementContext(slug: string): Promise<ManagementContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) return null;
  if (workspace.ownerId === user.id) return { user, workspace };
  const membership = await db.membership.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    select: { role: true },
  });
  return membership?.role === 'admin' ? { user, workspace } : null;
}

function boundedInteger(formData: FormData, name: string, min: number, max: number): number | null {
  const parsed = Number(formData.get(name));
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function uniqueFormIds(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).map(String).map((value) => value.trim()).filter(Boolean))];
}

function parseAllowedOrigins(raw: string): string[] | null {
  const values = [...new Set(raw.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean))];
  if (values.length > 50) return null;
  const normalized = values.map(normalizedOrigin);
  return normalized.every((value): value is string => Boolean(value)) ? [...new Set(normalized)] : null;
}

function revalidateAgent(slug: string, agentId: string) {
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function publishAgentEndpointAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const systemPrompt = String(formData.get('systemPrompt') ?? '').trim();
  const isolationMode = String(formData.get('isolationMode') ?? '') === 'shared' ? 'shared' : 'subject';
  const rpmLimit = boundedInteger(formData, 'rpmLimit', 1, 10_000);
  const dailyRequestLimit = boundedInteger(formData, 'dailyRequestLimit', 1, 1_000_000);
  const dailyOutputCharacterLimit = boundedInteger(
    formData,
    'dailyOutputCharacterLimit',
    200_000,
    1_000_000_000,
  );
  const maxConcurrent = boundedInteger(formData, 'maxConcurrent', 1, 100);
  const maxRuntimes = boundedInteger(formData, 'maxRuntimes', 1, 1_000);
  const maxStoredCharacters = boundedInteger(
    formData,
    'maxStoredCharacters',
    220_000,
    1_000_000_000,
  );
  const timeoutSeconds = boundedInteger(
    formData,
    'timeoutSeconds',
    10,
    AGENT_API_MAX_TIMEOUT_SECONDS,
  );
  const retentionDays = boundedInteger(formData, 'retentionDays', 0, 365);
  const allowedOrigins = parseAllowedOrigins(String(formData.get('allowedOrigins') ?? ''));
  const deploymentIds = uniqueFormIds(formData, 'deploymentIds');
  const installedSkillIds = uniqueFormIds(formData, 'skillIds');

  if (
    !agentId || !name || name.length > 80 || systemPrompt.length > 20_000
    || rpmLimit === null || dailyRequestLimit === null || dailyOutputCharacterLimit === null
    || maxConcurrent === null || maxRuntimes === null || maxStoredCharacters === null
    || timeoutSeconds === null || retentionDays === null || !allowedOrigins
  ) return { error: 'The Agent API configuration is invalid.' };

  const ctx = await managementContext(slug);
  if (!ctx) return { error: 'Only a workspace owner or administrator can publish an Agent API.' };

  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId: ctx.workspace.id, publicRuntimeAllocation: { is: null } },
    select: {
      id: true,
      maxSteps: true,
      runtime: { select: { kind: true, image: true } },
      modelProviders: { select: { providerId: true } },
    },
  });
  if (!agent || agent.runtime?.kind !== 'hermes') {
    return { error: 'Only a Hermes Agent can be published.' };
  }
  const sourceRuntimeImage = agent.runtime.image;
  if (!isPublicHermesImage(sourceRuntimeImage)) {
    return {
      error: 'Public Agent APIs require a reviewed versioned Hermes image or an operator-allowlisted digest.',
    };
  }
  let runtimeImage: string;
  try {
    runtimeImage = await resolveDockerImageDigest(sourceRuntimeImage);
  } catch {
    return { error: 'The reviewed Hermes image could not be pulled and pinned to a registry digest.' };
  }
  if (!isPinnedPublicHermesImage(runtimeImage)) {
    return { error: 'The Hermes image registry did not return an approved immutable digest.' };
  }
  const providerIds = agent.modelProviders.map((link) => link.providerId);
  if (providerIds.length === 0) return { error: 'Select at least one model provider before publishing.' };

  const [deployments, skills] = await Promise.all([
    db.deployment.findMany({
      where: { id: { in: deploymentIds }, workspaceId: ctx.workspace.id },
      select: {
        id: true,
        mcpToolExposure: true,
        mcpAllowedTools: true,
        publicInvocable: true,
      },
    }),
    db.installedSkill.findMany({
      where: { id: { in: installedSkillIds }, workspaceId: ctx.workspace.id, agentInvocable: true },
      select: { id: true },
    }),
  ]);
  if (deployments.length !== deploymentIds.length) return { error: 'One or more MCP deployments are unavailable.' };
  const unsafeDeployment = deployments.find((deployment) => (
    !deployment.publicInvocable
    || deployment.mcpToolExposure !== 'allowlist'
    || deployment.mcpAllowedTools.length === 0
  ));
  if (unsafeDeployment) {
    return {
      error: 'Every public MCP deployment must be explicitly approved for public Agents and use a non-empty tool allowlist.',
    };
  }
  if (skills.length !== installedSkillIds.length) {
    return { error: 'One or more selected skills are unavailable or not Agent-invocable.' };
  }

  const toolPolicy = Object.fromEntries(deployments.map((deployment) => [
    deployment.id,
    [...new Set(deployment.mcpAllowedTools)].sort(),
  ]));

  try {
    const publicId = await db.$transaction(async (tx) => {
      let endpoint = await tx.agentEndpoint.findUnique({
        where: { sourceAgentId: agent.id },
        select: { id: true, publicId: true },
      });
      if (!endpoint) {
        endpoint = await tx.agentEndpoint.create({
          data: {
            publicId: createAgentEndpointId(),
            workspaceId: ctx.workspace.id,
            sourceAgentId: agent.id,
            createdById: ctx.user.id,
            name,
            status: 'disabled',
            isolationMode,
            rpmLimit,
            dailyRequestLimit,
            dailyOutputCharacterLimit,
            maxConcurrent,
            maxRuntimes,
            maxStoredCharacters,
            timeoutSeconds,
            retentionDays,
            allowedOrigins,
          },
          select: { id: true, publicId: true },
        });
      } else {
        await tx.agentEndpoint.update({
          where: { id: endpoint.id },
          data: {
            name,
            isolationMode,
            rpmLimit,
            dailyRequestLimit,
            dailyOutputCharacterLimit,
            maxConcurrent,
            maxRuntimes,
            maxStoredCharacters,
            timeoutSeconds,
            retentionDays,
            allowedOrigins,
          },
        });
      }

      const latest = await tx.agentEndpointRevision.aggregate({
        where: { endpointId: endpoint.id },
        _max: { version: true },
      });
      const revision = await tx.agentEndpointRevision.create({
        data: {
          endpointId: endpoint.id,
          version: (latest._max.version ?? 0) + 1,
          systemPrompt,
          maxSteps: Math.max(1, Math.min(agent.maxSteps, 20)),
          runtimeImage,
          providerIds,
          deploymentIds,
          installedSkillIds,
          toolPolicy: toolPolicy as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.agentEndpoint.update({
        where: { id: endpoint.id },
        data: { currentRevisionId: revision.id },
      });
      return endpoint.publicId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    revalidateAgent(slug, agentId);
    return { success: true, savedAt: new Date().toISOString(), endpointId: publicId };
  } catch {
    return { error: 'The endpoint could not be published. Retry the request.' };
  }
}

export async function setAgentEndpointStatusAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const publicId = String(formData.get('endpointId') ?? '');
  const status = String(formData.get('status') ?? '') === 'active' ? 'active' : 'disabled';
  const ctx = await managementContext(slug);
  if (!ctx) return;
  const endpoint = await db.agentEndpoint.findFirst({
    where: {
      publicId,
      workspaceId: ctx.workspace.id,
      sourceAgentId: agentId,
      ...(status === 'active' ? { currentRevisionId: { not: null } } : {}),
    },
    select: { id: true },
  });
  if (!endpoint) return;
  await db.agentEndpoint.update({ where: { id: endpoint.id }, data: { status } });
  if (status === 'disabled') {
    const activeRuns = await db.agentRun.findMany({
      where: { endpointId: endpoint.id, status: { in: ['provisioning', 'running'] } },
      select: { id: true, publicId: true },
    });
    await db.agentRun.updateMany({
      where: { id: { in: activeRuns.map((run) => run.id) } },
      data: { cancelRequestedAt: new Date() },
    });
    for (const run of activeRuns) abortAgentApiRun(run.publicId);
  }
  revalidateAgent(slug, agentId);
}

export async function createAgentApiClientAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const publicId = String(formData.get('endpointId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  if (!name || name.length > 80) return { error: 'Client name is required.' };
  const ctx = await managementContext(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const endpoint = await db.agentEndpoint.findFirst({
    where: { publicId, workspaceId: ctx.workspace.id, sourceAgentId: agentId },
    select: {
      id: true,
      rpmLimit: true,
      dailyRequestLimit: true,
      dailyOutputCharacterLimit: true,
      maxConcurrent: true,
      maxStoredCharacters: true,
    },
  });
  if (!endpoint) return { error: 'Endpoint not found.' };

  const client = await db.agentApiClient.create({
    data: {
      endpointId: endpoint.id,
      createdById: ctx.user.id,
      name,
      rpmLimit: endpoint.rpmLimit,
      dailyRequestLimit: endpoint.dailyRequestLimit,
      dailyOutputCharacterLimit: endpoint.dailyOutputCharacterLimit,
      maxConcurrent: endpoint.maxConcurrent,
      maxStoredCharacters: endpoint.maxStoredCharacters,
    },
    select: { id: true },
  });
  const key = await createAgentApiKey({
    clientId: client.id,
    endpointPublicId: publicId,
    workspaceId: ctx.workspace.id,
    sourceAgentId: agentId,
    name: 'Default',
  });
  revalidateAgent(slug, agentId);
  return {
    success: true,
    savedAt: new Date().toISOString(),
    clientId: client.id,
    token: key.token,
  };
}

export async function revokeAgentApiKeyAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const publicId = String(formData.get('endpointId') ?? '');
  const keyId = String(formData.get('keyId') ?? '');
  const ctx = await managementContext(slug);
  if (!ctx) return;
  await revokeAgentApiKey({
    keyId,
    endpointPublicId: publicId,
    workspaceId: ctx.workspace.id,
    sourceAgentId: agentId,
  });
  revalidateAgent(slug, agentId);
}

export async function createAgentApiKeyAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const publicId = String(formData.get('endpointId') ?? '');
  const clientId = String(formData.get('clientId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  if (!clientId || !name || name.length > 80) return { error: 'Key name is required.' };
  const ctx = await managementContext(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const client = await db.agentApiClient.findFirst({
    where: {
      id: clientId,
      status: 'active',
      endpoint: {
        publicId,
        workspaceId: ctx.workspace.id,
        sourceAgentId: agentId,
      },
    },
    select: { id: true },
  });
  if (!client) return { error: 'API client not found.' };
  try {
    const key = await createAgentApiKey({
      clientId: client.id,
      endpointPublicId: publicId,
      workspaceId: ctx.workspace.id,
      sourceAgentId: agentId,
      name,
    });
    revalidateAgent(slug, agentId);
    return { success: true, savedAt: new Date().toISOString(), clientId, token: key.token };
  } catch {
    return { error: 'The API key could not be created.' };
  }
}

export async function createAgentClientTokenAction(
  _previous: AgentApiActionState,
  formData: FormData,
): Promise<AgentApiActionState> {
  const slug = String(formData.get('workspace') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  const publicId = String(formData.get('endpointId') ?? '');
  const clientId = String(formData.get('clientId') ?? '');
  const subject = String(formData.get('subject') ?? '').trim();
  const requestedOrigin = normalizedOrigin(String(formData.get('origin') ?? ''));
  if (!clientId || !subject || subject.length > 200 || !requestedOrigin) {
    return { error: 'Client, subject and an allowed browser origin are required.' };
  }
  const ctx = await managementContext(slug);
  if (!ctx) return { error: 'Not authorized.' };
  const client = await db.agentApiClient.findFirst({
    where: {
      id: clientId,
      status: 'active',
      endpoint: { publicId, workspaceId: ctx.workspace.id, sourceAgentId: agentId },
    },
    include: { endpoint: { select: { id: true, publicId: true, allowedOrigins: true } } },
  });
  if (!client) return { error: 'API client not found.' };
  if (!client.endpoint.allowedOrigins.includes(requestedOrigin)) {
    return { error: 'The selected browser origin is not allowed by this endpoint.' };
  }
  const minted = await mintAgentClientToken({
    endpointId: client.endpoint.id,
    endpointPublicId: client.endpoint.publicId,
    clientId: client.id,
    subject,
    scopes: ['responses:create', 'responses:read', 'conversations:read', 'conversations:delete'],
    expiresInSeconds: 15 * 60,
    origin: requestedOrigin,
  });
  return { success: true, token: minted.token, expiresAt: minted.expiresAt.toISOString() };
}
