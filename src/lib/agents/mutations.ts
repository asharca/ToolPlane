import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { conversationTitleFromParts } from '@/lib/agents/conversation-title';
import { defaultProviderModel, type ProviderModelValues } from '@/lib/agents/model-catalog';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { hermesProviderName } from '@/lib/agents/hermes/config';
import { withoutHermesChannelEnv } from '@/lib/agents/hermes/env-merge-script';
import { HERMES_PROFILE_NAME } from '@/lib/agents/hermes/profiles';
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isDedicatedSandboxRuntimeKind,
  type ImplementedAgentRuntimeKind,
} from '@/lib/agents/runtime-kind';
import { DEFAULT_SANDBOX_IMAGE, sandboxVolumeName } from '@/lib/sandboxes/runtime';
import { readSandboxEnv, sandboxConfigWithEnv, type SandboxEnv } from '@/lib/sandboxes/env';
import { parseAgentMarketResourceMap } from '@/lib/agents/market-setup';

const UNAVAILABLE_SANDBOX_STATUSES = [
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
  'upgrading',
  'deleting',
];

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'agent';
}

async function lockAgentSlugNamespace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`agent-slug:${workspaceId}`}, 0)
    )::text AS "lock"
  `;
}

async function uniqueAgentSlug(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  let slug = baseSlug;
  for (let i = 1; await tx.agent.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${baseSlug}-${i}`;
  }
  return slug;
}

export type CreateAgentOptions = {
  runtime: ImplementedAgentRuntimeKind;
  hermesImage?: string;
  allowSudo?: boolean;
};

export type AgentCloneOptions = {
  copyMcp?: boolean;
  copySkills?: boolean;
  copyToolkits?: boolean;
  copySandboxes?: boolean;
  copySubAgents?: boolean;
  copyConversations?: boolean;
  copyHermesEnvironment?: boolean;
  copyHermesVolume?: boolean;
};

export const DEFAULT_AGENT_CLONE_OPTIONS: Required<AgentCloneOptions> = {
  copyMcp: true,
  copySkills: true,
  copyToolkits: true,
  copySandboxes: true,
  copySubAgents: true,
  copyConversations: false,
  copyHermesEnvironment: false,
  copyHermesVolume: false,
};

function normalizeCloneOptions(options: AgentCloneOptions | undefined): Required<AgentCloneOptions> {
  return {
    copyMcp: options?.copyMcp ?? DEFAULT_AGENT_CLONE_OPTIONS.copyMcp,
    copySkills: options?.copySkills ?? DEFAULT_AGENT_CLONE_OPTIONS.copySkills,
    copyToolkits: options?.copyToolkits ?? DEFAULT_AGENT_CLONE_OPTIONS.copyToolkits,
    copySandboxes: options?.copySandboxes ?? DEFAULT_AGENT_CLONE_OPTIONS.copySandboxes,
    copySubAgents: options?.copySubAgents ?? DEFAULT_AGENT_CLONE_OPTIONS.copySubAgents,
    copyConversations: options?.copyConversations ?? DEFAULT_AGENT_CLONE_OPTIONS.copyConversations,
    copyHermesEnvironment: options?.copyHermesEnvironment
      ?? DEFAULT_AGENT_CLONE_OPTIONS.copyHermesEnvironment,
    copyHermesVolume: options?.copyHermesVolume ?? DEFAULT_AGENT_CLONE_OPTIONS.copyHermesVolume,
  };
}

