/**
 * The browser's single path for same-origin JSON API calls. Server error text is
 * already safe for display; client-side exceptions never become UI text, they
 * map to fixed codes. Streaming responses and uploads with progress are out of
 * scope and keep their own fetch.
 */
export type ApiFailureCode = string;

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: ApiFailureCode;
      /** Server-provided safe text, or null when the caller must use its own. */
      message: string | null;
    };

export async function apiRequest<T = unknown>(
  input: string,
  { json, headers, ...init }: RequestInit & { json?: unknown } = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    const requestHeaders = new Headers(headers);
    if (json !== undefined && !requestHeaders.has("content-type")) {
      requestHeaders.set("content-type", "application/json");
    }
    response = await fetch(input, {
      ...init,
      credentials: "same-origin",
      headers: requestHeaders,
      body: json === undefined ? init.body : JSON.stringify(json),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: init.signal?.aborted ? "aborted" : "network",
      message: null,
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {
      ok: false,
      status: response.status,
      code: init.signal?.aborted ? "aborted" : "invalid_response",
      message: null,
    };
  }
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok)
        return {
          ok: false,
          status: response.status,
          code: "invalid_response",
          message: null,
        };
    }
  }
  if (response.ok)
    return { ok: true, status: response.status, data: body as T };
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    status: response.status,
    code:
      typeof record.code === "string" ? record.code : `http_${response.status}`,
    message: typeof record.error === "string" ? record.error : null,
  };
}
