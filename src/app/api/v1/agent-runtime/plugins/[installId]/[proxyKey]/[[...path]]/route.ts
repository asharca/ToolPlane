import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { enrichLogContext } from "@/lib/observability/context";
import { errorOutcome, recordEvent } from "@/lib/observability/events";
import { withRequestLogging } from "@/lib/observability/http";
import { redactText } from "@/lib/observability/redaction";
import {
  type AgentPluginProxyTokenPayload,
  runtimePluginUpstreamUrl,
  verifyAgentPluginProxyToken,
} from "@/lib/agents/runtime-access";
import { resolveAgentPluginProxyGrant } from "@/lib/agents/runtime-grant";
import { resolveCustomPluginUpstreamAddress } from "@/lib/plugins/runtime-env";
import { permitsTransportProtocol } from "@/lib/transport-policy";

export const runtime = "nodejs";

const JWT_TOKEN_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SCAN_HEADERS = 32;
const MAX_SCAN_PARAMS = 32;
const MAX_ERROR_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;

const PRIORITY_TOKEN_HEADERS = new Set([
  "x-toolplane-runtime-token",
  "authorization",
  "x-api-key",
]);

const SKIP_SCAN_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "origin",
  "pragma",
  "referer",
  "user-agent",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-toolplane-runtime-token",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function jsonError(status: number, code: string, error: string): NextResponse {
  return NextResponse.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

type ExtractedToken = {
  payload: AgentPluginProxyTokenPayload;
  rawToken: string;
  carrierHeader?: string;
  carrierQueryParam?: string;
};

async function extractPluginProxyToken(
  req: Request,
  incomingUrl: URL,
): Promise<ExtractedToken | null> {
  const candidates: Array<{
    candidate: string;
    carrierHeader?: string;
    carrierQueryParam?: string;
  }> = [];

  const runtimeHeader = req.headers.get("x-toolplane-runtime-token")?.trim();
  if (runtimeHeader) {
    candidates.push({
      candidate: runtimeHeader,
      carrierHeader: "x-toolplane-runtime-token",
    });
  }

  const authHeader = req.headers.get("authorization")?.trim();
  if (authHeader) {
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(authHeader)?.[1];
    candidates.push({
      candidate: bearer ?? authHeader,
      carrierHeader: "authorization",
    });
  }

  const apiKeyHeader = req.headers.get("x-api-key")?.trim();
  if (apiKeyHeader) {
    candidates.push({
      candidate: apiKeyHeader,
      carrierHeader: "x-api-key",
    });
  }

  let scannedHeaders = 0;
  for (const [rawName, rawValue] of req.headers.entries()) {
    const name = rawName.toLowerCase();
    if (PRIORITY_TOKEN_HEADERS.has(name) || SKIP_SCAN_HEADERS.has(name)) {
      continue;
    }
    if (++scannedHeaders > MAX_SCAN_HEADERS) break;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    const lastSegment = trimmed.split(/\s+/).at(-1) ?? "";
    if (JWT_TOKEN_REGEX.test(lastSegment)) {
      candidates.push({ candidate: lastSegment, carrierHeader: name });
    }
  }

  let scannedParams = 0;
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (++scannedParams > MAX_SCAN_PARAMS) break;
    const trimmed = value.trim();
    if (JWT_TOKEN_REGEX.test(trimmed)) {
      candidates.push({ candidate: trimmed, carrierQueryParam: key });
    }
  }

  for (const entry of candidates) {
    if (!JWT_TOKEN_REGEX.test(entry.candidate)) continue;
    const payload = await verifyAgentPluginProxyToken(entry.candidate);
    if (payload) {
      return {
        payload,
        rawToken: entry.candidate,
        carrierHeader: entry.carrierHeader,
        carrierQueryParam: entry.carrierQueryParam,
      };
    }
  }
  return null;
}

function isRedactedTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml")
  );
}

async function readBoundedText(
  stream: Readable,
  limitBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > limitBytes) {
      const remaining = Math.max(0, limitBytes - total);
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { text: truncated ? `${text}...` : text, truncated };
}