async function uniqueSandboxSlug(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  baseSlug: string,
  suffix = 'runtime',
): Promise<string> {
  let slug = `${baseSlug}-${suffix}`;
  for (let i = 1; await tx.sandbox.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${baseSlug}-${suffix}-${i}`;
  }
  return slug;
}

async function createDedicatedSandboxRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agent: { id: string; name: string },
  sandboxSlug: string,
) {
  const deployment = await tx.deployment.create({
    data: {
      workspaceId,
      name: `Sandbox: ${agent.name} Workspace`,
      source: 'sandbox',
      sourceRef: DEFAULT_SANDBOX_IMAGE,
      status: 'stopped',
    },
  });
  const sandbox = await tx.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: `${agent.name} Workspace`,
      slug: sandboxSlug,
      kind: 'docker',
      image: DEFAULT_SANDBOX_IMAGE,
      network: 'isolated',
      agentLinks: { create: { agentId: agent.id, isDefault: true } },
    },
  });
  await tx.deployment.update({
    where: { id: deployment.id },
    data: {
      installCfg: {
        sandboxId: sandbox.id,
        kind: 'docker',
        image: DEFAULT_SANDBOX_IMAGE,
        network: 'isolated',
        volumeName: sandboxVolumeName(sandbox.id),
        env: {},
        allowSudo: false,
      },
    },
  });
}

export async function createAgentRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  name: string,
  slug: string,
  options: CreateAgentOptions,
  sandboxSlug?: string,
) {
  const agent = await tx.agent.create({
    data: { workspaceId, name, slug, runtimeKind: options.runtime },
  });
  if (options.runtime !== HERMES_RUNTIME_KIND) return agent;
  if (!sandboxSlug) throw new Error('A Hermes agent requires a sandbox slug.');

  const image = resolveHermesImage(options.hermesImage);
  const deployment = await tx.deployment.create({
    data: {
      workspaceId,
      name: `Hermes runtime: ${name}`,
      source: 'sandbox',
      sourceRef: image,
      status: 'stopped',
    },
  });
  const sandbox = await tx.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: `${name} Hermes`,
      slug: sandboxSlug,
      kind: HERMES_RUNTIME_KIND,
      image,
      network: 'isolated',
      config: { managedBy: 'agent-runtime', ...(options.allowSudo ? { allowSudo: true } : {}) },
    },
  });
  const runtime = await tx.agentRuntime.create({
    data: {
      workspaceId,
      agentId: agent.id,
      sandboxId: sandbox.id,
      kind: HERMES_RUNTIME_KIND,
      image,
      status: 'setup_required',
    },
  });
  await tx.deployment.update({
    where: { id: deployment.id },
    data: {
      installCfg: {
        sandboxId: sandbox.id,
        kind: HERMES_RUNTIME_KIND,
        image,
        network: 'isolated',
        volumeName: sandboxVolumeName(sandbox.id),
        runtimeId: runtime.id,
        runtimeModelName: slug,
        env: {},
        ...(options.allowSudo ? { allowSudo: true } : {}),
      },
    },
  });
  return agent;
}

export async function createAgent(
  workspaceId: string,
  name: string,
  options: CreateAgentOptions,
) {
  const cleanName = name.trim() || 'New agent';
  return db.$transaction(async (tx) => {
    await lockAgentSlugNamespace(tx, workspaceId);
    const slug = await uniqueAgentSlug(tx, workspaceId, slugify(cleanName));
    const isDedicated = isDedicatedSandboxRuntimeKind(options.runtime);
    const sandboxSlug = options.runtime === HERMES_RUNTIME_KIND || isDedicated
      ? await uniqueSandboxSlug(tx, workspaceId, slug, isDedicated ? 'workspace' : 'runtime')
      : undefined;
    const agent = await createAgentRecords(tx, workspaceId, cleanName, slug, options, sandboxSlug);
    if (isDedicated && sandboxSlug) {
      await createDedicatedSandboxRecords(tx, workspaceId, agent, sandboxSlug);
    }
    return agent;
  });
}

export async function cloneAgent(
  workspaceId: string,
  sourceAgentId: string,
  requestedName?: string,
  options?: AgentCloneOptions,
) {
  const cloneOptions = normalizeCloneOptions(options);
  const source = await db.agent.findFirst({
    where: { id: sourceAgentId, workspaceId },
    select: {
      name: true,
      runtimeKind: true,
      systemPrompt: true,
      providerId: true,
      model: true,
      modelProviders: {
        where: { provider: { workspaceId } },
        select: { providerId: true },
      },
      maxSteps: true,
      runtime: {
        select: {
          workspaceId: true,
          kind: true,
          image: true,
          sandbox: { select: { workspaceId: true, config: true } },
        },
      },
      servers: {
        where: { deployment: { workspaceId } },
        select: { deploymentId: true },
      },
      skills: {
        where: { installedSkill: { workspaceId } },
        select: { installedSkillId: true },
      },
      toolkits: {
        where: { toolkit: { workspaceId } },
        select: { toolkitId: true },
      },
      sandboxes: {
        where: {
          sandbox: {
            workspaceId,
            kind: { not: HERMES_RUNTIME_KIND },
            deployment: {
              status: { notIn: UNAVAILABLE_SANDBOX_STATUSES },
            },
          },
        },
        select: {
          sandboxId: true,
          isDefault: true,
          sandbox: { select: { kind: true, network: true } },
        },
      },
      knowledgeBases: {
        where: { knowledgeBase: { workspaceId } },
        select: { knowledgeBaseId: true },
      },
      subAgents: {
        where: { child: { workspaceId } },
        select: { childId: true },
      },
    },
  });
  if (!source) return null;

  const cleanName = requestedName?.trim() || `${source.name} copy`;
  if (isDedicatedSandboxRuntimeKind(source.runtimeKind)) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(source.runtimeKind)} uses an exclusive sandbox and cannot be cloned without a new sandbox. Create a new agent and select an unassigned sandbox.`,
    );
  }
  let runtime: CreateAgentOptions;
  if (
    source.runtimeKind === HERMES_RUNTIME_KIND
    && source.runtime?.workspaceId === workspaceId
    && source.runtime.kind === HERMES_RUNTIME_KIND
    && source.runtime.sandbox.workspaceId === workspaceId
  ) {
    runtime = { runtime: 'hermes', hermesImage: source.runtime.image };
  } else {
    throw new Error(`Agent runtime "${source.runtimeKind}" is not available for cloning.`);
  }
  if (cloneOptions.copySandboxes && source.sandboxes.length > 0) {
    throw new AgentConfigurationError(
      'Sandboxes are exclusive to one agent and cannot be reused by a clone. Clear sandbox bindings before cloning.',
    );
  }
  if (runtime.runtime === HERMES_RUNTIME_KIND
    && cloneOptions.copyConversations
    && !cloneOptions.copyHermesVolume) {
    throw new AgentConfigurationError(
      'Hermes conversations can only be cloned with the Hermes persistent volume.',
    );
  }
  // A Hermes volume contains the files referenced by conversations and their
  // runtime session state. Keep those database records together with a volume
  // clone, even if a stale/non-UI caller omitted the dependent checkbox.
  const effectiveCloneOptions = runtime.runtime === HERMES_RUNTIME_KIND && cloneOptions.copyHermesVolume
    ? { ...cloneOptions, copyConversations: true }
    : cloneOptions;
  return db.$transaction(async (tx) => {
    await lockAgentSlugNamespace(tx, workspaceId);
    const slug = await uniqueAgentSlug(tx, workspaceId, slugify(cleanName));
    const sandboxSlug = runtime.runtime === HERMES_RUNTIME_KIND
      ? await uniqueSandboxSlug(tx, workspaceId, slug)
      : undefined;
    let providerId: string | null = null;
    if (runtime.runtime !== HERMES_RUNTIME_KIND && source.providerId) {
      const provider = await lockProvider(tx, workspaceId, source.providerId);
      if (provider) {
        assertRuntimeProviderFormat(runtime.runtime, provider.format);
        providerId = provider.id;
      }
    }
    const modelProviderIds: string[] = [];
    if (runtime.runtime === HERMES_RUNTIME_KIND) {
      const requestedIds = source.modelProviders.length > 0
        ? source.modelProviders.map((link) => link.providerId)
        : source.providerId ? [source.providerId] : [];
      for (const requestedId of [...new Set(requestedIds)].sort()) {
        const provider = await lockProvider(tx, workspaceId, requestedId);
        if (provider) modelProviderIds.push(provider.id);
      }
    }
    const cloned = await createAgentRecords(
      tx,
      workspaceId,
      cleanName,
      slug,
      runtime,
      sandboxSlug,
    );
    await tx.agent.update({
      where: { id: cloned.id },
      data: {
        systemPrompt: runtime.runtime === HERMES_RUNTIME_KIND ? null : source.systemPrompt,
        providerId,
        model: runtime.runtime === HERMES_RUNTIME_KIND ? null : providerId ? source.model : null,
        maxSteps: source.maxSteps,
      },
    });
    if (
      runtime.runtime === HERMES_RUNTIME_KIND
      && effectiveCloneOptions.copyHermesEnvironment
      && source.runtime?.sandbox
    ) {
      const env = readSandboxEnv(source.runtime.sandbox.config);
      const targetRuntime = await tx.agentRuntime.findUniqueOrThrow({
        where: { agentId: cloned.id },
        select: {
          id: true,
          sandboxId: true,
          image: true,
          sandbox: { select: { deploymentId: true, config: true } },
        },
      });
      await Promise.all([
        tx.sandbox.update({
          where: { id: targetRuntime.sandboxId },
          data: { config: sandboxConfigWithEnv(targetRuntime.sandbox.config, env) ?? {} },
        }),
        tx.deployment.update({
          where: { id: targetRuntime.sandbox.deploymentId },
          data: {
            installCfg: {
              sandboxId: targetRuntime.sandboxId,
              kind: HERMES_RUNTIME_KIND,
              image: targetRuntime.image,
              network: 'isolated',
              volumeName: sandboxVolumeName(targetRuntime.sandboxId),
              runtimeId: targetRuntime.id,
              runtimeModelName: slug,
              env: withoutHermesChannelEnv(env),
            },
          },
        }),
      ]);
    }
    await Promise.all([
      tx.agentServer.createMany({
        data: (effectiveCloneOptions.copyMcp ? source.servers : []).map((server) => ({
          agentId: cloned.id,
          deploymentId: server.deploymentId,
        })),
      }),
      tx.agentSkill.createMany({
        data: (effectiveCloneOptions.copySkills ? source.skills : []).map((skill) => ({
          agentId: cloned.id,
          installedSkillId: skill.installedSkillId,
        })),
      }),
      tx.agentToolkit.createMany({
        data: (effectiveCloneOptions.copyToolkits ? source.toolkits : []).map((toolkit) => ({
          agentId: cloned.id,
          toolkitId: toolkit.toolkitId,
        })),
      }),
      tx.agentSandbox.createMany({
        data: (effectiveCloneOptions.copySandboxes ? source.sandboxes : []).map((sandbox) => ({
          agentId: cloned.id,
          sandboxId: sandbox.sandboxId,
          isDefault: sandbox.isDefault,
        })),
      }),
      tx.agentKnowledgeBase.createMany({
        data: source.knowledgeBases.map((link) => ({
          agentId: cloned.id,
          knowledgeBaseId: link.knowledgeBaseId,
        })),
      }),
      tx.agentSubAgent.createMany({
        data: (effectiveCloneOptions.copySubAgents ? source.subAgents : []).map((subAgent) => ({
          parentId: cloned.id,
          childId: subAgent.childId,
        })),
      }),
      tx.agentModelProvider.createMany({
        data: modelProviderIds.map((modelProviderId) => ({
          agentId: cloned.id,
          providerId: modelProviderId,
        })),
      }),
    ]);
    const conversationsDeferred = runtime.runtime === HERMES_RUNTIME_KIND
      && effectiveCloneOptions.copyHermesVolume
      && effectiveCloneOptions.copyConversations;
    const conversationIds = effectiveCloneOptions.copyConversations && !conversationsDeferred
      ? await cloneAgentConversationsInTransaction(
          tx,
          workspaceId,
          sourceAgentId,
          cloned.id,
          false,
        )
      : [];
    return { ...cloned, conversationIds, conversationsDeferred };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export type AgentCloneConversationId = { sourceId: string; targetId: string };

type SourceConversationForClone = {
  id: string;
  title: string | null;
  runtimeSessionId: string | null;
  runtimeSessionKey: string | null;
  hermesProfile: string | null;
  hermesProvider: string | null;
  hermesModel: string | null;
  reasoningEffort: string | null;
  createdAt: Date;
  messages: Array<{
    role: string;
    parts: Prisma.JsonValue;
    createdAt: Date;
  }>;
};

function copiedMessageParts(parts: Prisma.JsonValue) {
  // Prisma distinguishes JSON null from SQL NULL for required Json fields.
  // A historic message can legitimately contain the former.
  return parts === null ? Prisma.JsonNull : parts as Prisma.InputJsonValue;
}

async function copyConversationsInTransaction(
  tx: Prisma.TransactionClient,
  sourceAgentId: string,
  targetAgentId: string,
  sourceConversations: ReadonlyArray<SourceConversationForClone>,
  preserveHermesSession: boolean,
): Promise<AgentCloneConversationId[]> {
  const conversationIds: AgentCloneConversationId[] = [];
  for (const conversation of sourceConversations) {
    // Before runtime aliases existed, external-message conversations used the
    // deterministic session key as their title. Recover that identity so a
    // copied Hermes volume can continue those legacy channel sessions too.
    const legacyMessagingSessionKey = conversation.title?.startsWith('msg:')
      ? conversation.title
      : undefined;
    const runtimeSession = preserveHermesSession
      ? defaultConversationRuntimeSession(sourceAgentId, conversation.id, {
          runtimeSessionId: conversation.runtimeSessionId ?? undefined,
          runtimeSessionKey: conversation.runtimeSessionKey ?? legacyMessagingSessionKey,
        })
      : undefined;
    const copiedConversation = await tx.conversation.create({
      data: {
        agentId: targetAgentId,
        title: conversation.title,
        createdAt: conversation.createdAt,
        reasoningEffort: conversation.reasoningEffort,
        ...(runtimeSession ?? {}),
        ...(preserveHermesSession ? {
          hermesProfile: conversation.hermesProfile,
          hermesProvider: conversation.hermesProvider,
          hermesModel: conversation.hermesModel,
        } : {}),
      },
    });
    conversationIds.push({ sourceId: conversation.id, targetId: copiedConversation.id });
    if (conversation.messages.length > 0) {
      await tx.message.createMany({
        data: conversation.messages.map((message) => ({
          conversationId: copiedConversation.id,
          role: message.role,
          parts: copiedMessageParts(message.parts),
          createdAt: message.createdAt,
        })),
      });
    }
  }
  return conversationIds;
}

async function cloneAgentConversationsInTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
  preserveHermesSession: boolean,
): Promise<AgentCloneConversationId[]> {
  const [source, target] = await Promise.all([
    tx.agent.findFirst({
      where: { id: sourceAgentId, workspaceId },
      select: {
        conversations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            title: true,
            runtimeSessionId: true,
            runtimeSessionKey: true,
            hermesProfile: true,
            hermesProvider: true,
            hermesModel: true,
            reasoningEffort: true,
            createdAt: true,
            messages: {
              orderBy: { createdAt: 'asc' },
              select: { role: true, parts: true, createdAt: true },
            },
          },
        },
      },
    }),
    tx.agent.findFirst({
      where: { id: targetAgentId, workspaceId },
      select: { id: true },
    }),
  ]);
  if (!source || !target) throw new Error('The source or target agent is no longer available.');
  return copyConversationsInTransaction(
    tx,
    sourceAgentId,
    target.id,
    source.conversations,
    preserveHermesSession,
  );
}

