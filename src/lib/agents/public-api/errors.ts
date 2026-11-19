import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

const agentApiFailures = defineFailures({
  invalid_api_key: "The API key is invalid or cannot access this endpoint.",
  endpoint_disabled: "This Agent endpoint is disabled.",
  invalid_request: "The request body is invalid.",
  request_too_large: "The request body is too large.",
  response_too_large: "The Agent response exceeded the output limit.",
  conversation_not_found: "The conversation was not found.",
  conversation_busy: "The conversation already has an active response.",
  idempotency_conflict:
    "The idempotency key was already used with a different request.",
  rate_limit_exceeded: "The request rate limit was exceeded.",
  resource_limit_exceeded: "The Agent endpoint resource limit was exceeded.",
  concurrency_limit_exceeded: "The concurrent response limit was exceeded.",
  runtime_maintenance: "The Agent runtime is temporarily under maintenance.",
  runtime_unavailable: "The Agent runtime is temporarily unavailable.",
  runtime_unsupported:
    "This Agent runtime does not support public endpoint execution.",
  upstream_error: "The Agent could not complete this response.",
  request_timeout: "The Agent response timed out.",
  cancelled: "The Agent response was cancelled.",
  not_found: "The requested resource was not found.",
  internal_error: "The Agent API request failed.",
});
export type AgentApiErrorCode = FailureCodeOf<typeof agentApiFailures>;

const retiredAgentApiFailures = defineFailures({
  AGENT_EXECUTION_RETIRED:
    "The legacy Agent execution API has been retired. Retained history is read-only. Create a newly authorized Pi Agent and use its session routes.",
});

export class AgentApiError extends Error {
  constructor(
    public readonly code: AgentApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export function publicErrorMessage(code: AgentApiErrorCode): string {
  return agentApiFailures.text(code);
}

/** Restore only stable, public error codes persisted on a durable AgentRun. */
export function agentApiErrorFromStoredCode(
  code: string | null | undefined,
): AgentApiError {
  const resolved = agentApiFailures.is(code) ? code : "upstream_error";
  return new AgentApiError(
    resolved,
    publicErrorMessage(resolved),
    statusForCode(resolved),
  );
}

export function errorResponse(
  error: AgentApiError | AgentApiErrorCode,
  requestId?: string,
  headers?: HeadersInit,
): Response {
  const resolved =
    typeof error === "string"
      ? new AgentApiError(
          error,
          publicErrorMessage(error),
          statusForCode(error),
        )
      : error;
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "private, no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  if (requestId) responseHeaders.set("x-request-id", requestId);
  if (resolved.retryAfter)
    responseHeaders.set("retry-after", String(resolved.retryAfter));
  return new Response(
    JSON.stringify({
      error: {
        message:
          resolved.status === 410 && resolved.code === "runtime_unavailable"
            ? retiredAgentApiFailures.text("AGENT_EXECUTION_RETIRED")
            : publicErrorMessage(resolved.code),
        type: resolved.status >= 500 ? "server_error" : "invalid_request_error",
        code: resolved.code,
        ...(requestId ? { request_id: requestId } : {}),
      },
    }),
    { status: resolved.status, headers: responseHeaders },
  );
}

function statusForCode(code: AgentApiErrorCode): number {
  if (code === "invalid_api_key") return 401;
  if (code === "endpoint_disabled") return 403;
  if (code === "request_too_large") return 413;
  if (code === "response_too_large") return 502;
  if (code === "runtime_unsupported") return 409;
  if (code === "conversation_not_found" || code === "not_found") return 404;
  if (code === "conversation_busy" || code === "idempotency_conflict")
    return 409;
  if (
    code === "rate_limit_exceeded" ||
    code === "resource_limit_exceeded" ||
    code === "concurrency_limit_exceeded"
  )
    return 429;
  if (code === "runtime_maintenance" || code === "runtime_unavailable")
    return 503;
  if (code === "upstream_error") return 502;
  if (code === "request_timeout") return 504;
  if (code === "cancelled") return 409;
  if (code === "internal_error") return 500;
  return 400;
}

export function asAgentApiError(error: unknown): AgentApiError {
  if (error instanceof AgentApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AgentApiError("cancelled", publicErrorMessage("cancelled"), 409);
  }
  return new AgentApiError(
    "internal_error",
    publicErrorMessage("internal_error"),
    500,
  );
}
