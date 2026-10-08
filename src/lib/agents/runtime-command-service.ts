import 'server-only';
import { randomUUID } from 'node:crypto';
import { runNativeEntry, nativeEntryResult, nativeEntryRuntimeParts } from '@/lib/a2a/ingress';
import type { EntryIdentity } from '@/lib/a2a/entry-policy';
import type { TaskGrant } from '@/lib/a2a/principal';
import type { RuntimeUsage } from './runtime-commands';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { isDedicatedSandboxRuntimeKind } from './runtime-kind';
import { db } from '@/lib/db';
import { ACTIVE } from '@/lib/a2a/model';
import { localOwnerKey, assertLocalActor } from '@/lib/a2a/local-policy';
import { assertEntryPolicy } from '@/lib/a2a/entry-policy';
import { isLocalGrant } from '@/lib/a2a/principal';
import type { PiHarnessOperationResult } from './sandbox-runtime';
import { appendWorkSessionInput } from '@/lib/work/sessions';
import { getAgentForRun } from './queries';
import { resolveAgentTools } from './resolve';
import { runDedicatedSandboxTurn } from './sandbox-turn';
import { appendConversationTurn } from './mutations';
import { acquireConversationOperation, conversationOperationKey, operateConversation } from './conversation-operations';
import { activeConversationMessages, CLEAR_CONTEXT_PART } from './conversation-context';
import { COMMAND_RESULT_PART, RUNTIME_COMMANDS_PART, RUNTIME_USAGE_PART, parseRuntimeCommand, sessionRuntimeCommands } from './runtime-commands';

