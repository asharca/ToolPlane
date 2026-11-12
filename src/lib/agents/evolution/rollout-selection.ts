import "server-only";
import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { parseEvolutionPayload } from "./schemas";
/** Call only when creating a new durable session/context, never for reads or resumes. */
export async function selectNewSessionRevision(
  tx: Prisma.TransactionClient,
  agentId: string,
) {
  const current = await requireAgentRevision(tx, agentId);
  const settings = await tx.agentEvolutionSettings.findUnique({
    where: { agentId },
  });
  if (!settings?.enabled) return current;
  const rollout = await tx.agentEvolutionRecord.findFirst({
    where: { agentId, kind: "rollout", status: "active" },
  });
  if (!rollout) return current;
  const p = parseEvolutionPayload("rollout", rollout.payload);
  if (p.baselineRevisionId !== current.id) return current;
  return randomInt(100) < p.percentage
    ? requireAgentRevision(tx, agentId, p.candidateRevisionId)
    : current;
}
