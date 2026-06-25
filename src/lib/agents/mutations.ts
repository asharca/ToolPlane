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
  await db.agent.updateMany({
    where: { id: agentId, workspaceId },
    data: {
      name: cfg.name,
      systemPrompt: cfg.systemPrompt,
      providerId: cfg.providerId,
      model: cfg.model,
      maxSteps: cfg.maxSteps,
    },
  });
}

export async function setAgentTools(
  workspaceId: string,
  agentId: string,
  tools: { deploymentIds: string[]; installedSkillIds: string[]; toolkitIds: string[] },
) {
  const agent = await db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
  if (!agent) return;
  await db.$transaction([
    db.agentServer.deleteMany({ where: { agentId } }),
    db.agentSkill.deleteMany({ where: { agentId } }),
    db.agentToolkit.deleteMany({ where: { agentId } }),
    db.agentServer.createMany({ data: tools.deploymentIds.map((deploymentId) => ({ agentId, deploymentId })) }),
    db.agentSkill.createMany({ data: tools.installedSkillIds.map((installedSkillId) => ({ agentId, installedSkillId })) }),
    db.agentToolkit.createMany({ data: tools.toolkitIds.map((toolkitId) => ({ agentId, toolkitId })) }),
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

export async function createConversation(agentId: string, title?: string) {
  return db.conversation.create({ data: { agentId, title: title ?? null } });
}

export async function appendMessage(
  conversationId: string,
  role: string,
  parts: Prisma.InputJsonValue,
) {
  return db.message.create({ data: { conversationId, role, parts } });
}
