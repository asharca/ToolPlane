import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { sandboxVolumeName } from '@/lib/sandboxes/runtime';
import { readSandboxEnv, sandboxConfigWithEnv, type SandboxEnv } from '@/lib/sandboxes/env';

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

async function uniqueAgentSlug(workspaceId: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  for (let i = 1; await db.agent.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${baseSlug}-${i}`;
  }
  return slug;
}

export type CreateAgentOptions = {
  runtime?: 'native' | 'hermes';
  hermesImage?: string;
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

async function uniqueSandboxSlug(workspaceId: string, baseSlug: string): Promise<string> {
  let slug = `${baseSlug}-runtime`;
  for (let i = 1; await db.sandbox.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${baseSlug}-runtime-${i}`;
  }
  return slug;
}

export async function createAgentRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  name: string,
  slug: string,
  options: CreateAgentOptions,
  sandboxSlug?: string,
) {
  const agent = await tx.agent.create({ data: { workspaceId, name, slug } });
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
      config: { managedBy: 'agent-runtime' },
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
      },
    },
  });
  return agent;
}

export async function createAgent(
  workspaceId: string,
  name: string,
  options: CreateAgentOptions = {},
) {
  const cleanName = name.trim() || 'New agent';
  const slug = await uniqueAgentSlug(workspaceId, slugify(cleanName));
  const sandboxSlug = options.runtime === HERMES_RUNTIME_KIND
    ? await uniqueSandboxSlug(workspaceId, slug)
    : undefined;
  return db.$transaction((tx) => (
    createAgentRecords(tx, workspaceId, cleanName, slug, options, sandboxSlug)
  ));
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
        select: { sandboxId: true },
      },
      subAgents: {
        where: { child: { workspaceId } },
        select: { childId: true },
      },
    },
  });
  if (!source) return null;

  const cleanName = requestedName?.trim() || `${source.name} copy`;
  const slug = await uniqueAgentSlug(workspaceId, slugify(cleanName));
  const runtime: CreateAgentOptions & { runtime: 'native' | 'hermes' } = source.runtime?.workspaceId === workspaceId
    && source.runtime.kind === HERMES_RUNTIME_KIND
    && source.runtime.sandbox.workspaceId === workspaceId
    ? { runtime: 'hermes', hermesImage: source.runtime.image }
    : { runtime: 'native' };
  // A Hermes volume contains the files referenced by conversations and their
  // runtime session state. Keep those database records together with a volume
  // clone, even if a stale/non-UI caller omitted the dependent checkbox.
  const effectiveCloneOptions = runtime.runtime === HERMES_RUNTIME_KIND && cloneOptions.copyHermesVolume
    ? { ...cloneOptions, copyConversations: true }
    : cloneOptions;
  const sandboxSlug = runtime.runtime === HERMES_RUNTIME_KIND
    ? await uniqueSandboxSlug(workspaceId, slug)
    : undefined;

  return db.$transaction(async (tx) => {
    const providerId = runtime.runtime === HERMES_RUNTIME_KIND
      ? null
      : source.providerId
      && await lockProvider(tx, workspaceId, source.providerId)
      ? source.providerId
      : null;
    const modelProviderIds: string[] = [];
    if (runtime.runtime === HERMES_RUNTIME_KIND) {
      const requestedIds = source.modelProviders.length > 0
        ? source.modelProviders.map((link) => link.providerId)
        : source.providerId ? [source.providerId] : [];
      for (const requestedId of [...new Set(requestedIds)]) {
        if (await lockProvider(tx, workspaceId, requestedId)) modelProviderIds.push(requestedId);
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
              env,
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
          runtime.runtime === HERMES_RUNTIME_KIND,
        )
      : [];
    return { ...cloned, runtimeKind: runtime.runtime, conversationIds, conversationsDeferred };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export type AgentCloneConversationId = { sourceId: string; targetId: string };

type SourceConversationForClone = {
  id: string;
  title: string | null;
  runtimeSessionId: string | null;
  runtimeSessionKey: string | null;
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
        ...(runtimeSession ?? {}),
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

async function lockProvider(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  providerId: string,
): Promise<boolean> {
  const providers = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ModelProvider"
    WHERE "id" = ${providerId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE
  `;
  return providers.length > 0;
}

export async function updateAgent(workspaceId: string, agentId: string, cfg: AgentConfig) {
  await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true, runtime: { select: { kind: true } } },
    });
    if (!agent) return;

    const isHermes = agent.runtime?.kind === HERMES_RUNTIME_KIND;
    let providerId = isHermes ? null : cfg.providerId;
    const modelProviderIds: string[] = [];
    if (isHermes) {
      const requestedIds = cfg.providerIds ?? (cfg.providerId ? [cfg.providerId] : []);
      for (const requestedId of [...new Set(requestedIds.filter(Boolean))]) {
        if (await lockProvider(tx, workspaceId, requestedId)) modelProviderIds.push(requestedId);
      }
    } else if (providerId && !await lockProvider(tx, workspaceId, providerId)) {
      providerId = null;
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
        sandbox: { select: { id: true, workspaceId: true, config: true } },
      },
    });
    if (!runtime || runtime.sandbox.workspaceId !== workspaceId) return false;

    const config = sandboxConfigWithEnv(runtime.sandbox.config, env);
    const updated = await tx.sandbox.updateMany({
      where: { id: runtime.sandbox.id, workspaceId },
      data: { config: config ?? {} },
    });
    return updated.count === 1;
  });
}

export async function setAgentTools(
  workspaceId: string,
  agentId: string,
  tools: {
    deploymentIds: string[];
    installedSkillIds: string[];
    toolkitIds: string[];
    sandboxIds?: string[];
    subAgentIds?: string[];
  },
) {
  const agent = await db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
  if (!agent) return;
  const [deployments, skills, toolkits, sandboxes, subAgents] = await Promise.all([
    db.deployment.findMany({ where: { id: { in: tools.deploymentIds }, workspaceId }, select: { id: true } }),
    db.installedSkill.findMany({ where: { id: { in: tools.installedSkillIds }, workspaceId }, select: { id: true } }),
    db.toolkit.findMany({ where: { id: { in: tools.toolkitIds }, workspaceId }, select: { id: true } }),
    db.sandbox.findMany({
      where: {
        id: { in: tools.sandboxIds ?? [] },
        workspaceId,
        kind: { not: HERMES_RUNTIME_KIND },
        deployment: {
          status: { notIn: UNAVAILABLE_SANDBOX_STATUSES },
        },
      },
      select: { id: true },
    }),
    // Same-workspace agents only, never the agent itself (no self-delegation).
    db.agent.findMany({
      where: { id: { in: tools.subAgentIds ?? [], not: agentId }, workspaceId },
      select: { id: true },
    }),
  ]);
  await db.$transaction([
    db.agentServer.deleteMany({ where: { agentId } }),
    db.agentSkill.deleteMany({ where: { agentId } }),
    db.agentToolkit.deleteMany({ where: { agentId } }),
    db.agentSandbox.deleteMany({ where: { agentId } }),
    db.agentSubAgent.deleteMany({ where: { parentId: agentId } }),
    db.agentServer.createMany({ data: deployments.map((d) => ({ agentId, deploymentId: d.id })) }),
    db.agentSkill.createMany({ data: skills.map((s) => ({ agentId, installedSkillId: s.id })) }),
    db.agentToolkit.createMany({ data: toolkits.map((t) => ({ agentId, toolkitId: t.id })) }),
    db.agentSandbox.createMany({ data: sandboxes.map((s) => ({ agentId, sandboxId: s.id })) }),
    db.agentSubAgent.createMany({ data: subAgents.map((s) => ({ parentId: agentId, childId: s.id })) }),
  ]);
}

export async function deleteAgent(workspaceId: string, agentId: string) {
  const runtime = await db.agentRuntime.findFirst({
    where: { agentId, workspaceId },
    select: { sandbox: { select: { deploymentId: true } } },
  });
  await db.$transaction(async (tx) => {
    if (runtime) {
      await tx.deployment.deleteMany({
        where: { id: runtime.sandbox.deploymentId, workspaceId, source: 'sandbox' },
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
  await db.$transaction(async (tx) => {
    if (!await lockProvider(tx, workspaceId, providerId)) return;

    await tx.agent.updateMany({
      where: { workspaceId, providerId },
      data: { providerId: null, model: null },
    });
    await tx.modelProvider.deleteMany({ where: { id: providerId, workspaceId } });
  });
}

export async function setProviderModels(workspaceId: string, providerId: string, models: string[]) {
  await db.modelProvider.updateMany({
    where: { id: providerId, workspaceId },
    data: { models, modelsFetchedAt: new Date() },
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
  return db.message.create({ data: { conversationId, role, parts } });
}
