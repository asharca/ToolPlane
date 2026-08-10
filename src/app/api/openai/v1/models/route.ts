import { resolveAgentApiPrincipalForAnyEndpoint } from '@/lib/agents/public-api/auth';
import { AgentApiError, asAgentApiError, errorResponse, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return new Response(null, { status: 403, headers: { 'cache-control': 'private, no-store' } });
}

export async function GET(request: Request) {
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipalForAnyEndpoint(request, 'responses:create');
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, principal.endpointPublicId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    return agentApiJson({
      object: 'list',
      data: [{
        id: principal.endpointPublicId,
        object: 'model',
        created: Math.floor(Date.now() / 1_000),
        owned_by: 'toolplane',
      }],
    }, { headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
