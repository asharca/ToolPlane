import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  AgentConfigurationError,
  createConfiguredAgent,
} from "@/lib/agents/mutations";
import {
  runWorkspaceAgentMessage,
  type AgentMessageResult,
} from "@/lib/agents/message-service";
import { effectiveStatus, effectiveStatuses } from "@/lib/process/supervisor";
import { listMcpTools } from "@/lib/process/mcp-client";
import {
  filterMcpToolsForAi,
  mcpToolPolicyFromStored,
} from "@/lib/workspace/mcp-tool-exposure";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { skillLabel } from "@/lib/workspace/skill-label";
import type { ImplementedAgentRuntimeKind } from "@/lib/agents/runtime-kind";

export class AgentControlError extends Error {
  constructor(
    public readonly code:
      | "invalid_arguments"
      | "not_found"
      | "not_configured"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AgentControlError";
  }
}

export type CreateAgentFromControlInput = {
  name: string;
  runtime: ImplementedAgentRuntimeKind;
  systemPrompt?: string | null;
  providerId?: string | null;
  model?: string | null;
  maxSteps: number;
  deploymentIds: string[];
  installedSkillIds: string[];
  toolkitIds: string[];
  sandboxIds: string[];
  subAgentIds: string[];
};

const AGENT_CONTROL_SELECT = {
  id: true,
  name: true,
  slug: true,
  runtimeKind: true,
  retiredAt: true,
  currentRevisionVersion: true,
  systemPrompt: true,
  providerId: true,
  model: true,
  maxSteps: true,
  createdAt: true,
  updatedAt: true,
  provider: { select: { id: true, name: true, format: true } },
  servers: {
    select: {
      deployment: {
        select: {
          id: true,
          status: true,
          serverId: true,
          name: true,
          source: true,
          sourceRef: true,
          server: { select: { name: true, slug: true } },
        },
      },
    },
  },
  skills: {
    select: {
      installedSkill: {
        select: {
          id: true,
          skillId: true,
          name: true,
          slug: true,
          description: true,
          source: true,
          status: true,
          skill: { select: { name: true, slug: true } },
        },
      },
    },
  },
  toolkits: {
    select: {
      toolkit: { select: { id: true, name: true, slug: true, enabled: true } },
    },
  },
  sandboxes: {
    select: {
      sandbox: {
        select: {
          id: true,
          name: true,
          slug: true,
          kind: true,
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      },
    },
  },
  subAgents: {
    select: {
      child: { select: { id: true, name: true, slug: true } },
    },
  },
  _count: { select: { conversations: true } },
} as const;

type AgentControlRow = Prisma.AgentGetPayload<{
  select: typeof AGENT_CONTROL_SELECT;
}>;

function toSafeAgent(agent: AgentControlRow, workspaceSlug: string) {
  const configured = Boolean(agent.provider && agent.model);
  const readOnly = agent.runtimeKind !== "pi-sdk" || Boolean(agent.retiredAt);
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    runtime: { kind: agent.runtimeKind, status: null, image: null },
    configured,
    readOnly,
    ready: !readOnly && configured && agent.currentRevisionVersion > 0,
    systemPrompt: agent.systemPrompt,
    model: {
      providerId: agent.providerId,
      provider: agent.provider
        ? { name: agent.provider.name, format: agent.provider.format }
        : null,
      model: agent.model,
    },
    maxSteps: agent.maxSteps,
    resources: {
      deployments: agent.servers.map(({ deployment }) => {
        const label = deploymentLabel(deployment);
        return {
          id: deployment.id,
          name: label.name,
          source: label.source,
          ref: label.ref,
          status: effectiveStatus(deployment.id, deployment.status),
        };
      }),
      skills: agent.skills.map(({ installedSkill }) => {
        const label = skillLabel(installedSkill);
        return {
          id: installedSkill.id,
          name: label.name,
          slug: label.slug,
          source: label.source,
          description: installedSkill.description,
          status: installedSkill.status,
        };
      }),
      toolkits: agent.toolkits.map(({ toolkit }) => toolkit),
      sandboxes: agent.sandboxes.map(({ sandbox }) => ({
        id: sandbox.id,
        name: sandbox.name,
        slug: sandbox.slug,
        kind: sandbox.kind,
        status: effectiveStatus(
          sandbox.deploymentId,
          sandbox.deployment.status,
        ),
      })),
      subAgents: agent.subAgents.map(({ child }) => child),
    },
    conversationCount: agent._count.conversations,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    consolePath: `/app/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agent.id)}`,
    messageEndpoint: `/api/v1/agents/${encodeURIComponent(agent.id)}/messages`,
  };
}

