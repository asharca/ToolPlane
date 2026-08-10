import {
  hasAgentApiScope,
  mintAgentClientToken,
  resolveAgentApiPrincipal,
  type AgentApiScope,
} from '@/lib/agents/public-api/auth';
import { parseAgentClientTokenRequest } from '@/lib/agents/public-api/body';
import { AgentApiError, asAgentApiError, errorResponse, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson, agentApiPreflight } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function OPTIONS(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  return agentApiPreflight(request, endpointId);
}

export async function POST(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId, 'client_tokens:create');
    if (!principal || principal.credentialType !== 'api_key') {
      throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    }
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, endpointId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new AgentApiError('invalid_request', 'Content-Type must be application/json.', 415);
    }
    const parsed = await parseAgentClientTokenRequest(request);
    if (!parsed.ok) {
      throw new AgentApiError(
        parsed.reason === 'too_large' ? 'request_too_large' : 'invalid_request',
        parsed.detail ?? publicErrorMessage(parsed.reason === 'too_large' ? 'request_too_large' : 'invalid_request'),
        parsed.reason === 'too_large' ? 413 : 400,
      );
    }
    const candidateScopes: AgentApiScope[] = [
      'responses:create',
      'responses:read',
      'conversations:read',
      'conversations:delete',
    ];
    const scopes = candidateScopes.filter((scope) => hasAgentApiScope(principal.scopes, scope));
    const minted = await mintAgentClientToken({
      endpointId: principal.endpointId,
      endpointPublicId: principal.endpointPublicId,
      clientId: principal.clientId,
      subject: parsed.value.end_user,
      scopes,
      expiresInSeconds: parsed.value.expires_in,
      origin: parsed.value.origin,
    });
    return agentApiJson({
      token: minted.token,
      token_type: 'Bearer',
      expires_at: minted.expiresAt.toISOString(),
      expires_in: parsed.value.expires_in,
      endpoint_id: principal.endpointPublicId,
    }, { status: 201, headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
