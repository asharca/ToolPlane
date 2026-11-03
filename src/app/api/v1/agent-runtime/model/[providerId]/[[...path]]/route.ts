import { NextResponse } from "next/server";
import {
  agentRuntimeTokenFromRequest,
  bindRuntimeLogContext,
  runtimeProviderUrl,
} from "@/lib/agents/runtime-access";
import { enrichLogContext } from "@/lib/observability/context";
import { recordEvent } from "@/lib/observability/events";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
} from "@/lib/agents/anthropic-gateway";
import { db } from "@/lib/db";
import { agentRuntimeSupportsProviderFormat } from "@/lib/agents/runtime-kind";

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

const OMP_MODEL_ENDPOINTS: Record<string, true> = {
  "v1/messages": true,
  "v1/messages/count_tokens": true,
  "v1/chat/completions": true,
  "chat/completions": true,
  "v1/responses": true,
  responses: true,
};

async function proxyProviderRequest(
  req: Request,
  { params }: { params: Promise<{ providerId: string; path?: string[] }> },
) {
  const token = await agentRuntimeTokenFromRequest(req);
  if (!token)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { providerId, path = [] } = await params;
  const routePath = path.join("/");
  let requestedModel: string | undefined;
  if (req.method === "POST" && Object.hasOwn(OMP_MODEL_ENDPOINTS, routePath)) {
    try {
      const body: unknown = await req.clone().json();
      if (
        body &&
        typeof body === "object" &&
        "model" in body &&
        typeof body.model === "string"
      )
        requestedModel = body.model;
    } catch {
      return NextResponse.json(
        { error: "invalid model request" },
        { status: 400 },
      );
    }
  }
  const grant = await resolveAgentRuntimeGrant(
    token,
    requestedModel === undefined
      ? undefined
      : { providerId, model: requestedModel },
  );
  if (!grant) {
    return NextResponse.json(
      { error: "runtime grant is no longer valid" },
      { status: 403 },
    );
  }
  if (
    providerId !== token.providerId &&
    (grant.runtimeKind !== "omp" || requestedModel === undefined)
  )
    return NextResponse.json(
      { error: "provider is outside the runtime grant" },
      { status: 403 },
    );

  if (grant.runtimeKind === "omp") {
    // Auxiliary and child models must be pinned and remain authorized live.
    if (req.method !== "POST" || !Object.hasOwn(OMP_MODEL_ENDPOINTS, routePath))
      return NextResponse.json(
        { error: "model endpoint is outside the runtime grant" },
        { status: 403 },
      );
    if (requestedModel === undefined || requestedModel !== grant.model)
      return NextResponse.json(
        { error: "model is outside the runtime grant" },
        { status: 403 },
      );
  }
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
  if (
    grant.runtimeKind === "omp" &&
    (!requestedModel ||
      !provider.models.includes(requestedModel) ||
      !agentRuntimeSupportsProviderFormat("omp", provider.format))
  )
    return NextResponse.json(
      { error: "model is no longer authorized" },
      { status: 403 },
    );
  bindRuntimeLogContext(token);
  enrichLogContext({ secrets: [provider.apiKey] });

  enrichLogContext({ providerId });
  if (req.method === "POST" && provider.format !== "anthropic") {
    const gatewayProvider = { id: providerId, ...provider };
    if (routePath === "v1/messages")
      return handleAnthropicMessages(req, gatewayProvider);
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

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
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
    const body =
      req.method === "HEAD" || [204, 205, 304].includes(upstream.status)
        ? null
        : upstream.body;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: downstreamResponseHeaders(upstream),
    });
  } catch (error) {
    await recordEvent({
      domain: "agent",
      eventName: "provider.request.failed",
      error,
      httpStatus: 502,
    });
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
