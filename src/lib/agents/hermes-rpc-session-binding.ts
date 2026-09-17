import 'server-only';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';

/** Independent platform binding; managed Hermes and channel session keys stay untouched. */
export async function bindHermesRpcConversation(input: {
  workspaceId: string; agentId: string; conversationId: string; sandboxId: string;
  providerId: string; modelId: string; providerFormat: string; workingDirectory: string;
}) {
  const binding = `hermes-rpc:v1:${createHash('sha256').update(JSON.stringify({
    sandboxId: input.sandboxId, providerId: input.providerId, modelId: input.modelId,
    format: input.providerFormat, cwd: input.workingDirectory,
  })).digest('hex')}`;
  const where = { id: input.conversationId, agentId: input.agentId,
    agent: { workspaceId: input.workspaceId, runtimeKind: 'hermes-rpc' },
    publicApiConversation: { is: null },
  };
  // Compare-and-set prevents two first turns from silently pinning different
  // sandboxes. No provider key or runtime grant is persisted in this field.
  await db.conversation.updateMany({ where: { ...where, hermesRpcBinding: null }, data: { hermesRpcBinding: binding } });
  const conversation = await db.conversation.findFirst({ where, select: { hermesRpcBinding: true } });
  if (!conversation) throw new Error('Hermes RPC conversation was not found in this Agent and workspace.');
  if (conversation.hermesRpcBinding !== binding) throw new Error('Hermes RPC sandbox, model or work directory changed. Start a new conversation to use the new binding.');
}