export type HermesVolumeCloneData = {
  conversationIds: AgentCloneConversationId[];
  attachmentCount: number;
};

/**
 * Copies the database records that point into a Hermes volume. This runs only
 * after the physical volume is quiesced and copied, so the files, attachment
 * records, conversation history, and Hermes session aliases share one point
 * in time. The transaction also prevents orphaned attachment mappings.
 */
export async function cloneHermesVolumeData(
  workspaceId: string,
  sourceAgentId: string,
  targetAgentId: string,
): Promise<HermesVolumeCloneData> {
  return db.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.agent.findFirst({
        where: { id: sourceAgentId, workspaceId },
        select: {
          runtime: {
            select: {
              kind: true,
              workspaceId: true,
              sandbox: { select: { workspaceId: true } },
            },
          },
          conversations: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              title: true,
              runtimeSessionId: true,
              runtimeSessionKey: true,
              hermesProfile: true,
              hermesProvider: true,
              hermesModel: true,
              reasoningEffort: true,
              createdAt: true,
              messages: {
                orderBy: { createdAt: 'asc' },
                select: { role: true, parts: true, createdAt: true },
              },
            },
          },
          attachments: {
            where: { storage: 'hermes-volume' },
            select: {
              conversationId: true,
              name: true,
              mimeType: true,
              size: true,
              storage: true,
              storagePath: true,
              createdAt: true,
            },
          },
        },
      }),
      tx.agent.findFirst({
        where: { id: targetAgentId, workspaceId },
        select: {
          id: true,
          runtime: {
            select: {
              id: true,
              kind: true,
              workspaceId: true,
              sandbox: { select: { workspaceId: true } },
            },
          },
        },
      }),
    ]);
    const sourceHermesRuntime = source?.runtime;
    const targetHermesRuntime = target?.runtime;
    if (
      !source
      || !target
      || sourceHermesRuntime?.kind !== HERMES_RUNTIME_KIND
      || targetHermesRuntime?.kind !== HERMES_RUNTIME_KIND
      || sourceHermesRuntime.workspaceId !== workspaceId
      || targetHermesRuntime.workspaceId !== workspaceId
      || sourceHermesRuntime.sandbox.workspaceId !== workspaceId
      || targetHermesRuntime.sandbox.workspaceId !== workspaceId
    ) {
      throw new Error('Source and target must be workspace-owned Hermes agents.');
    }

    const conversationIds = await copyConversationsInTransaction(
      tx,
      sourceAgentId,
      target.id,
      source.conversations,
      true,
    );
    if (source.attachments.length === 0) return { conversationIds, attachmentCount: 0 };

    const targetConversationBySource = new Map(
      conversationIds.map(({ sourceId, targetId }) => [sourceId, targetId]),
    );
    const copiedAttachments = await tx.agentAttachment.createMany({
      data: source.attachments.map((attachment) => ({
        workspaceId,
        agentId: target.id,
        conversationId: attachment.conversationId
          ? targetConversationBySource.get(attachment.conversationId) ?? null
          : null,
        runtimeId: targetHermesRuntime.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        storage: attachment.storage,
        storagePath: attachment.storagePath,
        createdAt: attachment.createdAt,
      })),
    });
    return { conversationIds, attachmentCount: copiedAttachments.count };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export type AgentConfig = {
  name: string;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
  providerIds?: string[];
  maxSteps: number;
};

export type AgentToolSelection = {
  deploymentIds: string[];
  installedSkillIds: string[];
  toolkitIds: string[];
  sandboxIds?: string[];
  defaultSandboxId?: string | null;
  subAgentIds?: string[];
};

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

function assertRuntimeProviderFormat(runtime: string, format: string) {
  if (!agentRuntimeSupportsProviderFormat(runtime, format)) {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} does not support provider format "${format}".`,
    );
  }
}

function assertRuntimeSandboxes(
  runtime: string,
  requestedIds: readonly string[],
  sandboxes: readonly { id: string; kind: string; network: string }[],
  allowAutomatic = false,
) {
  if (!isDedicatedSandboxRuntimeKind(runtime)) return;
  if (allowAutomatic && requestedIds.length === 0) return;
  if (requestedIds.length !== 1 || sandboxes.length !== 1 || sandboxes[0]?.kind !== 'docker') {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} requires exactly one Docker sandbox.`,
    );
  }
  if (sandboxes[0]?.network === 'none') {
    throw new AgentConfigurationError(
      `${agentRuntimeDisplayName(runtime)} requires a networked Docker sandbox.`,
    );
  }
}

type SandboxAssignmentConflict = {
  agent: { name: string };
  sandbox: { name: string };
};

function assertSandboxesUnassigned(conflict: SandboxAssignmentConflict | null) {
  if (!conflict) return;
  throw new AgentConfigurationError(
    `Sandbox "${conflict.sandbox.name}" is already assigned to agent "${conflict.agent.name}". Choose an unassigned sandbox.`,
  );
}

function isSandboxAssignmentConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') {
    return false;
  }
  const meta = 'meta' in error ? error.meta : undefined;
  return JSON.stringify(meta ?? '').includes('sandboxId');
}

