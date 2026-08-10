import { resolveAgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { db } from '@/lib/db';
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

export async function GET(request: Request, context: RouteContext) {
  const { endpointId } = await context.params;
  const requestId = createAgentRequestId();
  let headers = new Headers({ 'x-request-id': requestId });
  try {
    const principal = await resolveAgentApiPrincipal(request, endpointId);
    if (!principal) throw new AgentApiError('invalid_api_key', publicErrorMessage('invalid_api_key'), 401);
    const rate = await takeAgentApiPrincipalRateLimit(principal);
    headers = await agentApiHeaders(request, endpointId);
    headers.set('x-request-id', requestId);
    rate.headers.forEach((value, name) => headers.set(name, value));
    const endpoint = await db.agentEndpoint.findFirst({
      where: { id: principal.endpointId, publicId: endpointId, status: 'active' },
      include: {
        currentRevision: { select: { version: true, maxSteps: true } },
        clients: {
          where: { id: principal.clientId, status: 'active' },
          take: 1,
          select: { dailyOutputCharacterLimit: true, maxStoredCharacters: true },
        },
      },
    });
    const client = endpoint?.clients[0];
    if (!endpoint?.currentRevision || !client) {
      throw new AgentApiError('endpoint_disabled', publicErrorMessage('endpoint_disabled'), 403);
    }
    return agentApiJson({
      id: endpoint.publicId,
      object: 'agent.endpoint',
      name: endpoint.name,
      status: endpoint.status,
      revision: endpoint.currentRevision.version,
      isolation_mode: endpoint.isolationMode,
      capabilities: {
        responses: true,
        streaming: true,
        conversations: true,
        cancellation: true,
        client_tokens: principal.scopes.includes('client_tokens:create'),
        openai_chat_completions: true,
        attachments: false,
      },
      limits: {
        requests_per_minute: principal.limits.rpm,
        requests_per_day: principal.limits.dailyRequests,
        output_characters_per_day: Math.min(
          endpoint.dailyOutputCharacterLimit,
          client.dailyOutputCharacterLimit,
        ),
        max_concurrent: principal.limits.maxConcurrent,
        max_persistent_runtimes: endpoint.maxRuntimes,
        max_stored_characters: Math.min(
          endpoint.maxStoredCharacters,
          client.maxStoredCharacters,
        ),
        timeout_seconds: principal.limits.timeoutSeconds,
        max_steps: endpoint.currentRevision.maxSteps,
        retention_days: principal.limits.retentionDays,
      },
    }, { headers });
  } catch (error) {
    return errorResponse(asAgentApiError(error), requestId, headers);
  }
}
