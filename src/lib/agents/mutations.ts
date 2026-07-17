import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { sandboxVolumeName } from '@/lib/sandboxes/runtime';

const UNAVAILABLE_SANDBOX_STATUSES = [
  'copying',
  'copy_failed',
  'restoring',
  'restore_failed',
  'restore_cleanup_required',
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

async function uniqueSandboxSlug(workspaceId: string, baseSlug: string): Promise<string> {
  let slug = `${baseSlug}-runtime`;
  for (let i = 1; await db.sandbox.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${baseSlug}-runtime-${i}`;
  }
  return slug;
}

async function createAgentRecords(
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
) {
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
      runtime: { select: { workspaceId: true, kind: true, image: true } },
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
    ? { runtime: 'hermes', hermesImage: source.runtime.image }
    : { runtime: 'native' };
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
    await Promise.all([
      tx.agentServer.createMany({
        data: source.servers.map((server) => ({
          agentId: cloned.id,
          deploymentId: server.deploymentId,
        })),
      }),
      tx.agentSkill.createMany({
        data: source.skills.map((skill) => ({
          agentId: cloned.id,
          installedSkillId: skill.installedSkillId,
        })),
      }),
      tx.agentToolkit.createMany({
        data: source.toolkits.map((toolkit) => ({
          agentId: cloned.id,
          toolkitId: toolkit.toolkitId,
        })),
      }),
      tx.agentSandbox.createMany({
        data: source.sandboxes.map((sandbox) => ({
          agentId: cloned.id,
          sandboxId: sandbox.sandboxId,
        })),
      }),
      tx.agentSubAgent.createMany({
        data: source.subAgents.map((subAgent) => ({
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
    return { ...cloned, runtimeKind: runtime.runtime };
  });
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

export async function createConversation(workspaceId: string, agentId: string, title?: string) {
  const agent = await db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
  if (!agent) return null;
  return db.conversation.create({ data: { agentId, title: title ?? null } });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  parts: Prisma.InputJsonValue,
) {
  return db.message.create({ data: { conversationId, role, parts } });
}