export class RuntimeCommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function executeRuntimeCommand(input: {
  workspaceId: string; agentId: string; conversationId: string; actorId?: string; line: string; sandboxId?: string; signal?: AbortSignal;
  entry?: Pick<EntryIdentity, 'kind' | 'channelId'>; messageId?: string;
}) {
  const [agent, scope] = await Promise.all([
    getAgentForRun(input.agentId, input.workspaceId),
    db.conversation.findFirst({ where: { id: input.conversationId, agentId: input.agentId, agent: { workspaceId: input.workspaceId } },
      include: { workSession: true, publicApiConversation: { select: { id: true } }, messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } }),
  ]);
  if (!agent || !scope || scope.publicApiConversation) throw new RuntimeCommandError('notFound', 404);
  const kind = scope.workSession?.runtimeKind ?? agent.runtimeKind;
  if (agent.runtimeKind !== kind) throw new RuntimeCommandError('runtimeChanged', 409);
  const parsed = parseRuntimeCommand(input.line, kind);
  if (!parsed || input.line.length > 2000) throw new RuntimeCommandError('invalidCommand');
  if (kind !== 'pi-sdk' && !sessionRuntimeCommands(kind, scope.messages).some((command) => command.name === parsed.name)) throw new RuntimeCommandError('unsupportedCommand');
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
    if (!isDedicatedSandboxRuntimeKind(kind)) throw new RuntimeCommandError('unsupportedCommand');
    let nativeContextId: string | undefined;
    let sdkEntry: EntryIdentity = { ...input.entry, kind: input.entry?.kind ?? 'chat', sourceId: conversation.id };
    if (kind === 'pi' || kind === 'pi-sdk') {
      const bindings = await db.a2AEntryBinding.findMany({ where: { sourceId: conversation.id,
        context: { workspaceId: input.workspaceId, agentId: input.agentId } }, include: { lastTask: true } });
      if (bindings.length) {
        if (!input.actorId) throw new RuntimeCommandError('notFound', 404);
        const owned = bindings.filter((binding) => {
          const grant = binding.lastTask.grant as unknown as TaskGrant;
          return isLocalGrant(grant) && grant.actorId === input.actorId && grant.workspaceId === input.workspaceId && grant.agentId === input.agentId
            && grant.ownerKey === binding.ownerKey && (binding.ownerKey === localOwnerKey('entry', input.workspaceId, input.agentId, input.actorId!, binding.kind, conversation.id)
              || binding.ownerKey === localOwnerKey(input.workspaceId, input.agentId, input.actorId!));
        });
        if (owned.length !== 1) throw new RuntimeCommandError('notFound', 404);
        const binding = owned[0];
        const grant = binding.lastTask.grant as unknown as TaskGrant;
        if (!isLocalGrant(grant) || !grant.entryPolicy || grant.entryPolicy.sourceId !== conversation.id
          || grant.entryPolicy.kind !== binding.kind || binding.lastTask.contextId !== binding.contextId) throw new RuntimeCommandError('notFound', 404);
        try {
          await assertLocalActor(db, input.workspaceId, input.actorId);
          await assertEntryPolicy(db, grant);
        } catch (error) {
          if (error instanceof TaskNotFoundError || error instanceof UnsupportedOperationError) throw new RuntimeCommandError('notFound', 404);
          throw error;
        }
        if (await db.a2ATask.count({ where: { contextId: binding.contextId, state: { in: ACTIVE } } })) throw new RuntimeCommandError('busy', 409);
        if (kind === 'pi') {
          if (parsed.name !== 'compact' || binding.lastTask.executionBackend !== 'pi-harness') throw new RuntimeCommandError('unsupportedCommand');
          nativeContextId = binding.contextId;
        } else {
          if (input.entry && (input.entry.kind !== grant.entryPolicy.kind || input.entry.channelId !== grant.entryPolicy.channelId)) throw new RuntimeCommandError('notFound', 404);
          sdkEntry = { kind: grant.entryPolicy.kind, sourceId: conversation.id, ...(grant.entryPolicy.channelId ? { channelId: grant.entryPolicy.channelId } : {}) };
        }
      } else if (kind === 'pi' && conversation.runtimeSessionKey?.startsWith('channel:')) {
        // A channel created by /new has no native session until its first task.
        throw new RuntimeCommandError('unsupportedCommand');
      }
    }
    if (kind === 'pi-sdk') {
      if (!input.actorId) throw new RuntimeCommandError('notFound', 404);
      if (sdkEntry.kind === 'channel' && !input.messageId) throw new RuntimeCommandError('invalidCommand');
      try {
        const result = await runNativeEntry({ ...sdkEntry, workspaceId: input.workspaceId, agentId: input.agentId,
          actorId: input.actorId, messageId: input.messageId ?? randomUUID(), text: input.line, signal: input.signal });
        const text = nativeEntryResult(result.task, result.path);
        input.signal?.throwIfAborted();
        await appendConversationTurn(conversation.id, [{ type: 'text', text: input.line }], [
          { type: 'text', text }, ...nativeEntryRuntimeParts(result.task),
        ]);
        return { kind: 'output' as const, text };
      } catch (error) {
        if (error instanceof TaskNotFoundError) throw new RuntimeCommandError('notFound', 404);
        throw new RuntimeCommandError(error instanceof Error ? error.message : 'The runtime command failed.', 502);
      }
    }
    const sandboxId = input.sandboxId ?? agent.sandboxes[0]?.sandboxId;
    const resolved = resolveAgentTools(agent, sandboxId);
    let commands = sessionRuntimeCommands(kind, conversation.messages);
    let runtimeUsage: RuntimeUsage | undefined;
    let nativeResult: PiHarnessOperationResult | undefined;
    const text = await runDedicatedSandboxTurn({ agent, sandboxId, command: input.line, runtimeSessionId: conversation.id,
      ...(nativeContextId ? { nativeCompaction: { contextId: nativeContextId, customInstructions: parsed.args, onResult: (result: PiHarnessOperationResult) => { nativeResult = result; } } } : {}),
      messages: activeConversationMessages(conversation.messages).map((message) => ({ role: message.role, parts: Array.isArray(message.parts) ? message.parts : [] })),
      systemPrompt: agent.systemPrompt, skills: resolved.skills, deploymentIds: resolved.deploymentIds.filter((id) => !resolved.sandboxDeploymentIds.includes(id)),
      signal: input.signal,
      onCommands: (next) => { commands = next; }, onUsage: (next) => { runtimeUsage = next; } })
      .catch((error: unknown) => { throw new RuntimeCommandError(error instanceof Error ? error.message : 'The runtime command failed.', error instanceof Error && /PI_LANE_BUSY|sandbox.*busy|already.*execut/i.test(error.message) ? 409 : 502); });
    const metadata = [
      { type: RUNTIME_COMMANDS_PART, data: { runtimeKind: kind, commands } },
      ...(runtimeUsage ? [{ type: RUNTIME_USAGE_PART, data: runtimeUsage }] : []),
      ...(parsed.name === 'clear' ? [{ type: CLEAR_CONTEXT_PART, data: { completedAt: new Date().toISOString() } }] : []),
    ];
    input.signal?.throwIfAborted();
    if (control || parsed.name === 'compact') await db.message.create({ data: { conversationId: conversation.id, role: 'assistant', parts: [
      { type: 'text', text }, { type: COMMAND_RESULT_PART, data: { command: parsed.name, text, ...(nativeResult ? { status: nativeResult.status, operationId: nativeResult.operationId, contextId: nativeContextId } : {}) } }, ...metadata,
    ], textCharacters: text.length } });
    else await appendConversationTurn(conversation.id, [{ type: 'text', text: input.line }], [{ type: 'text', text }, ...metadata]);
    return { kind: 'output' as const, text };
  } finally { release(); }
}
