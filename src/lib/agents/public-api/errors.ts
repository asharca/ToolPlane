export type AgentApiErrorCode =
  | 'invalid_api_key'
  | 'endpoint_disabled'
  | 'invalid_request'
  | 'request_too_large'
  | 'response_too_large'
  | 'conversation_not_found'
  | 'conversation_busy'
  | 'idempotency_conflict'
  | 'rate_limit_exceeded'
  | 'resource_limit_exceeded'
  | 'concurrency_limit_exceeded'
  | 'runtime_maintenance'
  | 'runtime_unavailable'
  | 'upstream_error'
  | 'request_timeout'
  | 'cancelled'
  | 'not_found'
  | 'internal_error';

export class AgentApiError extends Error {
  constructor(
    public readonly code: AgentApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export function publicErrorMessage(code: AgentApiErrorCode): string {
  switch (code) {
    case 'invalid_api_key': return 'The API key is invalid or cannot access this endpoint.';
    case 'endpoint_disabled': return 'This Agent endpoint is disabled.';
    case 'invalid_request': return 'The request body is invalid.';
    case 'request_too_large': return 'The request body is too large.';
    case 'response_too_large': return 'The Agent response exceeded the output limit.';
    case 'conversation_not_found': return 'The conversation was not found.';
    case 'conversation_busy': return 'The conversation already has an active response.';
    case 'idempotency_conflict': return 'The idempotency key was already used with a different request.';
    case 'rate_limit_exceeded': return 'The request rate limit was exceeded.';
    case 'resource_limit_exceeded': return 'The Agent endpoint resource limit was exceeded.';
    case 'concurrency_limit_exceeded': return 'The concurrent response limit was exceeded.';
    case 'runtime_maintenance': return 'The Agent runtime is temporarily under maintenance.';
    case 'runtime_unavailable': return 'The Agent runtime is temporarily unavailable.';
    case 'upstream_error': return 'The Agent could not complete this response.';
    case 'request_timeout': return 'The Agent response timed out.';
    case 'cancelled': return 'The Agent response was cancelled.';
    case 'not_found': return 'The requested resource was not found.';
    default: return 'The Agent API request failed.';
  }
}

const AGENT_API_ERROR_CODES = new Set<AgentApiErrorCode>([
  'invalid_api_key',
  'endpoint_disabled',
  'invalid_request',
  'request_too_large',
  'response_too_large',
  'conversation_not_found',
  'conversation_busy',
  'idempotency_conflict',
  'rate_limit_exceeded',
  'resource_limit_exceeded',
  'concurrency_limit_exceeded',
  'runtime_maintenance',
  'runtime_unavailable',
  'upstream_error',
  'request_timeout',
  'cancelled',
  'not_found',
  'internal_error',
]);

/** Restore only stable, public error codes persisted on a durable AgentRun. */
export function agentApiErrorFromStoredCode(
  code: string | null | undefined,
  message?: string | null,
): AgentApiError {
  const resolved = AGENT_API_ERROR_CODES.has(code as AgentApiErrorCode)
    ? code as AgentApiErrorCode
    : 'upstream_error';
  return new AgentApiError(
    resolved,
    message?.trim() || publicErrorMessage(resolved),
    statusForCode(resolved),
  );
}

export function errorResponse(
  error: AgentApiError | AgentApiErrorCode,
  requestId?: string,
  headers?: HeadersInit,
): Response {
  const resolved = typeof error === 'string'
    ? new AgentApiError(error, publicErrorMessage(error), statusForCode(error))
    : error;
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  if (requestId) responseHeaders.set('x-request-id', requestId);
  if (resolved.retryAfter) responseHeaders.set('retry-after', String(resolved.retryAfter));
  return new Response(JSON.stringify({
    error: {
      message: resolved.message || publicErrorMessage(resolved.code),
      type: resolved.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: resolved.code,
      ...(requestId ? { request_id: requestId } : {}),
    },
  }), { status: resolved.status, headers: responseHeaders });
}

function statusForCode(code: AgentApiErrorCode): number {
  if (code === 'invalid_api_key') return 401;
  if (code === 'endpoint_disabled') return 403;
  if (code === 'request_too_large') return 413;
  if (code === 'response_too_large') return 502;
  if (code === 'conversation_not_found' || code === 'not_found') return 404;
  if (code === 'conversation_busy' || code === 'idempotency_conflict') return 409;
  if (
    code === 'rate_limit_exceeded'
    || code === 'resource_limit_exceeded'
    || code === 'concurrency_limit_exceeded'
  ) return 429;
  if (code === 'runtime_maintenance' || code === 'runtime_unavailable') return 503;
  if (code === 'upstream_error') return 502;
  if (code === 'request_timeout') return 504;
  if (code === 'cancelled') return 409;
  if (code === 'internal_error') return 500;
  return 400;
}

export function asAgentApiError(error: unknown): AgentApiError {
  if (error instanceof AgentApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AgentApiError('cancelled', publicErrorMessage('cancelled'), 409);
  }
  return new AgentApiError('internal_error', publicErrorMessage('internal_error'), 500);
}
