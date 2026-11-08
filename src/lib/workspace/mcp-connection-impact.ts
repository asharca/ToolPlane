import "server-only";
import { db } from "@/lib/db";

export type McpConnectionImpact = {
  agentIds: string[];
  assistantIds: string[];
  /** Display names by id; confirmation compares ids only. */
  names: Record<string, string>;
};

export async function connectionImpact(
  workspaceId: string,
  deploymentId: string,
): Promise<McpConnectionImpact> {
  const [agents, assistants] = await Promise.all([
    db.agentServer.findMany({
      where: { deploymentId, agent: { workspaceId } },
      select: { agentId: true, agent: { select: { name: true } } },
    }),
    db.chatAssistantMcpGrant.findMany({
      where: { deploymentId, assistant: { workspaceId } },
      select: { assistantId: true, assistant: { select: { name: true } } },
    }),
  ]);
  return {
    agentIds: agents.map((entry) => entry.agentId).sort(),
    assistantIds: assistants.map((entry) => entry.assistantId).sort(),
    names: Object.fromEntries([
      ...agents.map((entry) => [entry.agentId, entry.agent.name]),
      ...assistants.map((entry) => [entry.assistantId, entry.assistant.name]),
    ]),
  };
}

export function confirmedConnectionImpact(
  formData: FormData,
  impact: McpConnectionImpact,
): boolean {
  if (impact.agentIds.length === 0 && impact.assistantIds.length === 0)
    return true;
  try {
    const confirmed = JSON.parse(
      String(formData.get("confirmedImpactedObjects") ?? "null"),
    );
    return (
      confirmed !== null &&
      JSON.stringify(confirmed.agentIds) === JSON.stringify(impact.agentIds) &&
      JSON.stringify(confirmed.assistantIds) ===
        JSON.stringify(impact.assistantIds)
    );
  } catch {
    return false;
  }
}