function rethrowSandboxAssignmentConstraint(error: unknown): never {
  if (isSandboxAssignmentConstraintError(error)) {
    throw new AgentConfigurationError(
      'The selected sandbox was assigned to another agent. Choose an unassigned sandbox.',
    );
  }
  throw error;
}

async function lockProvider(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  providerId: string,
): Promise<{ id: string; format: string; models: string[] } | null> {
  const providers = await tx.$queryRaw<Array<{ id: string; format: string; models: string[] }>>`
    SELECT "id", "format", "models"
    FROM "ModelProvider"
    WHERE "id" = ${providerId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE
  `;
  return providers[0] ?? null;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function assertExactResources(
  label: string,
  requestedIds: readonly string[],
  rows: readonly { id: string }[],
) {
  const found = new Set(rows.map(({ id }) => id));
  const missing = requestedIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AgentConfigurationError(`Unknown or unavailable ${label}: ${missing.join(', ')}`);
  }
}

// Creates the Agent record, its model configuration, and all bindings in one
// transaction. This is the safe write primitive for API/MCP callers: unlike
// the forgiving dashboard mutations, a foreign or stale resource ID aborts
// the whole operation instead of being silently dropped.
export async function createConfiguredAgent(
  workspaceId: string,
  cfg: AgentConfig,
  tools: AgentToolSelection,
  options: CreateAgentOptions,
) {
  const cleanName = cfg.name.trim() || 'New agent';
  const deploymentIds = uniqueIds(tools.deploymentIds);
  const installedSkillIds = uniqueIds(tools.installedSkillIds);
  const toolkitIds = uniqueIds(tools.toolkitIds);
  const sandboxIds = uniqueIds(tools.sandboxIds ?? []);
  const subAgentIds = uniqueIds(tools.subAgentIds ?? []);

  try {
    return await db.$transaction(async (tx) => {
      await lockAgentSlugNamespace(tx, workspaceId);
      const slug = await uniqueAgentSlug(tx, workspaceId, slugify(cleanName));
      const isDedicated = isDedicatedSandboxRuntimeKind(options.runtime);
      const automaticSandbox = isDedicated && sandboxIds.length === 0;
      const sandboxSlug = options.runtime === HERMES_RUNTIME_KIND || automaticSandbox
        ? await uniqueSandboxSlug(tx, workspaceId, slug, automaticSandbox ? 'workspace' : 'runtime')
        : undefined;
      const isHermes = options.runtime === HERMES_RUNTIME_KIND;
      const modelProviderIds = isHermes
        ? uniqueIds(cfg.providerIds ?? (cfg.providerId ? [cfg.providerId] : [])).sort()
        : [];
      if (!isHermes && cfg.model && !cfg.providerId) {
        throw new AgentConfigurationError('A model requires a model provider.');
      }
      if (isHermes) {
        for (const providerId of modelProviderIds) {
          if (!await lockProvider(tx, workspaceId, providerId)) {
            throw new AgentConfigurationError(`Unknown model provider: ${providerId}`);
          }
        }
      } else if (cfg.providerId) {
        const provider = await lockProvider(tx, workspaceId, cfg.providerId);
        if (!provider) throw new AgentConfigurationError(`Unknown model provider: ${cfg.providerId}`);
        assertRuntimeProviderFormat(options.runtime, provider.format);
        if (cfg.model && !provider.models.includes(cfg.model)) {
          throw new AgentConfigurationError(`Unknown or unavailable model: ${cfg.model}`);
        }
      }

      // Interactive transactions use one pg connection; keep these awaits
      // sequential so the adapter never issues overlapping client.query calls.
      const deployments = await tx.deployment.findMany({
        where: {
          id: { in: deploymentIds },
          workspaceId,
          OR: [{ source: null }, { source: { not: 'sandbox' } }],
        },
        select: { id: true },
      });
      const skills = await tx.installedSkill.findMany({
        where: { id: { in: installedSkillIds }, workspaceId },
        select: { id: true },
      });
      const toolkits = await tx.toolkit.findMany({
        where: { id: { in: toolkitIds }, workspaceId },
        select: { id: true },
      });
      const sandboxes = await tx.sandbox.findMany({
        where: {
          id: { in: sandboxIds },
          workspaceId,
          kind: { not: HERMES_RUNTIME_KIND },
          deployment: { status: { notIn: UNAVAILABLE_SANDBOX_STATUSES } },
        },
        select: { id: true, kind: true, network: true },
      });
      const subAgents = await tx.agent.findMany({
        where: { id: { in: subAgentIds }, workspaceId },
        select: { id: true },
      });
      const sandboxConflict = await tx.agentSandbox.findFirst({
        where: { sandboxId: { in: sandboxIds } },
        select: {
          agent: { select: { name: true } },
          sandbox: { select: { name: true } },
        },
      });
      assertExactResources('MCP deployment', deploymentIds, deployments);
      assertExactResources('installed skill', installedSkillIds, skills);
      assertExactResources('toolkit', toolkitIds, toolkits);
      assertExactResources('sandbox', sandboxIds, sandboxes);
      assertExactResources('sub-agent', subAgentIds, subAgents);
      assertRuntimeSandboxes(options.runtime, sandboxIds, sandboxes, true);
      assertSandboxesUnassigned(sandboxConflict);

      const agent = await createAgentRecords(
        tx,
        workspaceId,
        cleanName,
        slug,
        options,
        sandboxSlug,
      );
      if (automaticSandbox && sandboxSlug) {
        await createDedicatedSandboxRecords(tx, workspaceId, agent, sandboxSlug);
      }
      await tx.agent.update({
        where: { id: agent.id },
        data: {
          name: cleanName,
          systemPrompt: isHermes ? null : cfg.systemPrompt,
          providerId: isHermes ? null : cfg.providerId,
          model: isHermes ? null : cfg.providerId ? cfg.model : null,
          maxSteps: cfg.maxSteps,
        },
      });
      await tx.agentModelProvider.createMany({
        data: modelProviderIds.map((providerId) => ({ agentId: agent.id, providerId })),
      });
      await tx.agentServer.createMany({
        data: deployments.map(({ id }) => ({ agentId: agent.id, deploymentId: id })),
      });
      await tx.agentSkill.createMany({
        data: skills.map(({ id }) => ({ agentId: agent.id, installedSkillId: id })),
      });
      await tx.agentToolkit.createMany({
        data: toolkits.map(({ id }) => ({ agentId: agent.id, toolkitId: id })),
      });
      await tx.agentSandbox.createMany({
        data: sandboxes.map(({ id }) => ({
          agentId: agent.id,
          sandboxId: id,
          isDefault: isDedicatedSandboxRuntimeKind(options.runtime)
            || id === tools.defaultSandboxId
            || (!tools.defaultSandboxId && id === sandboxes[0]?.id),
        })),
      });
      await tx.agentSubAgent.createMany({
        data: subAgents.map(({ id }) => ({ parentId: agent.id, childId: id })),
      });
      return agent;
    }, { maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    rethrowSandboxAssignmentConstraint(error);
  }
}

export async function updateAgent(workspaceId: string, agentId: string, cfg: AgentConfig) {
  await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: {
        id: true,
        runtimeKind: true,
        modelProviders: { select: { providerId: true } },
      },
    });
    if (!agent) return;

    const isHermes = agent.runtimeKind === HERMES_RUNTIME_KIND;
    let providerId = isHermes ? null : cfg.providerId;
    const modelProviderIds: string[] = [];
    if (isHermes) {
      const requestedIds = cfg.providerIds ?? (cfg.providerId ? [cfg.providerId] : []);
      for (const requestedId of [...new Set(requestedIds.filter(Boolean))].sort()) {
        const provider = await lockProvider(tx, workspaceId, requestedId);
        if (provider) modelProviderIds.push(provider.id);
      }
    } else if (providerId) {
      const provider = await lockProvider(tx, workspaceId, providerId);
      if (!provider) providerId = null;
      else {
        assertRuntimeProviderFormat(agent.runtimeKind, provider.format);
        if (cfg.model && !provider.models.includes(cfg.model)) {
          throw new AgentConfigurationError(`Unknown or unavailable model: ${cfg.model}`);
        }
      }
    }
    await tx.agent.updateMany({
      where: { id: agentId, workspaceId },
      data: {
        name: cfg.name,
        ...(isHermes ? {} : { systemPrompt: cfg.systemPrompt }),
        providerId,
        model: isHermes ? null : providerId ? cfg.model : null,
        maxSteps: cfg.maxSteps,
      },
    });
    await tx.agentModelProvider.deleteMany({ where: { agentId } });
    await tx.agentModelProvider.createMany({
      data: modelProviderIds.map((modelProviderId) => ({
        agentId,
        providerId: modelProviderId,
      })),
    });
    const removedProviderIds = agent.modelProviders
      .map(({ providerId: currentProviderId }) => currentProviderId)
      .filter((currentProviderId) => !modelProviderIds.includes(currentProviderId));
    if (removedProviderIds.length) {
      await tx.conversation.updateMany({
        where: {
          agentId,
          hermesProvider: { in: hermesProviderAliases(removedProviderIds) },
        },
        data: { hermesProvider: null, hermesModel: null },
      });
    }
  });
}

