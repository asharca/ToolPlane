import "server-only";
import { db } from "@/lib/db";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";

/** Read-only: opening Files must not provision a conversation workspace. */
export async function getConversationWorkspaceSandbox(input: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
}) {
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    select: { sandboxId: true, title: true },
  });
  if (!conversation?.sandboxId) return null;
  const mapping = await findAgentConversationSandbox(input);
  if (!mapping) return null;
  const sandbox = await db.sandbox.findFirst({
    where: {
      id: mapping.sandboxId,
      workspaceId: input.workspaceId,
      deploymentId: mapping.deploymentId,
    },
    select: {
      id: true,
      name: true,
      kind: true,
      deploymentId: true,
      deployment: { select: { status: true } },
    },
  });
  return sandbox
    ? { ...sandbox, name: conversation.title ?? sandbox.name }
    : null;
}
