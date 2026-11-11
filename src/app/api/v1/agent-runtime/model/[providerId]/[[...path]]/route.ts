import { NextResponse } from "next/server";
import {
  agentRuntimeTokenFromRequest,
  bindRuntimeLogContext,
  runtimeProviderUrl,
} from "@/lib/agents/runtime-access";
import { enrichLogContext, getLogContext } from "@/lib/observability/context";
import {
  recordEvent,
  errorOutcome,
  type LogOutcome,
} from "@/lib/observability/events";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
} from "@/lib/agents/anthropic-gateway";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const STRIPPED_REQUEST_HEADERS = [
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "transfer-encoding",
  "x-api-key",
  "x-toolplane-runtime-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];

function upstreamRequestHeaders(
  req: Request,
  format: string,
  apiKey: string,
): Headers {
  const headers = new Headers(req.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  // This hop is consumed by Node fetch, not the sandbox client. In particular,
  // Bun advertises zstd, which fetch may pass through undecoded even though our
  // downstream headers remove content-encoding. Keep streamed SSE uncompressed.
  headers.set("accept-encoding", "identity");
  if (apiKey) {
    if (format === "anthropic") {
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version"))
        headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
  }
  return headers;
}

function downstreamResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.set("cache-control", "no-store");
  return headers;
}

async function proxyProviderRequest(
  req: Request,
  { params }: { params: Promise<{ providerId: string; path?: string[] }> },
) {
  const token = await agentRuntimeTokenFromRequest(req);
  if (!token)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { providerId, path = [] } = await params;
  const routePath = path.join("/");
  const grant = await resolveAgentRuntimeGrant(token);
  if (!grant) {
    return NextResponse.json(
      { error: "runtime grant is no longer valid" },
      { status: 403 },
    );
  }
  if (providerId !== token.providerId)
    return NextResponse.json(
      { error: "provider is outside the runtime grant" },
      { status: 403 },
    );

  const provider = await db.modelProvider.findFirst({
    where: { id: providerId, workspaceId: token.workspaceId },
    select: {
      name: true,
      format: true,
      baseUrl: true,
      apiKey: true,
      models: true,
    },
  });
  if (!provider)
    return NextResponse.json({ error: "provider not found" }, { status: 404 });
  bindRuntimeLogContext(token);
  enrichLogContext({ secrets: [provider.apiKey] });

  enrichLogContext({ providerId });
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let model: string | undefined;
  let stream = false;
  if (hasBody && req.body) {
    try {
      // Read only routing metadata; never retain or emit model input/output.
      const input: unknown = await req.clone().json();
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const metadata = input as Record<string, unknown>;
        if (
          typeof metadata.model === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(metadata.model)
        )
          model = metadata.model;
        stream = metadata.stream === true;
      }
    } catch {
      // Invalid/non-JSON input still belongs to the existing upstream validation path.
    }
  }
  const started = performance.now();
  const context = { ...getLogContext() };
  let firstByteMs: number | undefined;
  let recorded = false;
  const finish = (
    httpStatus: number,
    error?: unknown,
    outcome?: LogOutcome,
    errorCode?: string,
  ) => {
    if (recorded) return;
    recorded = true;
    void recordEvent({
      ...context,
      domain: "runtime",
      eventName: "model.request",
      providerId,
      model,
      httpStatus,
      durationMs: Math.round(performance.now() - started),
      error,
      outcome:
        outcome ??
        (error ? errorOutcome(error) : httpStatus >= 400 ? "error" : "success"),
      errorCode:
        errorCode ?? (httpStatus >= 400 ? "PROVIDER_HTTP_ERROR" : undefined),
      attributes: { firstByteMs, stream },
    });
  };
  const observeResponse = (
    upstream: Response,
    headers = upstream.headers,
  ): Response => {
    if (
      req.method === "HEAD" ||
      [204, 205, 304].includes(upstream.status) ||
      !upstream.body
    ) {
      finish(upstream.status);
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (recorded) return;
          if (chunk.done) {
            finish(upstream.status);
            controller.close();
            reader.releaseLock();
          } else {
            firstByteMs ??= performance.now() - started;
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (recorded) return;
          finish(
            upstream.status,
            error,
            errorOutcome(error),
            "PROVIDER_STREAM_FAILED",
          );
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        finish(
          upstream.status,
          reason,
          "cancelled",
          "PROVIDER_REQUEST_CANCELLED",
        );
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
  if (req.method === "POST" && provider.format !== "anthropic") {
    const gatewayProvider = { id: providerId, ...provider };
    if (routePath === "v1/messages") {
      try {
        return observeResponse(
          await handleAnthropicMessages(req, gatewayProvider),
        );
      } catch (error) {
        finish(502, error, errorOutcome(error), "PROVIDER_REQUEST_FAILED");
        throw error;
      }
    }
    if (routePath === "v1/messages/count_tokens")
      return handleAnthropicCountTokens(req);
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = runtimeProviderUrl(
      provider.baseUrl,
      path,
      new URL(req.url).search,
    );
  } catch {
    return NextResponse.json(
      { error: "provider URL is invalid" },
      { status: 502 },
    );
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: upstreamRequestHeaders(req, provider.format, provider.apiKey),
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    signal: req.signal,
    cache: "no-store",
  };
  if (hasBody && req.body) init.duplex = "half";

  try {
    const upstream = await fetch(upstreamUrl, init);
    return observeResponse(upstream, downstreamResponseHeaders(upstream));
  } catch (error) {
    finish(502, error, errorOutcome(error), "PROVIDER_UNREACHABLE");
    return NextResponse.json(
      { error: "provider is unreachable" },
      { status: 502 },
    );
  }
}

const observedProviderRequest = withRequestLogging(
  "/api/v1/agent-runtime/model/[providerId]/[[...path]]",
  proxyProviderRequest,
);
export const GET = observedProviderRequest;
export const HEAD = observedProviderRequest;
export const POST = observedProviderRequest;
export const PUT = observedProviderRequest;
export const PATCH = observedProviderRequest;
export const DELETE = observedProviderRequest;