export async function updateAgentModelSelection(
  workspaceId: string,
  agentId: string,
  requestedProviderIds: string[],
  model: string | null,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: {
        id: true,
        runtimeKind: true,
        modelProviders: { select: { providerId: true } },
      },
    });
    if (!agent) return;

    if (agent.runtimeKind === HERMES_RUNTIME_KIND) {
      const providerIds: string[] = [];
      for (const providerId of [...new Set(requestedProviderIds.filter(Boolean))].sort()) {
        const provider = await lockProvider(tx, workspaceId, providerId);
        if (provider) providerIds.push(provider.id);
      }
      await tx.agent.updateMany({ where: { id: agentId, workspaceId }, data: { providerId: null, model: null } });
      await tx.agentModelProvider.deleteMany({ where: { agentId } });
      await tx.agentModelProvider.createMany({
        data: providerIds.map((providerId) => ({ agentId, providerId })),
      });
      const removedProviderIds = agent.modelProviders
        .map(({ providerId }) => providerId)
        .filter((providerId) => !providerIds.includes(providerId));
      if (removedProviderIds.length) {
        await tx.conversation.updateMany({
          where: {
            agentId,
            hermesProvider: { in: hermesProviderAliases(removedProviderIds) },
          },
          data: { hermesProvider: null, hermesModel: null },
        });
      }
      return agent.runtimeKind;
    }

    const providerId = requestedProviderIds[0];
    const provider = providerId ? await lockProvider(tx, workspaceId, providerId) : null;
    if (provider) {
      assertRuntimeProviderFormat(agent.runtimeKind, provider.format);
      if (model && !provider.models.includes(model)) {
        throw new AgentConfigurationError(`Unknown or unavailable model: ${model}`);
      }
    }
    const validProviderId = provider?.id ?? null;
    await tx.agent.updateMany({
      where: { id: agentId, workspaceId },
      data: { providerId: validProviderId, model: validProviderId ? model : null },
    });
    return agent.runtimeKind;
  });
}

export async function bindHermesAgentModelProvider(
  workspaceId: string,
  agentId: string,
  providerAlias: string,
  model: string,
): Promise<string> {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId, runtimeKind: HERMES_RUNTIME_KIND },
      select: { id: true },
    });
    if (!agent) throw new AgentConfigurationError('Hermes agent not found.');

    const providers = await tx.modelProvider.findMany({
      where: { workspaceId, models: { has: model } },
      select: { id: true },
    });
    const bareAlias = providerAlias.replace(/^custom:/, '');
    const provider = providers.find(({ id }) => hermesProviderName(id) === bareAlias);
    if (!provider || !await lockProvider(tx, workspaceId, provider.id)) {
      throw new AgentConfigurationError('The selected ToolPlane model is not available.');
    }
    const stillAvailable = await tx.modelProvider.findFirst({
      where: { id: provider.id, workspaceId, models: { has: model } },
      select: { id: true },
    });
    if (!stillAvailable) {
      throw new AgentConfigurationError('The selected ToolPlane model is not available.');
    }
    await tx.agentModelProvider.createMany({
      data: [{ agentId, providerId: provider.id }],
      skipDuplicates: true,
    });
    return hermesProviderName(provider.id);
  });
}

export async function setHermesRuntimeEnv(
  workspaceId: string,
  agentId: string,
  env: SandboxEnv,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const runtime = await tx.agentRuntime.findFirst({
      where: { agentId, workspaceId, kind: HERMES_RUNTIME_KIND },
      select: {
        sandbox: {
          select: {
            id: true,
            workspaceId: true,
            config: true,
            deploymentId: true,
            deployment: { select: { installCfg: true } },
          },
        },
      },
    });
    if (!runtime || runtime.sandbox.workspaceId !== workspaceId) return false;

    const config = sandboxConfigWithEnv(runtime.sandbox.config, env);
    const existingInstallCfg = runtime.sandbox.deployment.installCfg;
    const installCfg = existingInstallCfg
      && typeof existingInstallCfg === 'object'
      && !Array.isArray(existingInstallCfg)
      ? existingInstallCfg as Prisma.InputJsonObject
      : {};
    const [sandboxUpdated, deploymentUpdated] = await Promise.all([
      tx.sandbox.updateMany({
        where: { id: runtime.sandbox.id, workspaceId },
        data: { config: config ?? {} },
      }),
      tx.deployment.updateMany({
        where: {
          id: runtime.sandbox.deploymentId,
          workspaceId,
          source: 'sandbox',
        },
        data: { installCfg: { ...installCfg, env: withoutHermesChannelEnv(env) } },
      }),
    ]);
    if (sandboxUpdated.count !== 1 || deploymentUpdated.count !== 1) {
      throw new Error('Could not update the Hermes runtime environment projection.');
    }
    return true;
  });
}

export async function setAgentTools(
  workspaceId: string,
  agentId: string,
  tools: AgentToolSelection,
) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, runtimeKind: true },
  });
  if (!agent) return;
  const requestedSandboxIds = uniqueIds(tools.sandboxIds ?? []);
  const [deployments, skills, toolkits, sandboxes, subAgents, sandboxConflict] = await Promise.all([
    db.deployment.findMany({ where: { id: { in: tools.deploymentIds }, workspaceId }, select: { id: true } }),
    db.installedSkill.findMany({ where: { id: { in: tools.installedSkillIds }, workspaceId }, select: { id: true } }),
    db.toolkit.findMany({ where: { id: { in: tools.toolkitIds }, workspaceId }, select: { id: true } }),
    db.sandbox.findMany({
      where: {
        id: { in: requestedSandboxIds },
        workspaceId,
        kind: { not: HERMES_RUNTIME_KIND },
        deployment: {
          status: { notIn: UNAVAILABLE_SANDBOX_STATUSES },
        },
      },
      select: { id: true, kind: true, network: true },
    }),
    // Same-workspace agents only, never the agent itself (no self-delegation).
    db.agent.findMany({
      where: { id: { in: tools.subAgentIds ?? [], not: agentId }, workspaceId },
      select: { id: true },
    }),
    db.agentSandbox.findFirst({
      where: {
        sandboxId: { in: requestedSandboxIds },
        agentId: { not: agentId },
      },
      select: {
        agent: { select: { name: true } },
        sandbox: { select: { name: true } },
      },
    }),
  ]);
  assertRuntimeSandboxes(agent.runtimeKind, requestedSandboxIds, sandboxes);
  assertSandboxesUnassigned(sandboxConflict);
  try {
    await db.$transaction([
      db.agentServer.deleteMany({ where: { agentId } }),
      db.agentSkill.deleteMany({ where: { agentId } }),
      db.agentToolkit.deleteMany({ where: { agentId } }),
      db.agentSandbox.deleteMany({ where: { agentId } }),
      db.agentSubAgent.deleteMany({ where: { parentId: agentId } }),
      db.agentServer.createMany({ data: deployments.map((d) => ({ agentId, deploymentId: d.id })) }),
      db.agentSkill.createMany({ data: skills.map((s) => ({ agentId, installedSkillId: s.id })) }),
      db.agentToolkit.createMany({ data: toolkits.map((t) => ({ agentId, toolkitId: t.id })) }),
      db.agentSandbox.createMany({
        data: sandboxes.map((s) => ({
          agentId,
          sandboxId: s.id,
          isDefault: isDedicatedSandboxRuntimeKind(agent.runtimeKind)
            || s.id === tools.defaultSandboxId
            || (!tools.defaultSandboxId && s.id === sandboxes[0]?.id),
        })),
      }),
      db.agentSubAgent.createMany({ data: subAgents.map((s) => ({ parentId: agentId, childId: s.id })) }),
    ]);
  } catch (error) {
    rethrowSandboxAssignmentConstraint(error);
  }
}