function loadAgentControlRow(workspaceId: string, agentId: string) {
  return db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: AGENT_CONTROL_SELECT,
  });
}

export async function listAgentControlResources(workspaceId: string) {
  const [providers, deployments, skills, toolkits, sandboxes] =
    await Promise.all([
      db.modelProvider.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, format: true, models: true },
      }),
      db.deployment.findMany({
        where: {
          workspaceId,
          OR: [{ source: null }, { source: { not: "sandbox" } }],
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          serverId: true,
          name: true,
          source: true,
          sourceRef: true,
          server: { select: { name: true, slug: true, description: true } },
        },
      }),
      db.installedSkill.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          skillId: true,
          name: true,
          slug: true,
          description: true,
          source: true,
          status: true,
          userInvocable: true,
          agentInvocable: true,
          skill: { select: { name: true, slug: true, description: true } },
        },
      }),
      db.toolkit.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          slug: true,
          enabled: true,
          _count: { select: { servers: true, skills: true } },
        },
      }),
      db.sandbox.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          kind: true,
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      }),
    ]);
  const statuses = effectiveStatuses(deployments);
  return {
    providers,
    deployments: deployments.map((deployment) => {
      const label = deploymentLabel(deployment);
      return {
        id: deployment.id,
        name: label.name,
        source: label.source,
        ref: label.ref,
        description: deployment.server?.description ?? null,
        status: statuses.get(deployment.id) ?? deployment.status,
      };
    }),
    skills: skills.map((skill) => {
      const label = skillLabel(skill);
      return {
        id: skill.id,
        name: label.name,
        slug: label.slug,
        source: label.source,
        description: skill.skill?.description ?? skill.description,
        status: skill.status,
        userInvocable: skill.userInvocable,
        agentInvocable: skill.agentInvocable,
      };
    }),
    toolkits: toolkits.map((toolkit) => ({
      id: toolkit.id,
      name: toolkit.name,
      slug: toolkit.slug,
      enabled: toolkit.enabled,
      serverCount: toolkit._count.servers,
      skillCount: toolkit._count.skills,
    })),
    sandboxes: sandboxes.map((sandbox) => ({
      id: sandbox.id,
      name: sandbox.name,
      slug: sandbox.slug,
      kind: sandbox.kind,
      status: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status),
    })),
  };
}

export async function listAgentControlAgents(workspaceId: string) {
  const agents = await db.agent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      runtimeKind: true,
      retiredAt: true,
      currentRevisionVersion: true,
      providerId: true,
      model: true,
      provider: { select: { name: true } },
      _count: {
        select: {
          servers: true,
          skills: true,
          toolkits: true,
          sandboxes: true,
          subAgents: true,
          conversations: true,
        },
      },
    },
  });
  return agents.map((agent) => {
    const configured = Boolean(agent.provider && agent.model);
    const readOnly = agent.runtimeKind !== "pi-sdk" || Boolean(agent.retiredAt);
    return {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      runtime: agent.runtimeKind,
      runtimeStatus: null,
      configured,
      readOnly,
      ready: !readOnly && configured && agent.currentRevisionVersion > 0,
      providerId: agent.providerId,
      providerName: agent.provider?.name ?? null,
      model: agent.model,
      counts: {
        tools:
          agent._count.servers +
          agent._count.skills +
          agent._count.toolkits +
          agent._count.sandboxes,
        subAgents: agent._count.subAgents,
        conversations: agent._count.conversations,
      },
    };
  });
}

