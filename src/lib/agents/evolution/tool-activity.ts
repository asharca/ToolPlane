import "server-only";
import type { Prisma } from "@prisma/client";
import type { SandboxRuntimeActivity } from "@/lib/agents/sandbox-runtime";
import { parseEvolutionPayload } from "./schemas";

/** Both admitted native stdio and extension UI events use the same call identity. */
export async function recordTaskToolActivity(
  tx: Prisma.TransactionClient,
  scope: { agentId: string; workspaceId: string; actorId: string },
  taskId: string,
  activity: SandboxRuntimeActivity,
) {
  if (activity.type !== "tool" || !activity.toolCallId) return;
  const sourceId = activity.source?.subagentId ?? "root";
  const key = `${taskId}:${sourceId}:${activity.toolCallId}`;
  const status =
    activity.isError === true || activity.status === "failed"
      ? "failed"
      : activity.status;
  const payload = parseEvolutionPayload("tool-call", {
    taskId,
    toolCallId: activity.toolCallId,
    toolName: activity.toolName ?? "tool",
    sourceId,
  });
  await tx.agentEvolutionRecord.upsert({
    where: {
      agentId_kind_key: { agentId: scope.agentId, kind: "tool-call", key },
    },
    create: {
      agentId: scope.agentId,
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      kind: "tool-call",
      key,
      status,
      payload,
    },
    update: { status },
  });
}