export async function getAgentDeleteTargets(workspaceId: string, agentId: string) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      marketInstall: { select: { resourceMap: true } },
    },
  });
  if (!agent) return { agentIds: [], sandboxes: [] };
  const map = agent.marketInstall
    ? parseAgentMarketResourceMap(agent.marketInstall.resourceMap)
    : null;
  if (agent.marketInstall && (!map || !Object.values(map.agents).includes(agentId))) {
    throw new Error('The marketplace install resource map is invalid.');
  }
  const requestedAgentIds = map
    ? [...new Set([agentId, ...Object.values(map.agents)])]
    : [agentId];
  const agents = await db.agent.findMany({
    where: { workspaceId, id: { in: requestedAgentIds } },
    select: {
      id: true,
      parentLinks: {
        where: { parentId: { notIn: requestedAgentIds } },
        take: 1,
        select: { parentId: true },
      },
      marketInstall: { select: { id: true } },
      unifiedMarketInstall: { select: { id: true } },
      sourceMarketListing: { select: { id: true } },
      publicEndpoints: { take: 1, select: { id: true } },
      sandboxes: {
        select: {
          sandbox: {
            select: {
              id: true,
              kind: true,
              deploymentId: true,
              deployment: { select: { installCfg: true } },
              snapshots: { select: { volumeName: true } },
            },
          },
        },
      },
      runtime: {
        select: {
          sandbox: {
            select: {
              id: true,
              kind: true,
              deploymentId: true,
              deployment: { select: { installCfg: true } },
              snapshots: { select: { volumeName: true } },
            },
          },
        },
      },
    },
  });
  const deletableAgents = agents.filter((candidate) => (
    candidate.id === agentId
    || (
      candidate.parentLinks.length === 0
      && !candidate.marketInstall
      && !candidate.unifiedMarketInstall
      && !candidate.sourceMarketListing
      && candidate.publicEndpoints.length === 0
    )
  ));
  const allowedSandboxIds = new Set(Object.values(map?.sandboxes ?? {}));
  const sandboxes = new Map<string, {
    id: string;
    kind: string;
    deploymentId: string;
    volumeName: string;
    snapshotVolumeNames: string[];
  }>();
  for (const candidate of deletableAgents.flatMap((row) => [
    ...row.sandboxes.map(({ sandbox }) => sandbox),
    ...(row.runtime ? [row.runtime.sandbox] : []),
  ])) {
    if (map && allowedSandboxIds.size > 0 && !allowedSandboxIds.has(candidate.id)) continue;
    const config = candidate.deployment.installCfg;
    const volumeName = config && typeof config === 'object' && !Array.isArray(config)
      && typeof (config as Record<string, unknown>).volumeName === 'string'
      ? String((config as Record<string, unknown>).volumeName)
      : sandboxVolumeName(candidate.id);
    sandboxes.set(candidate.id, {
      id: candidate.id,
      kind: candidate.kind,
      deploymentId: candidate.deploymentId,
      volumeName,
      snapshotVolumeNames: candidate.snapshots.map(({ volumeName: name }) => name),
    });
  }
  return { agentIds: deletableAgents.map(({ id }) => id), sandboxes: [...sandboxes.values()] };
}

export async function deleteAgent(workspaceId: string, agentId: string) {
  const install = await db.agentInstall.findFirst({
    where: { agentId, targetWorkspaceId: workspaceId },
    select: {
      id: true,
      resourceMap: true,
      release: { select: { listingId: true } },
    },
  });
  if (install) {
    const resourceMap = parseAgentMarketResourceMap(install.resourceMap);
    if (!resourceMap || !Object.values(resourceMap.agents).includes(agentId)) {
      throw new Error('The marketplace install resource map is invalid.');
    }
    const candidateAgentIds = [...new Set(Object.values(resourceMap.agents))];
    return db.$transaction(async (tx) => {
      const candidates = await tx.agent.findMany({
        where: { workspaceId, id: { in: candidateAgentIds } },
        select: {
          id: true,
          parentLinks: {
            where: { parentId: { notIn: candidateAgentIds } },
            take: 1,
            select: { parentId: true },
          },
          marketInstall: { select: { id: true } },
          unifiedMarketInstall: { select: { id: true } },
          sourceMarketListing: { select: { id: true } },
          publicEndpoints: { take: 1, select: { id: true } },
        },
      });
      const deletableAgentIds = candidates.filter((candidate) => (
        candidate.id === agentId
        || (
          candidate.parentLinks.length === 0
          && !candidate.marketInstall
          && !candidate.unifiedMarketInstall
          && !candidate.sourceMarketListing
          && candidate.publicEndpoints.length === 0
        )
      )).map(({ id }) => id);

      const candidateToolkitIds = [...new Set(Object.values(resourceMap.toolkits))];
      const toolkits = await tx.toolkit.findMany({
        where: { workspaceId, id: { in: candidateToolkitIds } },
        select: {
          id: true,
          visibility: true,
          agentLinks: {
            where: { agentId: { notIn: deletableAgentIds } },
            take: 1,
            select: { agentId: true },
          },
          sourceMarketListing: { select: { id: true } },
          marketInstall: { select: { id: true } },
          installLinks: { take: 1, select: { id: true } },
          apiTokens: { take: 1, select: { id: true } },
        },
      });
      const deletableToolkitIds = toolkits.filter((toolkit) => (
        toolkit.visibility === 'private'
        && toolkit.agentLinks.length === 0
        && !toolkit.sourceMarketListing
        && !toolkit.marketInstall
        && toolkit.installLinks.length === 0
        && toolkit.apiTokens.length === 0
      )).map(({ id }) => id);

      const candidateDeploymentIds = [...new Set(Object.values(resourceMap.deployments))];
      const deployments = await tx.deployment.findMany({
        where: { workspaceId, id: { in: candidateDeploymentIds } },
        select: {
          id: true,
          serverId: true,
          publicInvocable: true,
          agentLinks: {
            where: { agentId: { notIn: deletableAgentIds } },
            take: 1,
            select: { agentId: true },
          },
          toolkitLinks: {
            where: { toolkitId: { notIn: deletableToolkitIds } },
            take: 1,
            select: { toolkitId: true },
          },
          chatAssistantGrants: { take: 1, select: { assistantId: true } },
          sourceMarketListing: { select: { id: true } },
          marketInstall: { select: { id: true } },
        },
      });
      const deletableDeploymentIds = deployments.filter((deployment) => (
        !deployment.serverId
        && !deployment.publicInvocable
        && deployment.agentLinks.length === 0
        && deployment.toolkitLinks.length === 0
        && deployment.chatAssistantGrants.length === 0
        && !deployment.sourceMarketListing
        && !deployment.marketInstall
      )).map(({ id }) => id);

      const candidateSkillIds = [...new Set(Object.values(resourceMap.skills))];
      const skills = await tx.installedSkill.findMany({
        where: { workspaceId, id: { in: candidateSkillIds } },
        select: {
          id: true,
          skillId: true,
          agentLinks: {
            where: { agentId: { notIn: deletableAgentIds } },
            take: 1,
            select: { agentId: true },
          },
          toolkitLinks: {
            where: { toolkitId: { notIn: deletableToolkitIds } },
            take: 1,
            select: { toolkitId: true },
          },
          sourceMarketListing: { select: { id: true } },
          marketInstall: { select: { id: true } },
        },
      });
      const deletableSkillIds = skills.filter((skill) => (
        !skill.skillId
        && skill.agentLinks.length === 0
        && skill.toolkitLinks.length === 0
        && !skill.sourceMarketListing
        && !skill.marketInstall
      )).map(({ id }) => id);

      const mappedSandboxIds = [...new Set(Object.values(resourceMap.sandboxes))];
      const legacySandboxes = await tx.sandbox.findMany({
        where: {
          workspaceId,
          AND: [{
            OR: [
              { agentLinks: { some: { agentId: { in: deletableAgentIds } } } },
              { agentRuntime: { is: { agentId: { in: deletableAgentIds } } } },
            ],
          }],
          ...(mappedSandboxIds.length > 0
            ? { id: { in: mappedSandboxIds } }
            : {}),
        },
        select: { id: true, deploymentId: true },
      });
      const sandboxDeploymentIds = legacySandboxes.map(({ deploymentId }) => deploymentId);

      await tx.agentInstall.delete({ where: { id: install.id } });
      await tx.agent.deleteMany({ where: { workspaceId, id: { in: deletableAgentIds } } });
      await tx.toolkit.deleteMany({ where: { workspaceId, id: { in: deletableToolkitIds } } });
      await tx.installedSkill.deleteMany({ where: { workspaceId, id: { in: deletableSkillIds } } });
      await tx.deployment.deleteMany({
        where: {
          workspaceId,
          id: { in: [...new Set([...deletableDeploymentIds, ...sandboxDeploymentIds])] },
        },
      });
      await tx.agentListing.updateMany({
        where: { id: install.release.listingId, installCount: { gt: 0 } },
        data: { installCount: { decrement: 1 } },
      });
    }, { isolationLevel: 'Serializable' });
  }

  const [runtime, sandboxes] = await Promise.all([
    db.agentRuntime.findFirst({
      where: { agentId, workspaceId },
      select: { sandbox: { select: { deploymentId: true } } },
    }),
    db.sandbox.findMany({
      where: { workspaceId, agentLinks: { some: { agentId } } },
      select: { deploymentId: true },
    }),
  ]);
  const sandboxDeploymentIds = [
    ...sandboxes.map(({ deploymentId }) => deploymentId),
    ...(runtime ? [runtime.sandbox.deploymentId] : []),
  ];
  await db.$transaction(async (tx) => {
    if (sandboxDeploymentIds.length > 0) {
      await tx.deployment.deleteMany({
        where: {
          id: { in: [...new Set(sandboxDeploymentIds)] },
          workspaceId,
          source: 'sandbox',
        },
      });
    }
    await tx.agent.deleteMany({ where: { id: agentId, workspaceId } });
  });
}

