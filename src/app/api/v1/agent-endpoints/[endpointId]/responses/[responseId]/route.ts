import { resolveAgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { AgentApiError, asAgentApiError, errorResponse, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { agentApiHeaders, agentApiJson, agentApiPreflight } from '@/lib/agents/public-api/http';
import { createAgentRequestId } from '@/lib/agents/public-api/ids';
import { getAgentResponseForPrincipal } from '@/lib/agents/public-api/runs';
import { takeAgentApiPrincipalRateLimit } from '@/lib/agents/public-api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ endpointId: string; responseId: string }> };

export async function OPTIONS(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  return agentApiPreflight(request, endpointId);
}

export async function GET(request: Request, context: RouteContext) {
  const { endpointId, responseId } = await context.params;
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId, 'responses:read');
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, endpointId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    const response = await getAgentResponseForPrincipal({
      endpointPublicId: endpointId,
      responseId,
      clientId: principal.clientId,
      subjectHash: principal.subjectHash,
    });
    if (!response) throw new AgentApiError('not_found', publicErrorMessage('not_found'), 404);
    return agentApiJson(response, { headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