async function proxyPluginRequest(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ installId: string; proxyKey: string; path?: string[] }>;
  },
) {
  if (req.headers.has("origin")) {
    return jsonError(
      403,
      "PLUGIN_PROXY_FORBIDDEN",
      "Cross-origin requests are forbidden.",
    );
  }

  const incomingUrl = new URL(req.url);
  const extracted = await extractPluginProxyToken(req, incomingUrl);
  if (!extracted) {
    return jsonError(401, "PLUGIN_PROXY_UNAUTHORIZED", "Unauthorized.");
  }

  enrichLogContext({
    suppressPayload: true,
    secrets: [extracted.rawToken],
  });

  const { installId, proxyKey, path = [] } = await params;
  if (
    extracted.payload.marketInstallId !== installId ||
    extracted.payload.proxyKey !== proxyKey
  ) {
    return jsonError(
      403,
      "PLUGIN_PROXY_FORBIDDEN",
      "Plugin proxy token does not match target plugin proxy.",
    );
  }

  const grant = await resolveAgentPluginProxyGrant(extracted.payload);
  if (!grant.ok) {
    return jsonError(
      grant.status,
      grant.code,
      grant.code === "PLUGIN_ENV_MODE_CHANGED"
        ? "Plugin environment configuration mode has changed."
        : grant.code === "PLUGIN_ENV_INCOMPLETE"
          ? "Plugin environment configuration is incomplete."
          : grant.code === "PLUGIN_PROXY_REVOKED"
            ? "Plugin release is unavailable or revoked."
            : "Plugin proxy access denied.",
    );
  }

  const filteredParams = new URLSearchParams();
  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (extracted.carrierQueryParam && key === extracted.carrierQueryParam) {
      continue;
    }
    if (grant.auth.type === "query" && key === grant.auth.paramName) {
      continue;
    }
    filteredParams.append(key, value);
  }
  const filteredSearch = filteredParams.toString();

  let targetUrl: URL;
  try {
    targetUrl = new URL(
      runtimePluginUpstreamUrl(
        grant.upstreamBaseUrl,
        path,
        filteredSearch ? `?${filteredSearch}` : "",
      ),
    );
  } catch {
    return jsonError(
      400,
      "PLUGIN_PROXY_INVALID_PATH",
      "Plugin proxy request path is invalid.",
    );
  }

  if (grant.auth.type === "query") {
    targetUrl.searchParams.set(grant.auth.paramName, grant.secret);
  }

  let pinnedAddress: { address: string; family: number } | undefined;
  if (!grant.allowPrivateAdminHost) {
    const transport = await getTransportSettings();
    if (!permitsTransportProtocol(targetUrl.protocol, transport)) {
      return jsonError(
        403,
        "PLUGIN_PROXY_NETWORK_BLOCKED",
        "Plugin upstream protocol is blocked by transport policy.",
      );
    }
    try {
      pinnedAddress = await resolveCustomPluginUpstreamAddress(
        targetUrl.hostname.replace(/^\[|\]$/g, ""),
        req.signal,
      );
    } catch {
      return jsonError(
        403,
        "PLUGIN_PROXY_NETWORK_BLOCKED",
        "Plugin upstream address is blocked by network policy.",
      );
    }
  }

  const outgoingHeaders: Record<string, string> = {};
  const stripHeaderLower = new Set(STRIPPED_REQUEST_HEADERS);
  if (extracted.carrierHeader) stripHeaderLower.add(extracted.carrierHeader);
  if (grant.auth.type === "header") {
    stripHeaderLower.add(grant.auth.headerName.toLowerCase());
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  for (const [rawName, value] of req.headers.entries()) {
    const name = rawName.toLowerCase();
    if (stripHeaderLower.has(name)) continue;
    outgoingHeaders[name] = value;
  }

  const inboundContentLength = req.headers.get("content-length");
  if (
    hasBody &&
    req.body &&
    inboundContentLength &&
    /^\d+$/.test(inboundContentLength.trim()) &&
    !req.headers.has("transfer-encoding")
  ) {
    outgoingHeaders["content-length"] = inboundContentLength.trim();
  }
  outgoingHeaders["accept-encoding"] = "identity";

  if (grant.auth.type === "bearer") {
    outgoingHeaders.authorization = `Bearer ${grant.secret}`;
  } else if (grant.auth.type === "header") {
    outgoingHeaders[grant.auth.headerName.toLowerCase()] =
      `${grant.auth.prefix ?? ""}${grant.secret}`;
  }

  const upstreamOrigin = new URL(grant.upstreamBaseUrl).origin;
  const redactionSecrets = [...grant.secretValues, upstreamOrigin];
  const started = performance.now();

  const finishLog = (
    httpStatus: number,
    error?: unknown,
    errorCode?: string,
  ) => {
    void recordEvent({
      domain: "runtime",
      eventName: "plugin.proxy.request",
      payloadPolicy: "forbidden",
      suppressPayload: true,
      secrets: redactionSecrets,
      httpStatus,
      durationMs: Math.round(performance.now() - started),
      outcome: error
        ? errorOutcome(error)
        : httpStatus >= 400
          ? "error"
          : "success",
      error,
      errorCode:
        errorCode ??
        (httpStatus >= 400 ? "PLUGIN_PROXY_UPSTREAM_HTTP" : undefined),
    });
  };

  try {
    const upstreamRes = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const controller = AbortSignal.any([
          req.signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]);
        const requester =
          targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
        const pinned = pinnedAddress;
        const upstreamReq = requester(
          targetUrl,
          {
            method: req.method,
            headers: outgoingHeaders,
            agent: false,
            signal: controller,
            maxHeaderSize: 32_768,
            ...(pinned
              ? {
                  family: pinned.family,
                  lookup: (
                    _host: string,
                    options: { all?: boolean },
                    callback: (
                      err: NodeJS.ErrnoException | null,
                      address:
                        | string
                        | Array<{ address: string; family: number }>,
                      family?: number,
                    ) => void,
                  ) => {
                    if (options.all) callback(null, [pinned]);
                    else callback(null, pinned.address, pinned.family);
                  },
                }
              : {}),
          },
          (res) => resolve(res),
        );

        upstreamReq.on("error", (err) => reject(err));

        if (hasBody && req.body) {
          const bodyStream = Readable.fromWeb(
            req.body as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          bodyStream.on("error", (err) => {
            upstreamReq.destroy(err instanceof Error ? err : undefined);
            reject(err);
          });
          bodyStream.pipe(upstreamReq);
        } else {
          upstreamReq.end();
        }
      },
    );

    const status = upstreamRes.statusCode ?? 502;
    const headers = new Headers();
    for (const [rawKey, rawVal] of Object.entries(upstreamRes.headers)) {
      const key = rawKey.toLowerCase();
      if (STRIPPED_RESPONSE_HEADERS.has(key) || rawVal === undefined) continue;
      const values = Array.isArray(rawVal) ? rawVal : [rawVal];
      for (const item of values) {
        const safeValue =
          key === "location" ? redactText(item, redactionSecrets) : item;
        headers.append(key, safeValue);
      }
    }
    headers.set("cache-control", "no-store");

    if (req.method === "HEAD" || [204, 205, 304].includes(status)) {
      upstreamRes.resume();
      finishLog(status);
      return new NextResponse(null, { status, headers });
    }

    const rawContentType = headers.get("content-type");
    if (status >= 400 && isRedactedTextContentType(rawContentType)) {
      const { text } = await readBoundedText(upstreamRes, MAX_ERROR_BODY_BYTES);
      const safeBody = redactText(text, redactionSecrets);
      finishLog(status);
      return new NextResponse(safeBody, { status, headers });
    }

    finishLog(status);
    const webStream = Readable.toWeb(
      upstreamRes,
    ) as unknown as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, { status, headers });
  } catch (err) {
    finishLog(502, err, "PLUGIN_PROXY_UNREACHABLE");
    return jsonError(
      502,
      "PLUGIN_PROXY_UNREACHABLE",
      "Upstream plugin service is unreachable.",
    );
  }
}

const observedPluginProxyRequest = withRequestLogging(
  "/api/v1/agent-runtime/plugins/[installId]/[proxyKey]/[[...path]]",
  async (req, context: Parameters<typeof proxyPluginRequest>[1]) => {
    try {
      return await proxyPluginRequest(req, context);
    } catch {
      void recordEvent({
        domain: "runtime",
        eventName: "plugin.proxy.failed",
        payloadPolicy: "forbidden",
        suppressPayload: true,
        errorCode: "PLUGIN_PROXY_FAILED",
        httpStatus: 500,
        outcome: "error",
      });
      return jsonError(
        500,
        "PLUGIN_PROXY_FAILED",
        "Plugin proxy request failed.",
      );
    }
  },
);

export const GET = observedPluginProxyRequest;
export const HEAD = observedPluginProxyRequest;
export const POST = observedPluginProxyRequest;
export const PUT = observedPluginProxyRequest;
export const PATCH = observedPluginProxyRequest;
export const DELETE = observedPluginProxyRequest;
