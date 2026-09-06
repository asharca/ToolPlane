import 'server-only';
import { db } from '@/lib/db';
import { appendWorkSessionInput } from '@/lib/work/sessions';
import { getAgentForRun } from './queries';
import { resolveAgentTools } from './resolve';
import { runDedicatedSandboxTurn } from './sandbox-turn';
import { appendConversationTurn } from './mutations';
import { acquireConversationOperation, conversationOperationKey, operateConversation } from './conversation-operations';
import { activeConversationMessages, CLEAR_CONTEXT_PART } from './conversation-context';
import { COMMAND_RESULT_PART, RUNTIME_COMMANDS_PART, RUNTIME_USAGE_PART, parseRuntimeCommand, sessionRuntimeCommands, type RuntimeUsage } from './runtime-commands';

export class RuntimeCommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function executeRuntimeCommand(input: {
  workspaceId: string; agentId: string; conversationId: string; line: string; sandboxId?: string; signal?: AbortSignal;
}) {
  const parsed = parseRuntimeCommand(input.line);
  if (!parsed || input.line.length > 2000) throw new RuntimeCommandError('invalidCommand');
  const [agent, scope] = await Promise.all([
    getAgentForRun(input.agentId, input.workspaceId),
    db.conversation.findFirst({ where: { id: input.conversationId, agentId: input.agentId, agent: { workspaceId: input.workspaceId } },
      include: { workSession: true, publicApiConversation: { select: { id: true } }, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } }),
  ]);
  if (!agent || !scope || scope.publicApiConversation) throw new RuntimeCommandError('notFound', 404);
  const kind = scope.workSession?.runtimeKind ?? agent.runtimeKind;
  if (agent.runtimeKind !== kind) throw new RuntimeCommandError('runtimeChanged', 409);
  if (!sessionRuntimeCommands(kind, scope.messages).some((command) => command.name === parsed.name)) throw new RuntimeCommandError('unsupportedCommand');
  if (parsed.name === 'compact' && kind === 'hermes') return { kind: 'compact' as const, ...await operateConversation({ ...input, action: 'compact', instructions: parsed.args }) };
  const release = acquireConversationOperation(conversationOperationKey(scope), parsed.name);
  if (!release) throw new RuntimeCommandError('busy', 409);
  try {
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: scope.id }, include: { workSession: true, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    const work = conversation.workSession;
    if (work && ['queued', 'running', 'waiting_approval', 'cancelling', 'archived'].includes(work.status)) throw new RuntimeCommandError('busy', 409);
    // Argument validation, output and state changes belong to the runtime, not same-named host substitutes.
    const control = ['clear', 'context', 'usage'].includes(parsed.name) || (parsed.name === 'goal' && ['', 'pause', 'clear'].includes(parsed.args.toLowerCase()));
    if (work) {
      const result = await appendWorkSessionInput(input.workspaceId, work.id, input.line);
      if (!result.ok) throw new RuntimeCommandError('busy', 409);
      const { startWorkOutput } = await import('@/lib/work/run-control');
      const { kickWorkCoordinator } = await import('@/lib/work/coordinator');
      startWorkOutput(work.id);
      kickWorkCoordinator();
      return { kind: 'queued' as const, workSessionId: work.id };
    }
    if (kind !== 'dsh' && kind !== 'claude-code' && kind !== 'pi') throw new RuntimeCommandError('unsupportedCommand');
    const sandboxId = input.sandboxId ?? agent.sandboxes[0]?.sandboxId;
    const resolved = resolveAgentTools(agent, sandboxId);
    let commands = sessionRuntimeCommands(kind, conversation.messages);
    let runtimeUsage: RuntimeUsage | undefined;
    const text = await runDedicatedSandboxTurn({ agent, sandboxId, command: input.line, runtimeSessionId: conversation.id,
      messages: activeConversationMessages(conversation.messages).map((message) => ({ role: message.role, parts: Array.isArray(message.parts) ? message.parts : [] })),
      systemPrompt: agent.systemPrompt, skills: resolved.skills, deploymentIds: resolved.deploymentIds.filter((id) => !resolved.sandboxDeploymentIds.includes(id)),
      signal: input.signal,
      onCommands: (next) => { commands = next; }, onUsage: (next) => { runtimeUsage = next; } })
      .catch((error: unknown) => { throw new RuntimeCommandError(error instanceof Error ? error.message : 'The runtime command failed.', 502); });
    const metadata = [
      { type: RUNTIME_COMMANDS_PART, data: { runtimeKind: kind, commands } },
      ...(runtimeUsage ? [{ type: RUNTIME_USAGE_PART, data: runtimeUsage }] : []),
      ...(parsed.name === 'clear' ? [{ type: CLEAR_CONTEXT_PART, data: { completedAt: new Date().toISOString() } }] : []),
    ];
    input.signal?.throwIfAborted();
    if (control || parsed.name === 'compact') await db.message.create({ data: { conversationId: conversation.id, role: 'assistant', parts: [
      { type: 'text', text }, { type: COMMAND_RESULT_PART, data: { command: parsed.name, text } }, ...metadata,
    ], textCharacters: text.length } });
    else await appendConversationTurn(conversation.id, [{ type: 'text', text: input.line }], [{ type: 'text', text }, ...metadata]);
    return { kind: 'output' as const, text };
  } finally { release(); }
}
