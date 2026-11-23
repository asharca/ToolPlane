import { NextResponse } from "next/server";
import { z } from "zod";
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
import { resolveAgentEnvironmentCredentials } from "@/lib/agents/environment-credentials";
import { collectSessionCustomNonProxyPluginSecrets } from "@/lib/plugins/runtime-env";
import {
  AgentSecretObfuscator,
  restoreModelResponse,
} from "@/lib/agents/secret-obfuscation";
import { parseJson } from "@/lib/agents/public-api/body";
import { ANTHROPIC_GATEWAY_MAX_BODY_BYTES } from "@/lib/agents/anthropic-gateway";
import { db } from "@/lib/db";
import { recordAgentModelUsage } from "@/lib/agents/usage";
import { ModelResponseUsage } from "@/lib/agents/model-response-usage";
import { providerSecrets } from "@/lib/agents/provider-credentials";

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
  if (!grant || !token.agentRevisionId) {
    return NextResponse.json(
      { error: "runtime grant is no longer valid" },
      { status: 403 },
    );
  }

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
      // Malformed model requests are denied below without reaching the upstream.
    }
  }
  // Extra providers are accessible only for the exact model pairs on this pin.
  // Never authorize arbitrary endpoints or catalog models with the session token.
  if (
    (hasBody && !model && routePath !== "v1/messages/count_tokens") ||
    (providerId !== token.providerId && !model) ||
    (model && !(await resolveAgentRuntimeGrant(token, { providerId, model })))
  )
    return NextResponse.json(
      { error: "model is outside the runtime grant" },
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
  enrichLogContext({ secrets: providerSecrets(provider.apiKey) });

  enrichLogContext({ providerId });
  let secrets: AgentSecretObfuscator | undefined;
  if (grant.secretObfuscation) {
    try {
      const [envCredentials, customPluginSecrets] = await Promise.all([
        resolveAgentEnvironmentCredentials({
          workspaceId: token.workspaceId,
          agentId: token.agentId,
          agentRevisionId: token.agentRevisionId,
          conversationId: token.conversationId,
          contextId: token.a2aContextId,
        }),
        collectSessionCustomNonProxyPluginSecrets({
          workspaceId: token.workspaceId,
          agentId: token.agentId,
          agentRevisionId: token.agentRevisionId,
        }),
      ]);
      secrets = new AgentSecretObfuscator({
        ...customPluginSecrets,
        ...envCredentials,
      });
    } catch {
      return NextResponse.json(
        { error: "runtime credentials are no longer valid" },
        { status: 403 },
      );
    }
    if (hasBody && req.body) {
      const parsed = await parseJson(
        req,
        z.unknown(),
        ANTHROPIC_GATEWAY_MAX_BODY_BYTES,
      );
      if (!parsed.ok) {
        return NextResponse.json(
          {
            error:
              parsed.reason === "too_large"
                ? "request body is too large"
                : "invalid JSON request body",
          },
          { status: parsed.reason === "too_large" ? 413 : 400 },
        );
      }
      const headers = new Headers(req.headers);
      headers.delete("content-length");
      req = new Request(req.url, {
        method: req.method,
        headers,
        body: JSON.stringify(
          secrets.redactRequest(
            parsed.value,
            provider.format === "anthropic" ||
              /^v1\/messages(?:\/count_tokens)?$/.test(routePath)
              ? "anthropic"
              : provider.format === "openai-responses" ||
                  /(?:^|\/)responses$/.test(routePath)
                ? "openai-responses"
                : "openai",
          ),
        ),
        signal: req.signal,
      });
    }
    if (model) model = secrets.redact(model);
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
    const usageObserver = new ModelResponseUsage(
      upstream.headers.get("content-type")?.includes("text/event-stream") ??
        false,
    );
    let usageRecorded = false;
    const meterUsage = async () => {
      if (usageRecorded) return;
      usageRecorded = true;
      const usage = usageObserver.finish();
      if (
        !usage ||
        !upstream.ok ||
        !model ||
        req.method !== "POST" ||
        ![
          "v1/messages",
          "v1/chat/completions",
          "v1/responses",
          "chat/completions",
          "responses",
        ].includes(routePath)
      )
        return;
      try {
        await recordAgentModelUsage(token, { usage, model, providerId });
      } catch (error) {
        // Accounting is best-effort here; terminal SDK accounting reconciles it.
        // A billing/notification failure must never break the provider stream.
        await recordEvent({
          ...context,
          domain: "agent",
          eventName: "agent.usage.observe_failed",
          level: "warn",
          error,
        });
      }
    };
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (recorded) return;
          if (chunk.done) {
            await meterUsage();
            finish(upstream.status);
            controller.close();
            reader.releaseLock();
          } else {
            firstByteMs ??= performance.now() - started;
            usageObserver.push(chunk.value);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (recorded) return;
          await meterUsage();
          finish(
            upstream.status,
            secrets ? new Error("Model stream failed.") : error,
            secrets ? "error" : errorOutcome(error),
            "PROVIDER_STREAM_FAILED",
          );
          controller.error(secrets ? new Error("Model stream failed.") : error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        finish(
          upstream.status,
          secrets ? new Error("Model request cancelled.") : reason,
          "cancelled",
          "PROVIDER_REQUEST_CANCELLED",
        );
        try {
          await reader.cancel(reason);
        } finally {
          await meterUsage();
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
          await handleAnthropicMessages(req, gatewayProvider, secrets).then(
            (response) =>
              secrets ? restoreModelResponse(response, secrets) : response,
          ),
        );
      } catch (error) {
        const safeError = secrets ? new Error("Model request failed.") : error;
        finish(
          502,
          safeError,
          errorOutcome(safeError),
          "PROVIDER_REQUEST_FAILED",
        );
        throw safeError;
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
    const response = secrets
      ? restoreModelResponse(upstream, secrets)
      : upstream;
    return observeResponse(response, downstreamResponseHeaders(response));
  } catch (error) {
    const safeError = secrets
      ? new Error("Model provider is unreachable.")
      : error;
    finish(502, safeError, errorOutcome(safeError), "PROVIDER_UNREACHABLE");
    return NextResponse.json(
      { error: "provider is unreachable" },
      { status: 502 },
    );
  }
}

const observedProviderRequest = withRequestLogging(
  "/api/v1/agent-runtime/model/[providerId]/[[...path]]",
  async (req, context: Parameters<typeof proxyProviderRequest>[1]) => {
    try {
      return await proxyProviderRequest(req, context);
    } catch {
      // Unexpected control-plane failures must not masquerade as provider HTTP
      // errors, and their original exceptions can contain credential material.
      void recordEvent({
        domain: "runtime",
        eventName: "model.gateway_failed",
        errorCode: "MODEL_GATEWAY_FAILED",
        httpStatus: 500,
        outcome: "error",
      });
      return NextResponse.json(
        {
          error: {
            type: "api_error",
            code: "TOOLPLANE_MODEL_GATEWAY_FAILED",
            message: "TOOLPLANE_MODEL_GATEWAY_FAILED",
          },
        },
        { status: 500 },
      );
    }
  },
);
export const GET = observedProviderRequest;
export const HEAD = observedProviderRequest;
export const POST = observedProviderRequest;
export const PUT = observedProviderRequest;
export const PATCH = observedProviderRequest;
export const DELETE = observedProviderRequest;
