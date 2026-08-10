import { resolveAgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { parseAgentResponseRequest } from '@/lib/agents/public-api/body';
import {
  AgentApiError,
  agentApiErrorFromStoredCode,
  asAgentApiError,
  errorResponse,
  publicErrorMessage,
} from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson, agentApiPreflight, mergeHeaders } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import {
  executePreparedAgentResponse,
  getAgentResponseForPrincipal,
  prepareAgentResponse,
} from '@/lib/agents/public-api/runs';
import {
  AGENT_API_SSE_HEADERS,
  encodeSseDone,
  encodeSseEvent,
  encodeSseHeartbeat,
} from '@/lib/agents/public-api/sse';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function OPTIONS(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  return agentApiPreflight(request, endpointId);
}

export async function POST(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  const provisionalRequestId = createAgentRequestId();
  let requestId = provisionalRequestId;
  let headers = new Headers({ 'x-request-id': provisionalRequestId });

  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId, 'responses:create');
    if (!principal) {
      throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    }
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = mergeHeaders(
      await agentApiHeaders(request, endpointId),
      rate.headers,
      headers,
    );
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new AgentApiError('invalid_request', 'Content-Type must be application/json.', 415);
    }

    const parsed = await parseAgentResponseRequest(request);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') {
        throw new AgentApiError('request_too_large', publicErrorMessage('request_too_large'), 413);
      }
      throw new AgentApiError(
        'invalid_request',
        parsed.detail ? `Invalid request: ${parsed.detail}` : publicErrorMessage('invalid_request'),
        400,
      );
    }

    const prepared = await prepareAgentResponse({
      principal,
      input: parsed.value.input,
      endUser: parsed.value.end_user,
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
      const replay = await getAgentResponseForPrincipal({
        endpointPublicId: endpointId,
        responseId: prepared.responseId,
        clientId: principal.clientId,
        subjectHash: principal.subjectHash,
      });
      if (!replay) throw new AgentApiError('not_found', publicErrorMessage('not_found'), 404);
      if (replay.status !== 'completed') {
        throw replay.status === 'provisioning' || replay.status === 'running'
          ? new AgentApiError('idempotency_conflict', 'The original response is still in progress.', 409, 1)
          : agentApiErrorFromStoredCode(replay.error?.code, replay.error?.message);
      }
      if (!parsed.value.stream) return agentApiJson(replay, { headers });
      const replayStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let eventId = 1;
          controller.enqueue(encodeSseEvent('response.created', {
            response_id: replay.id,
            request_id: replay.request_id,
            conversation_id: replay.conversation_id,
            endpoint_id: replay.endpoint_id,
            endpoint_revision: replay.endpoint_revision,
          }, eventId++));
          if (replay.output_text) {
            controller.enqueue(encodeSseEvent('response.output_text.delta', {
              response_id: replay.id,
              delta: replay.output_text,
            }, eventId++));
          }
          controller.enqueue(encodeSseEvent('response.completed', { response: replay }, eventId));
          controller.enqueue(encodeSseDone());
          controller.close();
        },
      });
      return new Response(replayStream, { headers: mergeHeaders(AGENT_API_SSE_HEADERS, headers) });
    }

    if (!parsed.value.stream) {
      const response = await executePreparedAgentResponse(prepared, { signal: request.signal });
      return agentApiJson(response, { headers });
    }

    const responseController = new AbortController();
    const executionSignal = AbortSignal.any([request.signal, responseController.signal]);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let eventId = 1;
        const enqueue = (chunk: Uint8Array) => {
          try { controller.enqueue(chunk); } catch { responseController.abort(); }
        };
        enqueue(encodeSseEvent('response.created', {
          response_id: prepared.responseId,
          request_id: prepared.requestId,
          conversation_id: prepared.publicConversationId,
          endpoint_id: prepared.endpointPublicId,
          endpoint_revision: prepared.endpointRevision,
        }, eventId++));
        heartbeat = setInterval(() => enqueue(encodeSseHeartbeat()), 15_000);
        try {
          const response = await executePreparedAgentResponse(prepared, {
            signal: executionSignal,
            onDelta(delta) {
              enqueue(encodeSseEvent('response.output_text.delta', {
                response_id: prepared.responseId,
                delta,
              }, eventId++));
            },
          });
          enqueue(encodeSseEvent('response.completed', { response }, eventId++));
        } catch (error) {
          const mapped = asAgentApiError(error);
          enqueue(encodeSseEvent('response.failed', {
            response_id: prepared.responseId,
            error: { code: mapped.code, message: mapped.message },
          }, eventId++));
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          enqueue(encodeSseDone());
          try { controller.close(); } catch { /* the client already disconnected */ }
        }
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        responseController.abort(new DOMException('Client disconnected.', 'AbortError'));
      },
    });
    return new Response(stream, { headers: mergeHeaders(AGENT_API_SSE_HEADERS, headers) });
  } catch (error) {
    const mapped = asAgentApiError(error);
    return errorResponse(mapped, requestId, headers);
  }
}
