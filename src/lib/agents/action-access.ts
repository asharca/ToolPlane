import "server-only";
import { db } from "@/lib/db";

export async function isManageableAgent(
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      publicRuntimeAllocation: { select: { id: true } },
    },
  });
  return Boolean(agent && !agent.publicRuntimeAllocation);
}
