import { randomUUID } from 'node:crypto';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import {
  appendMessage,
  ensureConversationRuntimeSession,
} from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import { buildAgentToolSet } from '@/lib/agents/run';
import { uiMessagesToPi, runNativeAgent } from '@/lib/agents/native';
import {
  createNativeUiStreamBridge,
  createSandboxUiStreamBridge,
} from '@/lib/agents/ui-stream';
import { parseAgentChatBody, type AgentChatBody } from '@/lib/agents/chat-body';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import { writeHermesChatStream } from '@/lib/agents/hermes/client';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from '@/lib/agents/hermes/runtime';
import {
  hermesAssistantSegments,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';
import {
  implementedAgentRuntimeKind,
  isDedicatedSandboxRuntimeKind,
} from '@/lib/agents/runtime-kind';
import { runDedicatedSandboxTurn } from '@/lib/agents/sandbox-turn';
import {
  AttachmentMessageError,
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
  hydrateWorkspaceAttachmentMessages,
} from '@/lib/attachments/messages';

export const runtime = 'nodejs';
export const maxDuration = 900;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return new Response('Not found', { status: 404 });
  const runtimeKind = implementedAgentRuntimeKind(agent.runtimeKind);
  if (!runtimeKind) return new Response(`Agent runtime "${agent.runtimeKind}" is not available.`, { status: 409 });
  const isHermes = runtimeKind === 'hermes';
  if (isHermes ? agent.modelProviders.length === 0 : !agent.provider || !agent.model) {
    return new Response(
      isHermes
        ? 'This Hermes agent has no model provider configured. Open Settings and select one or more providers.'
        : 'This agent has no model configured. Open Settings and pick a provider + model.',
      { status: 400 },
    );
  }

  // Keep the lease through Hermes' volume write and the matching database
  // persistence in onFinish. A clone closes this gate before it snapshots.
  const hermesWriteLease = isHermes
    ? acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id)
    : null;
  if (isHermes && !hermesWriteLease) {
    return new Response(HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR, { status: 503 });
  }
  let streamOwnsHermesWriteLease = false;
  let hermesLeaseReleased = false;
  const releaseHermesWriteLease = () => {
    if (hermesWriteLease && !hermesLeaseReleased) {
      hermesLeaseReleased = true;
      hermesWriteLease.release();
    }
  };

  try {
    let body: AgentChatBody;
    try {
      const raw = await req.json();
      if (raw && typeof raw === 'object' && 'workSessionId' in raw) {
        return new Response('Work sessions must use the Work API', { status: 400 });
      }
      const parsed = parseAgentChatBody(raw);
      if (!parsed) return new Response('Bad request', { status: 400 });
      body = parsed;
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const messages = (body.messages ?? []) as HermesUIMessage[];

    // Only persist to a conversation that belongs to THIS agent.
    const conversation = body.conversationId
      ? (
          await db.conversation.findFirst({
            where: { id: body.conversationId, agentId },
            select: {
              id: true,
              title: true,
              hermesProfile: true,
              hermesProvider: true,
              hermesModel: true,
              reasoningEffort: true,
              publicApiConversation: { select: { id: true } },
              workSession: { select: { id: true } },
            },
          })
        ) ?? null
      : null;
    const conversationId = conversation?.id ?? null;
    if (body.conversationId && !conversationId) {
      return new Response('Conversation not found', { status: 404 });
    }
    if (conversation?.workSession) {
      return new Response('Work conversations must use the Work API', { status: 400 });
    }
    if (conversation?.publicApiConversation || conversation?.title?.startsWith('msg:')) {
      return new Response('This conversation is read-only in the console', { status: 400 });
    }
    const storedReasoningEffort = normalizeReasoningEffort(conversation?.reasoningEffort) ?? 'default';
    const reasoningEffort = body.reasoningEffort ?? storedReasoningEffort;
    if (conversationId && body.reasoningEffort && body.reasoningEffort !== storedReasoningEffort) {
      const updated = await db.conversation.updateMany({
        where: { id: conversationId, agentId, agent: { workspaceId: agent.workspaceId } },
        data: { reasoningEffort: reasoningEffort === 'default' ? null : reasoningEffort },
      });
      if (updated.count !== 1) return new Response('Conversation not found', { status: 404 });
    }
    const runtimeSession = isHermes && conversationId
      ? await ensureConversationRuntimeSession(agent.workspaceId, agent.id, conversationId)
      : null;

    const last = messages[messages.length - 1];
    if (isHermes) {
      const writeLease = hermesWriteLease!;
      const runtimeSessionId = runtimeSession?.runtimeSessionId ?? randomUUID();
      const runtimeSessionKey = runtimeSession?.runtimeSessionKey
        ?? `agent:${agent.id}:console:${runtimeSessionId}`;
      let executionSettled = false;
      let responseCancelled = false;
      let settleExecution!: (result: { ok: boolean }) => void;
      const executionFinished = new Promise<{ ok: boolean }>((resolve) => {
        settleExecution = resolve;
      });
      const stream = createUIMessageStream<HermesUIMessage>({
        originalMessages: messages,
        execute: async ({ writer }) => {
          try {
            const result = await writeHermesChatStream({
              agent,
              messages,
              conversationId: conversationId ?? runtimeSessionId,
              runtimeSessionId,
              sessionKey: runtimeSessionKey,
              profile: conversation?.hermesProfile,
              provider: conversation?.hermesProvider,
              model: conversation?.hermesModel,
              reasoningEffort,
              writeLease,
              signal: req.signal,
              writer,
            });
            if (conversationId && result.runtimeSessionId !== runtimeSessionId) {
              const updated = await db.conversation.updateMany({
                where: {
                  id: conversationId,
                  agentId,
                  agent: { workspaceId: agent.workspaceId },
                  runtimeSessionId,
                },
                data: { runtimeSessionId: result.runtimeSessionId },
              });
              if (updated.count !== 1) {
                throw new Error('The Hermes conversation session changed during this turn.');
              }
            }
            executionSettled = true;
            settleExecution({ ok: true });
          } catch (error) {
            executionSettled = true;
            settleExecution({ ok: false });
            throw error;
          }
        },
        onError: (error) => error instanceof Error ? error.message : 'Hermes runtime request failed.',
        onFinish: async ({ responseMessage, isAborted }) => {
          try {
            const responseFinishedEarly = !executionSettled;
            const execution = await executionFinished;
            if (
              !execution.ok
              || responseFinishedEarly
              || responseCancelled
              || !conversationId
              || isAborted
              || req.signal.aborted
            ) return;
            if (last?.role === 'user') {
              await appendMessage(conversationId, 'user', last.parts as never);
            }
            const segments = hermesAssistantSegments(responseMessage.parts);
            if (!segments.length) {
              await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
              return;
            }
            await db.$transaction(segments.map((segment) => db.message.create({
              data: {
                conversationId,
                role: 'assistant',
                parts: [{ type: 'text', text: segment.text, state: 'done' }],
              },
            })));
          } finally {
            releaseHermesWriteLease();
          }
        },
      });
      const response = createUIMessageStreamResponse({ stream });
      const reader = response.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          responseCancelled = true;
          await reader.cancel(reason);
        },
      });
      streamOwnsHermesWriteLease = true;
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (!agent.provider || !agent.model) {
      return new Response('This agent has no model configured.', { status: 400 });
    }

    let attachmentIds: string[];
    let hasAttachments: boolean;
    try {
      attachmentIds = last
        ? attachmentIdsFromParts(last.parts as unknown as Array<Record<string, unknown>>)
        : [];
      hasAttachments = messages.some((message) => (
        attachmentIdsFromParts(message.parts as unknown as Array<Record<string, unknown>>).length > 0
      ));
    } catch (error) {
      return error instanceof AttachmentMessageError
        ? new Response(error.message, { status: error.status })
        : new Response('Invalid attachments.', { status: 400 });
    }
    if (hasAttachments && !conversationId) {
      return new Response('Attachments require a saved conversation.', { status: 400 });
    }
    if (attachmentIds.length && last?.role !== 'user') {
      return new Response('Attachments must be sent in the current user message.', { status: 400 });
    }

    let hydratedMessages = messages;
    if (hasAttachments) {
      try {
        await db.$transaction((tx) => claimWorkspaceAttachments(tx, {
          ids: attachmentIds,
          workspaceId: agent.workspaceId,
          uploadedById: user.id,
          scope: { conversationId: conversationId! },
        }));
        hydratedMessages = await hydrateWorkspaceAttachmentMessages(
          messages as unknown as Array<{ role: string; parts: Array<Record<string, unknown>> }>,
          { workspaceId: agent.workspaceId, scope: { conversationId: conversationId! } },
        ) as HermesUIMessage[];
      } catch (error) {
        return error instanceof AttachmentMessageError
          ? new Response(error.message, { status: error.status })
          : new Response('Attachment processing failed.', { status: 502 });
      }
    }

    const resolved = resolveAgentTools(agent);
    const sandboxRuntime = isDedicatedSandboxRuntimeKind(runtimeKind);
    const tools = sandboxRuntime ? null : await buildAgentToolSet(resolved, {
      workspaceId: agent.workspaceId,
      depth: 0,
      visited: new Set([agentId]),
    });
    const system = sandboxRuntime
      ? agent.systemPrompt
      : assembleSystemPrompt(agent.systemPrompt, resolved.skills, Boolean(resolved.knowledgeBases?.length));
    let executionSucceeded = false;
    const stream = createUIMessageStream<HermesUIMessage>({
      originalMessages: messages,
      execute: async ({ writer }) => {
        if (sandboxRuntime) {
          const uiStream = createSandboxUiStreamBridge(writer, `sandbox-${agent.id}`);
          await runDedicatedSandboxTurn({
            agent,
            systemPrompt: system,
            messages: hydratedMessages as never,
            skills: resolved.skills,
            deploymentIds: resolved.deploymentIds,
            signal: req.signal,
            onTextDelta: uiStream.onTextDelta,
            onActivity: uiStream.onActivity,
          });
          uiStream.finish();
          executionSucceeded = true;
          return;
        }
        const uiStream = createNativeUiStreamBridge(writer, `native-${agent.id}`);
        await runNativeAgent({
          provider: agent.provider!,
          modelId: agent.model!,
          systemPrompt: system ?? '',
          messages: uiMessagesToPi(hydratedMessages),
          tools: tools!,
          maxSteps: agent.maxSteps,
          reasoningEffort,
          signal: req.signal,
          onEvent: uiStream.onEvent,
          onToolResult: uiStream.onToolResult,
        });
        uiStream.finish();
        executionSucceeded = true;
      },
      onError: (error) => {
        return error instanceof Error ? error.message : 'Agent request failed.';
      },
      onFinish: async ({ responseMessage, isAborted }) => {
        if (isAborted || req.signal.aborted || !executionSucceeded || !conversationId) return;
        if (last?.role === 'user') {
          await appendMessage(conversationId, 'user', last.parts as never);
        }
        await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
      },
    });
    return createUIMessageStreamResponse({ stream });
  } finally {
    if (!streamOwnsHermesWriteLease) releaseHermesWriteLease();
  }
}
