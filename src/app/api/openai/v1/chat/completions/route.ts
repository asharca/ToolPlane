import { resolveAgentApiPrincipalForAnyEndpoint } from '@/lib/agents/public-api/auth';
import { openAIInput, parseOpenAIChatRequest } from '@/lib/agents/public-api/body';
import {
  AgentApiError,
  agentApiErrorFromStoredCode,
  asAgentApiError,
  errorResponse,
  publicErrorMessage,
} from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson, mergeHeaders } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import {
  executePreparedAgentResponse,
  getAgentResponseForPrincipal,
  prepareAgentResponse,
} from '@/lib/agents/public-api/runs';
import { encodeSseDone, encodeSseHeartbeat } from '@/lib/agents/public-api/sse';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

const encoder = new TextEncoder();

function chatId(responseId: string): string {
  return `chatcmpl_${responseId.replace(/^resp_/, '')}`;
}

function chunk(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function openAiCompletion(view: Awaited<ReturnType<typeof getAgentResponseForPrincipal>>, model: string) {
  if (!view) return null;
  return {
    id: chatId(view.id),
    object: 'chat.completion',
    created: view.created_at,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: view.output_text },
      finish_reason: view.status === 'completed' ? 'stop' : null,
    }],
    toolplane_response_id: view.id,
    toolplane_conversation_id: view.conversation_id,
    request_id: view.request_id,
  };
}

export async function OPTIONS() {
  // This endpoint has no Endpoint id in its path, so an unauthenticated browser
  // preflight cannot be checked against an Endpoint origin allowlist. Browser
  // clients use the native, endpoint-scoped Responses API instead.
  return new Response(null, { status: 403, headers: { 'cache-control': 'private, no-store' } });
}

export async function POST(request: Request) {
  const provisionalRequestId = createAgentRequestId();
  let requestId = provisionalRequestId;
  let headers = new Headers({ 'x-request-id': provisionalRequestId });
  try {
    const principal = await resolveAgentApiPrincipalForAnyEndpoint(request, 'responses:create');
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = mergeHeaders(
      await agentApiHeaders(request, principal.endpointPublicId),
      rate.headers,
      headers,
    );
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new AgentApiError('invalid_request', 'Content-Type must be application/json.', 415);
    }
    const parsed = await parseOpenAIChatRequest(request);
    if (!parsed.ok) {
      throw new AgentApiError(
        parsed.reason === 'too_large' ? 'request_too_large' : 'invalid_request',
        parsed.detail ?? publicErrorMessage(parsed.reason === 'too_large' ? 'request_too_large' : 'invalid_request'),
        parsed.reason === 'too_large' ? 413 : 400,
      );
    }
    const endpointId = parsed.value.model;
    if (endpointId !== principal.endpointPublicId) {
      throw new AgentApiError('invalid_request', 'model must match the endpoint bound to this credential.', 400);
    }
    const prepared = await prepareAgentResponse({
      principal,
      input: openAIInput(parsed.value),
      endUser: parsed.value.user,
      conversationId: parsed.value.conversation_id,
      stream: parsed.value.stream,
      metadata: parsed.value.metadata,
      idempotencyKey: request.headers.get('idempotency-key'),
      signal: request.signal,
      rateLimit: rate,
    });
    requestId = prepared.requestId;
    headers = mergeHeaders(headers, prepared.rateLimitHeaders, {
      'x-request-id': prepared.requestId,
      'x-toolplane-conversation-id': prepared.publicConversationId,
      'x-toolplane-response-id': prepared.responseId,
    });

    if (prepared.replay) {
      const view = await getAgentResponseForPrincipal({
        endpointPublicId: endpointId,
        responseId: prepared.responseId,
        clientId: principal.clientId,
        subjectHash: principal.subjectHash,
      });
      if (!view) throw new AgentApiError('not_found', publicErrorMessage('not_found'), 404);
      if (view.status !== 'completed') {
        throw view.status === 'provisioning' || view.status === 'running'
          ? new AgentApiError('idempotency_conflict', 'The original response is still in progress.', 409, 1)
          : agentApiErrorFromStoredCode(view.error?.code, view.error?.message);
      }
      if (!parsed.value.stream) return agentApiJson(openAiCompletion(view, endpointId), { headers });
      const replayStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const id = chatId(view.id);
          controller.enqueue(chunk({
            id, object: 'chat.completion.chunk', created: view.created_at, model: endpointId,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }));
          if (view.output_text) controller.enqueue(chunk({
            id, object: 'chat.completion.chunk', created: view.created_at, model: endpointId,
            choices: [{ index: 0, delta: { content: view.output_text }, finish_reason: null }],
          }));
          controller.enqueue(chunk({
            id, object: 'chat.completion.chunk', created: view.created_at, model: endpointId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }));
          controller.enqueue(encodeSseDone());
          controller.close();
        },
      });
      return new Response(replayStream, { headers: mergeHeaders(headers, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store, no-cache',
        'x-accel-buffering': 'no',
      }) });
    }

    if (!parsed.value.stream) {
      const view = await executePreparedAgentResponse(prepared, { signal: request.signal });
      return agentApiJson(openAiCompletion(view, endpointId), { headers });
    }

    const responseController = new AbortController();
    const signal = AbortSignal.any([request.signal, responseController.signal]);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const id = chatId(prepared.responseId);
        const created = Math.floor(Date.now() / 1_000);
        const enqueue = (value: Uint8Array) => {
          try { controller.enqueue(value); } catch { responseController.abort(); }
        };
        enqueue(chunk({
          id, object: 'chat.completion.chunk', created, model: endpointId,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }));
        heartbeat = setInterval(() => enqueue(encodeSseHeartbeat()), 15_000);
        try {
          await executePreparedAgentResponse(prepared, {
            signal,
            onDelta(delta) {
              enqueue(chunk({
                id, object: 'chat.completion.chunk', created, model: endpointId,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              }));
            },
          });
          enqueue(chunk({
            id, object: 'chat.completion.chunk', created, model: endpointId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }));
        } catch (error) {
          const mapped = asAgentApiError(error);
          enqueue(chunk({ error: { message: mapped.message, type: 'server_error', code: mapped.code } }));
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          enqueue(encodeSseDone());
          try { controller.close(); } catch { /* client disconnected */ }
        }
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        responseController.abort(new DOMException('Client disconnected.', 'AbortError'));
      },
    });
    return new Response(stream, { headers: mergeHeaders(headers, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-cache',
      'x-accel-buffering': 'no',
    }) });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
