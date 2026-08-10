import { resolveAgentApiPrincipal } from '@/lib/agents/public-api/auth';
import {
  deleteAgentConversationForPrincipal,
  getAgentConversationForPrincipal,
} from '@/lib/agents/public-api/conversations';
import { AgentApiError, asAgentApiError, errorResponse, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson, agentApiPreflight } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ endpointId: string; conversationId: string }> };

export async function OPTIONS(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  return agentApiPreflight(request, endpointId);
}

export async function GET(request: Request, context: RouteContext) {
  const { endpointId, conversationId } = await context.params;
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId, 'conversations:read');
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, endpointId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    const url = new URL(request.url);
    const limitValue = url.searchParams.get('limit');
    const limit = limitValue == null ? undefined : Number(limitValue);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new AgentApiError('invalid_request', 'limit must be an integer from 1 to 100.', 400);
    }
    const conversation = await getAgentConversationForPrincipal(principal, conversationId, {
      limit,
      after: url.searchParams.get('after'),
    });
    if (!conversation) {
      throw new AgentApiError('conversation_not_found', publicErrorMessage('conversation_not_found'), 404);
    }
    return agentApiJson(conversation, { headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { endpointId, conversationId } = await context.params;
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId, 'conversations:delete');
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, endpointId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    const deleted = await deleteAgentConversationForPrincipal(principal, conversationId, request.signal);
    if (!deleted) {
      throw new AgentApiError('conversation_not_found', publicErrorMessage('conversation_not_found'), 404);
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
