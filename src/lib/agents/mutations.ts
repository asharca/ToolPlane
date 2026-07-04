import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'agent';
}

export async function createAgent(workspaceId: string, name: string) {
  const base = slugify(name);
  let slug = base;
  for (let i = 1; await db.agent.findFirst({ where: { workspaceId, slug } }); i += 1) {
    slug = `${base}-${i}`;
  }
  return db.agent.create({ data: { workspaceId, name: name.trim() || 'New agent', slug } });
}

export type AgentConfig = {
  name: string;
  systemPrompt: string | null;
  providerId: string | null;
  model: string | null;
  maxSteps: number;
};

export async function updateAgent(workspaceId: string, agentId: string, cfg: AgentConfig) {
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
      systemPrompt: cfg.systemPrompt,
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
    db.sandbox.findMany({ where: { id: { in: tools.sandboxIds ?? [] }, workspaceId }, select: { id: true } }),
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
  await db.agent.deleteMany({ where: { id: agentId, workspaceId } });
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
