import "server-only";
import { db } from "@/lib/db";

export type McpConnectionImpact = {
  agentIds: string[];
  assistantIds: string[];
};

export async function connectionImpact(
  workspaceId: string,
  deploymentId: string,
): Promise<McpConnectionImpact> {
  const [agents, assistants] = await Promise.all([
    db.agentServer.findMany({
      where: { deploymentId, agent: { workspaceId } },
      select: { agentId: true },
    }),
    db.chatAssistantMcpGrant.findMany({
      where: { deploymentId, assistant: { workspaceId } },
      select: { assistantId: true },
    }),
  ]);
  return {
    agentIds: agents.map((entry) => entry.agentId).sort(),
    assistantIds: assistants.map((entry) => entry.assistantId).sort(),
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