export async function getAgentControlAgent(
  workspaceId: string,
  workspaceSlug: string,
  agentId: string,
) {
  const agent = await loadAgentControlRow(workspaceId, agentId);
  if (!agent) throw new AgentControlError("not_found", "Agent not found.");
  return toSafeAgent(agent, workspaceSlug);
}

export async function inspectAgentControlDeployment(
  workspaceId: string,
  deploymentId: string,
) {
  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    select: {
      id: true,
      status: true,
      serverId: true,
      name: true,
      source: true,
      sourceRef: true,
      mcpToolExposure: true,
      mcpAllowedTools: true,
      server: { select: { name: true, description: true } },
    },
  });
  if (!deployment)
    throw new AgentControlError("not_found", "MCP deployment not found.");
  const label = deploymentLabel(deployment);
  const status = effectiveStatus(deployment.id, deployment.status);
  const tools =
    status === "running"
      ? filterMcpToolsForAi(
          await listMcpTools(deployment.id),
          mcpToolPolicyFromStored(deployment),
        )
      : [];
  return {
    deployment: {
      id: deployment.id,
      name: label.name,
      source: label.source,
      ref: label.ref,
      description: deployment.server?.description ?? null,
      status,
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    })),
    note:
      status === "running"
        ? null
        : "Start this MCP deployment before inspecting or using its tools.",
  };
}

export async function createAgentFromControl(
  workspaceId: string,
  workspaceSlug: string,
  input: CreateAgentFromControlInput,
) {
  if (input.runtime !== "pi-sdk") {
    throw new AgentControlError(
      "invalid_arguments",
      "Historical Agents are read-only. Create a Pi Agent.",
    );
  }
  if (input.model && !input.providerId) {
    throw new AgentControlError(
      "invalid_arguments",
      "A model requires providerId.",
    );
  }

  let created: { id: string };
  try {
    created = await createConfiguredAgent(
      workspaceId,
      {
        name: input.name,
        systemPrompt: input.systemPrompt?.trim() || null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        maxSteps: input.maxSteps,
      },
      {
        deploymentIds: input.deploymentIds,
        installedSkillIds: input.installedSkillIds,
        toolkitIds: input.toolkitIds,
        sandboxIds: input.sandboxIds,
        subAgentIds: input.subAgentIds,
      },
      { runtime: input.runtime },
    );
  } catch (error) {
    if (error instanceof AgentConfigurationError) {
      throw new AgentControlError("invalid_arguments", error.message);
    }
    throw error;
  }

  const runtimeSync = { status: "pi-sdk" };

  return {
    created: true,
    agent: await getAgentControlAgent(workspaceId, workspaceSlug, created.id),
    runtimeSync,
  };
}

export async function sendAgentControlMessage(
  workspaceId: string,
  input: { agentId: string; message: string; conversationId?: string },
  actorId?: string,
) {
  const sourceId = randomUUID();
  let result: AgentMessageResult;
  try {
    result = await runWorkspaceAgentMessage({
      userId: actorId,
      workspaceId,
      agentId: input.agentId,
      rawBody: {
        message: input.message,
        conversationId: input.conversationId,
        source: {
          platform: "mcp",
          chatType: "dm",
          chatId: sourceId,
          userId: sourceId,
        },
      },
    });
  } catch {
    throw new AgentControlError(
      "unavailable",
      "Agent execution failed. Try again or inspect the Agent console.",
    );
  }
  if ("error" in result.body) {
    const code =
      result.status === 404
        ? "not_found"
        : result.status === 400
          ? "not_configured"
          : "unavailable";
    const message =
      result.status === 400 || result.status === 404
        ? result.body.error
        : "Agent runtime is unavailable. Try again or inspect the Agent console.";
    throw new AgentControlError(code, message);
  }
  return {
    agentId: result.body.agentId,
    conversationId: result.body.conversationId,
    delivery: result.body.delivery,
    message: result.body.message,
  };
}
