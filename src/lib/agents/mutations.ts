import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { sandboxVolumeName } from '@/lib/sandboxes/runtime';

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'agent';
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

export async function createAgent(
  workspaceId: string,
  name: string,
  options: CreateAgentOptions = {},
) {
  const base = slugify(name);
  let slug = base;
  for (let i = 1; await db.agent.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${base}-${i}`;
  }
  const cleanName = name.trim() || 'New agent';
  if (options.runtime !== HERMES_RUNTIME_KIND) {
    return db.agent.create({ data: { workspaceId, name: cleanName, slug } });
  }

  const image = resolveHermesImage(options.hermesImage);
  const sandboxSlug = await uniqueSandboxSlug(workspaceId, slug);
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.create({ data: { workspaceId, name: cleanName, slug } });
    const deployment = await tx.deployment.create({
      data: {
        workspaceId,
        name: `Hermes runtime: ${cleanName}`,
        source: 'sandbox',
        sourceRef: image,
        status: 'stopped',
      },
    });
    const sandbox = await tx.sandbox.create({
      data: {
        workspaceId,
        deploymentId: deployment.id,
        name: `${cleanName} Hermes`,
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
  });
}

export type AgentConfig = {
  name: string;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
  maxSteps: number;
};

export async function updateAgent(workspaceId: string, agentId: string, cfg: AgentConfig) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, runtime: { select: { kind: true } } },
  });
  if (!agent) return;

  let providerId = cfg.providerId;
  if (providerId) {
    const provider = await db.modelProvider.findFirst({
      where: { id: providerId, workspaceId },
      select: { id: true },
    });
    if (!provider) providerId = null;
  }
  await db.agent.updateMany({
    where: { id: agentId, workspaceId },
    data: {
      name: cfg.name,
      ...(agent.runtime?.kind === HERMES_RUNTIME_KIND ? {} : { systemPrompt: cfg.systemPrompt }),
      providerId,
      model: cfg.model,
      maxSteps: cfg.maxSteps,
    },
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

export async function deleteProvider(workspaceId: string, providerId: string) {
  await db.modelProvider.deleteMany({ where: { id: providerId, workspaceId } });
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