export async function createProvider(
  workspaceId: string,
  data: { name: string; format: string; baseUrl: string; apiKey: string },
) {
  return db.modelProvider.create({ data: { workspaceId, ...data } });
}

function hermesProviderAliases(providerIds: string[]): string[] {
  return providerIds.flatMap((providerId) => {
    const name = hermesProviderName(providerId);
    return [name, `custom:${name}`];
  });
}

export async function updateProvider(
  workspaceId: string,
  providerId: string,
  data: { name: string; format: string; baseUrl: string; apiKey?: string },
) {
  await db.modelProvider.updateMany({
    where: { id: providerId, workspaceId },
    data,
  });
}

export async function deleteProvider(workspaceId: string, providerId: string) {
  return db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) return [];

    const hermesAgents = await tx.agent.findMany({
      where: {
        workspaceId,
        runtime: { is: { kind: HERMES_RUNTIME_KIND } },
        modelProviders: { some: { providerId } },
      },
      select: { id: true, runtime: { select: { sandboxId: true } } },
    });

    await tx.agent.updateMany({
      where: { workspaceId, providerId },
      data: { providerId: null, model: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, defaultModelProviderId: providerId },
      data: { defaultModelProviderId: null, defaultModel: null },
    });
    await tx.workspace.updateMany({
      where: { id: workspaceId, titleModelProviderId: providerId },
      data: { titleModelProviderId: null, titleModel: null },
    });
    await tx.conversation.updateMany({
      where: {
        agent: { workspaceId },
        hermesProvider: { in: hermesProviderAliases([providerId]) },
      },
      data: { hermesProvider: null, hermesModel: null },
    });
    await tx.modelProvider.deleteMany({ where: { id: providerId, workspaceId } });
    return hermesAgents.flatMap(({ id, runtime }) => (
      runtime ? [{ agentId: id, sandboxId: runtime.sandboxId }] : []
    ));
  });
}

export async function setProviderModels(workspaceId: string, providerId: string, models: string[]) {
  await db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) return;
    const remoteModelIds = uniqueIds(models.map((model) => model.trim()).filter(Boolean));
    await tx.providerModel.deleteMany({
      where: {
        providerId,
        source: 'remote',
        ...(remoteModelIds.length ? { modelId: { notIn: remoteModelIds } } : {}),
      },
    });
    if (remoteModelIds.length) {
      await tx.providerModel.createMany({
        data: remoteModelIds.map((modelId) => ({
          providerId,
          ...defaultProviderModel(modelId),
          source: 'remote',
        })),
        skipDuplicates: true,
      });
    }
    const manualModels = await tx.providerModel.findMany({
      where: { providerId, source: 'manual' },
      select: { modelId: true },
      orderBy: { createdAt: 'asc' },
    });
    const nextModels = uniqueIds([...remoteModelIds, ...manualModels.map(({ modelId }) => modelId)]);
    await tx.modelProvider.update({
      where: { id: providerId },
      data: {
        models: nextModels,
        modelsFetchedAt: new Date(),
      },
    });
    await tx.conversation.updateMany({
      where: {
        agent: { workspaceId },
        hermesProvider: { in: hermesProviderAliases([providerId]) },
        hermesModel: nextModels.length ? { notIn: nextModels } : { not: null },
      },
      data: { hermesProvider: null, hermesModel: null },
    });
  });
}

export class ProviderModelError extends Error {}

export async function addProviderModels(
  workspaceId: string,
  providerId: string,
  models: ProviderModelValues[],
) {
  await db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) {
      throw new ProviderModelError('Provider not found.');
    }
    const provider = await tx.modelProvider.findUnique({
      where: { id: providerId },
      select: { models: true },
    });
    const requestedIds = models.map(({ modelId }) => modelId);
    if (new Set(requestedIds).size !== requestedIds.length
      || requestedIds.some((modelId) => provider?.models.includes(modelId))) {
      throw new ProviderModelError('A model with that ID already exists.');
    }
    await tx.providerModel.createMany({
      data: models.map((model) => ({ ...model, providerId, source: 'manual' })),
    });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: [...(provider?.models ?? []), ...requestedIds] },
    });
  });
}

export async function updateProviderModel(
  workspaceId: string,
  providerId: string,
  model: ProviderModelValues,
) {
  await db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) {
      throw new ProviderModelError('Provider not found.');
    }
    const provider = await tx.modelProvider.findUnique({
      where: { id: providerId },
      select: { models: true },
    });
    if (!provider?.models.includes(model.modelId)) {
      throw new ProviderModelError('Model not found.');
    }
    const { modelId, ...values } = model;
    await tx.providerModel.upsert({
      where: { providerId_modelId: { providerId, modelId } },
      create: { providerId, modelId, ...values, source: 'manual' },
      update: { ...values, source: 'manual' },
    });
  });
}

export async function deleteProviderModel(
  workspaceId: string,
  providerId: string,
  modelId: string,
) {
  await db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) {
      throw new ProviderModelError('Provider not found.');
    }
    const provider = await tx.modelProvider.findUnique({
      where: { id: providerId },
      select: { models: true },
    });
    if (!provider?.models.includes(modelId)) throw new ProviderModelError('Model not found.');
    const [agent, assistant, knowledgeBase, workspace, conversation] = await Promise.all([
      tx.agent.findFirst({ where: { workspaceId, providerId, model: modelId }, select: { id: true } }),
      tx.chatAssistant.findFirst({
        where: { workspaceId, modelProviderId: providerId, model: modelId },
        select: { id: true },
      }),
      tx.knowledgeBase.findFirst({
        where: { workspaceId, providerId, embeddingModel: modelId },
        select: { id: true },
      }),
      tx.workspace.findFirst({
        where: {
          id: workspaceId,
          OR: [
            { defaultModelProviderId: providerId, defaultModel: modelId },
            { titleModelProviderId: providerId, titleModel: modelId },
          ],
        },
        select: { id: true },
      }),
      tx.conversation.findFirst({
        where: {
          agent: { workspaceId },
          hermesProvider: { in: hermesProviderAliases([providerId]) },
          hermesModel: modelId,
        },
        select: { id: true },
      }),
    ]);
    if (agent || assistant || knowledgeBase || workspace || conversation) {
      throw new ProviderModelError('This model is in use and cannot be removed.');
    }
    await tx.providerModel.deleteMany({ where: { providerId, modelId } });
    await tx.modelProvider.update({
      where: { id: providerId },
      data: { models: provider.models.filter((model) => model !== modelId) },
    });
  });
}

