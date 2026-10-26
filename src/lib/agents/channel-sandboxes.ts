import "server-only";
import { db } from "@/lib/db";
import { ORDINARY_AGENT_FILTER } from "./queries";
import { isAgentEndpointRuntimeSandboxConfig } from "./public-api/tool-policy";

export async function listChannelSandboxes(
  workspaceId: string,
  sandboxId?: string,
) {
  const rows = await db.sandbox.findMany({
    where: { workspaceId, id: sandboxId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      kind: true,
      config: true,
      agentLinks: {
        where: { agent: { workspaceId, ...ORDINARY_AGENT_FILTER } },
        select: { agent: { select: { id: true, name: true } } },
      },
    },
  });
  return rows
    .filter((row) => !isAgentEndpointRuntimeSandboxConfig(row.config))
    .map((row) => {
      const agent = row.agentLinks[0]?.agent;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
      };
    });
}

export async function getChannelSandbox(
  workspaceId: string,
  sandboxId: string,
) {
  return (await listChannelSandboxes(workspaceId, sandboxId))[0] ?? null;
}

export async function agentChannelSandboxId(
  workspaceId: string,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, ...ORDINARY_AGENT_FILTER },
    select: {
      sandboxes: {
        where: { sandbox: { workspaceId } },
        orderBy: { isDefault: "desc" },
        take: 1,
        select: { sandboxId: true },
      },
    },
  });
  return agent?.sandboxes[0]?.sandboxId ?? null;
}