export type ConversationRuntimeSession = {
  runtimeSessionId: string;
  runtimeSessionKey: string;
};

function nonEmptyString(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function defaultConversationRuntimeSession(
  agentId: string,
  conversationId: string,
  overrides: Partial<ConversationRuntimeSession> = {},
): ConversationRuntimeSession {
  const runtimeSessionId = nonEmptyString(overrides.runtimeSessionId) || conversationId;
  return {
    runtimeSessionId,
    runtimeSessionKey: nonEmptyString(overrides.runtimeSessionKey)
      || `agent:${agentId}:console:${runtimeSessionId}`,
  };
}

export async function createConversation(
  workspaceId: string,
  agentId: string,
  title?: string,
  runtimeSession?: Partial<ConversationRuntimeSession>,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
    if (!agent) return null;
    const conversation = await tx.conversation.create({ data: { agentId, title: title ?? null } });
    return tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(agent.id, conversation.id, runtimeSession),
    });
  });
}

export type HermesConversationSelection = {
  profile: string;
  provider: string | null;
  model: string | null;
};

export type HermesConversationSelectionResult = {
  conversationId: string;
  created: boolean;
};

export async function setHermesConversationSelection(
  workspaceId: string,
  agentId: string,
  conversationId: string | null,
  selection: HermesConversationSelection,
): Promise<HermesConversationSelectionResult | null> {
  if (
    !HERMES_PROFILE_NAME.test(selection.profile)
    || (selection.provider === null) !== (selection.model === null)
    || (selection.provider !== null && (!selection.provider || selection.provider.length > 128))
    || (selection.model !== null && (!selection.model || selection.model.length > 512))
  ) return null;
  const storedProfile = selection.profile === 'default' ? null : selection.profile;
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId, runtime: { is: { kind: 'hermes' } } },
      select: { id: true, publicRuntimeAllocation: { select: { id: true } } },
    });
    if (!agent || agent.publicRuntimeAllocation) return null;

    const createSelectedConversation = async () => {
      const created = await tx.conversation.create({
        data: {
          agentId,
          hermesProfile: storedProfile,
          hermesProvider: selection.provider,
          hermesModel: selection.model,
        },
      });
      await tx.conversation.update({
        where: { id: created.id },
        data: defaultConversationRuntimeSession(agentId, created.id),
      });
      return { conversationId: created.id, created: true };
    };

    if (!conversationId) return createSelectedConversation();
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, agentId, agent: { workspaceId } },
      select: {
        id: true,
        title: true,
        hermesProfile: true,
        _count: { select: { messages: true } },
        publicApiConversation: { select: { id: true } },
        workSession: { select: { id: true, status: true } },
      },
    });
    const editableWorkConversation = conversation?.workSession
      && ['idle', 'waiting_user', 'completed', 'failed'].includes(conversation.workSession.status);
    if (
      !conversation
      || conversation.title?.startsWith('msg:')
      || conversation.publicApiConversation
      || (conversation.workSession && !editableWorkConversation)
    ) return null;

    const currentProfile = conversation.hermesProfile || 'default';
    if (currentProfile !== selection.profile && conversation._count.messages > 0 && !editableWorkConversation) {
      return createSelectedConversation();
    }
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        hermesProfile: storedProfile,
        hermesProvider: selection.provider,
        hermesModel: selection.model,
        ...(currentProfile !== selection.profile
          ? defaultConversationRuntimeSession(agentId, conversation.id)
          : {}),
      },
    });
    return { conversationId: conversation.id, created: false };
  });
}

export async function renameConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: { id: true, title: true, publicApiConversation: { select: { id: true } }, workSession: { select: { id: true } } },
  });
  if (!conversation || conversation.title?.startsWith('msg:') || conversation.publicApiConversation || conversation.workSession) return false;
  const updated = await db.conversation.updateMany({
    where: { id: conversation.id, agentId, agent: { workspaceId } },
    data: { title },
  });
  return updated.count === 1;
}

export async function deleteConsoleConversation(
  workspaceId: string,
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agentId, agent: { workspaceId } },
    select: { id: true, title: true, publicApiConversation: { select: { id: true } }, workSession: { select: { id: true } } },
  });
  if (!conversation || conversation.title?.startsWith('msg:') || conversation.publicApiConversation || conversation.workSession) return false;
  const deleted = await db.conversation.deleteMany({
    where: { id: conversation.id, agentId, agent: { workspaceId } },
  });
  return deleted.count === 1;
}

// Conversations created before runtime session aliases existed are initialized
// lazily on their first Hermes request. The nullable-only updates ensure a
// concurrent request never overwrites an alias already chosen by another one.
export async function ensureConversationRuntimeSession(
  workspaceId: string,
  agentId: string,
  conversationId: string,
  fallback: Partial<ConversationRuntimeSession> = {},
): Promise<ConversationRuntimeSession | null> {
  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, agentId, agent: { workspaceId } },
      select: { id: true, runtimeSessionId: true, runtimeSessionKey: true },
    });
    if (!conversation) return null;

    const desired = defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(conversation.runtimeSessionId)
        || nonEmptyString(fallback.runtimeSessionId)
        || conversation.id,
      { runtimeSessionKey: conversation.runtimeSessionKey ?? fallback.runtimeSessionKey },
    );
    if (conversation.runtimeSessionId === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionId: null },
        data: { runtimeSessionId: desired.runtimeSessionId },
      });
    }
    if (conversation.runtimeSessionKey === null) {
      await tx.conversation.updateMany({
        where: { id: conversation.id, agentId, runtimeSessionKey: null },
        data: { runtimeSessionKey: desired.runtimeSessionKey },
      });
    }
    const resolved = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { runtimeSessionId: true, runtimeSessionKey: true },
    });
    return defaultConversationRuntimeSession(
      agentId,
      nonEmptyString(resolved?.runtimeSessionId) || desired.runtimeSessionId,
      { runtimeSessionKey: resolved?.runtimeSessionKey ?? desired.runtimeSessionKey },
    );
  });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  parts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    if (role === 'user') {
      const title = conversationTitleFromParts(parts);
      if (title) {
        // Claim the title before inserting the first user message. Concurrent
        // callers serialize on the conversation row, so exactly one can
        // observe a null title with no prior user messages.
        await tx.conversation.updateMany({
          where: {
            id: conversationId,
            title: null,
            messages: {
              none: { role: 'user' },
            },
          },
          data: { title },
        });
      }
    }
    return tx.message.create({ data: { conversationId, role, parts } });
  });
}

export async function appendConversationTurn(
  conversationId: string,
  userParts: Prisma.InputJsonValue,
  assistantParts: Prisma.InputJsonValue,
) {
  return db.$transaction(async (tx) => {
    const title = conversationTitleFromParts(userParts);
    if (title) {
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          title: null,
          messages: { none: { role: 'user' } },
        },
        data: { title },
      });
    }

    // PostgreSQL's now() is stable for an entire transaction. Supply adjacent
    // timestamps so the existing createdAt ordering always keeps the pair in
    // user/assistant order while both writes still commit atomically.
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    const user = await tx.message.create({
      data: {
        conversationId,
        role: 'user',
        parts: userParts,
        createdAt: userCreatedAt,
      },
    });
    const assistant = await tx.message.create({
      data: {
        conversationId,
        role: 'assistant',
        parts: assistantParts,
        createdAt: assistantCreatedAt,
      },
    });
    return { user, assistant };
  });
}
