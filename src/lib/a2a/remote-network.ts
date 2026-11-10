import "server-only";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { resolvePrivateHostsSettings } from "@/lib/admin/settings";
import {
  isPrivateRemoteMcpIp,
  normalizeRemoteMcpHostname,
  parseRemoteMcpPrivateHosts,
  type PrivateHostsPolicy,
} from "../../../scripts/remote-mcp-private-hosts.mjs";
import {
  DEFAULT_TRANSPORT_POLICY,
  permitsTransportProtocol,
  a2aTransportBodyBytes,
  type TransportPolicy,
} from "@/lib/transport-policy";
import { BlockList, isIP } from "node:net";
import { validateRemoteResponse, fileSafeLogPayload } from "./remote-wire";
import { runtimeEnv } from "@/lib/runtime-env";
import { TaskState } from "@a2a-js/sdk";
import {
  recordA2AEvent,
  a2aTaskOutcome,
  type A2ALogBinding,
  type A2ALogMetadata,
} from "@/lib/observability/a2a-log";
import type { LogOutcome } from "@/lib/observability/events";
import { taskFileLimitError } from "./file-limits";

export const REMOTE_RESPONSE_BYTES = 524_288;
export const REMOTE_REQUEST_BYTES = 262_144;
export class RemoteA2AError extends Error {
  constructor(
    message = "The remote Agent request could not be verified or completed.",
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function publicRemoteAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
/** Deployment administrator approves exact origins; workspace administrators cannot override this policy. */
export function remoteUrl(
  value: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteA2AError("Invalid remote HTTPS address.");
  }
  if (
    value !== value.trim() ||
    /[^\x21-\uFFFF]|[\x7f\\]/.test(value) ||
    !permitsTransportProtocol(url.protocol, policy) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RemoteA2AError(
      "Remote addresses require HTTPS without credentials, query or fragment.",
    );
  }
  let allowed: unknown;
  try {
    allowed = JSON.parse(runtimeEnv("TOOLPLANE_A2A_REMOTE_ORIGINS") || "[]");
  } catch {
    throw new RemoteA2AError("Configure the remote Agent origin allowlist.");
  }
  if (
    !Array.isArray(allowed) ||
    allowed.length > 100 ||
    !allowed.every((origin) => typeof origin === "string") ||
    !allowed.includes(url.origin)
  ) {
    throw new RemoteA2AError(
      "The deployment administrator has not allowed this remote origin.",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicRemoteAddress(host))
    throw new RemoteA2AError(
      "Private or reserved remote addresses are not allowed.",
    );
  return url;
}
export function remotePair(
  cardUrl: string,
  rpcUrl: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
) {
  const card = remoteUrl(cardUrl, policy),
    rpc = remoteUrl(rpcUrl, policy);
  if (card.origin !== rpc.origin || card.href === rpc.href)
    throw new RemoteA2AError(
      "Card and RPC addresses must be distinct paths on the same approved origin.",
    );
  return { cardUrl: card.href, rpcUrl: rpc.href };
}
async function addresses(
  host: string,
  signal: AbortSignal,
  privateHosts: PrivateHostsPolicy | null = null,
) {
  const pending = isIP(host)
    ? Promise.resolve([{ address: host, family: isIP(host) }])
    : lookup(host, { all: true, verbatim: true });
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      const error = new RemoteA2AError();
      error.cause = signal.reason;
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const name = normalizeRemoteMcpHostname(host);
    const listedHost =
      privateHosts &&
      (privateHosts.hosts.has(name) ||
        [...privateHosts.suffixes].some((suffix) =>
          name.endsWith(`.${suffix}`),
        ));
    const result = await Promise.race([pending, aborted]);
    if (
      !result.length ||
      result.length > 32 ||
      result.some(
        (item) =>
          !publicRemoteAddress(item.address) &&
          !(
            privateHosts &&
            isPrivateRemoteMcpIp(item.address) &&
            (listedHost ||
              privateHosts.ips.has(normalizeRemoteMcpHostname(item.address)))
          ),
      )
    )
      throw new RemoteA2AError("Remote DNS resolved to a prohibited address.");
    return result[0];
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** Bounded JSON-only HTTPS fetch, with DNS pinned to the validated address for this exact connection. */
async function fetchPinnedRemoteJson(
  urlValue: string,
  method: "GET" | "POST",
  body: string | undefined,
  token: string | undefined,
  signal?: AbortSignal,
  snapshot?: TransportPolicy,
): Promise<Response> {
  const policy = snapshot ?? (await getTransportSettings());
  const url = remoteUrl(urlValue, policy);
  const responseBytes = Math.max(
    REMOTE_RESPONSE_BYTES,
    a2aTransportBodyBytes(policy),
  );
  if (
    body &&
    Buffer.byteLength(body) >
      Math.max(REMOTE_REQUEST_BYTES, a2aTransportBodyBytes(policy))
  )
    throw new RemoteA2AError("Remote request size limit exceeded.");
  if (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 8192))
    throw new RemoteA2AError("Invalid remote credential.");
  const abortSignal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(signal ? [signal] : []),
  ]);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const pinned = await addresses(host, abortSignal);
  abortSignal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    let httpStatus: number | undefined;
    const fail = () => {
      const error = new RemoteA2AError(undefined, httpStatus);
      if (abortSignal.aborted) error.cause = abortSignal.reason;
      reject(error);
    };
    const req = (url.protocol === "http:" ? httpRequest : request)(
      url,
      {
        method,
        agent: false,
        signal: abortSignal,
        maxHeaderSize: 16_384,
        // SNI and certificate validation remain tied to the original HTTPS hostname.
        family: pinned.family,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "a2a-version": "1.0",
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code > 0) httpStatus = code;
        if (
          code < 200 ||
          code >= 300 ||
          code === 204 ||
          code === 205 ||
          !/^application\/json(?:\s*;|$)/i.test(
            String(res.headers["content-type"] ?? ""),
          ) ||
          (res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity") ||
          (res.headers["a2a-version"] &&
            res.headers["a2a-version"] !== "1.0") ||
          Number(res.headers["content-length"]) > responseBytes
        ) {
          res.destroy();
          req.destroy();
          fail();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > responseBytes) {
            res.destroy();
            req.destroy();
            fail();
          } else chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("aborted", fail);
        res.on("end", () => {
          if (!res.complete) {
            fail();
            return;
          }
          resolve(
            new Response(new Uint8Array(Buffer.concat(chunks)), {
              status: code,
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
              },
            }),
          );
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
/** No header passthrough, URL switching, proxy environment, redirect following or automatic replay. */
export function remoteRpcFetch(
  rpcUrl: string,
  token: string | undefined,
  binding: A2ALogBinding,
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const policy = await getTransportSettings();
    const approvedUrl = remoteUrl(rpcUrl, policy).href;
    if (req.url !== approvedUrl || req.method !== "POST")
      throw new RemoteA2AError("Remote transport target changed.");
    const started = performance.now();
    let rpc: unknown, requestPayload: unknown, responsePayload: unknown;
    let rpcMethod = "unknown",
      httpStatus: number | undefined,
      rpcErrorCode: number | undefined;
    let taskState: A2ALogMetadata["taskState"];
    let outcome: LogOutcome = "error";
    let responseComplete = false;
    try {
      const body = await req.text();
      requestPayload = { rawText: body };
      try {
        rpc = JSON.parse(body);
        requestPayload = rpc;
      } catch {
        /* Preserve the existing transport validation order. */
      }
      const method = (rpc as { method?: unknown } | null)?.method;
      if (
        typeof method === "string" &&
        ["SendMessage", "GetTask", "CancelTask"].includes(method)
      )
        rpcMethod = method;
      const response = await fetchRemoteJson(
        rpcUrl,
        "POST",
        body,
        token,
        req.signal,
        policy,
      );
      httpStatus = response.status;
      try {
        const text = await response.clone().text();
        responsePayload = { rawText: text };
        responseComplete = true;
        responsePayload = JSON.parse(text);
        validateRemoteResponse(rpc, responsePayload, policy);
      } catch {
        throw new RemoteA2AError(
          "Remote output is not a valid supported A2A response.",
          httpStatus,
        );
      }
      const envelope = responsePayload as {
        error?: { code: number };
        result?: {
          task?: { status: { state: string | number } };
          status?: { state: string | number };
        };
      };
      rpcErrorCode = envelope.error?.code;
      const state = (
        rpcMethod === "SendMessage" ? envelope.result?.task : envelope.result
      )?.status?.state;
      taskState = (
        typeof state === "number" ? TaskState[state] : state
      ) as A2ALogMetadata["taskState"];
      outcome = envelope.error ? "error" : a2aTaskOutcome(taskState);
      return response;
    } catch (error) {
      if (error instanceof RemoteA2AError)
        httpStatus = error.httpStatus ?? httpStatus;
      const reason = req.signal.aborted
        ? req.signal.reason
        : error instanceof Error
          ? (error.cause ?? error)
          : error;
      outcome =
        httpStatus === 401 || httpStatus === 403
          ? "denied"
          : reason instanceof Error && reason.name === "TimeoutError"
            ? "timeout"
            : req.signal.aborted
              ? "cancelled"
              : "error";
      throw error;
    } finally {
      await recordA2AEvent({
        eventName: "a2a.request",
        binding,
        metadata: {
          direction: "outbound",
          transport: "jsonrpc",
          taskState,
          rpcErrorCode,
        },
        rpcMethod,
        method: "POST",
        path: approvedUrl,
        httpStatus,
        outcome,
        durationMs: performance.now() - started,
        request: fileSafeLogPayload(requestPayload),
        response: fileSafeLogPayload(responsePayload),
        responseKind: responsePayload === undefined ? "none" : "json",
        responseComplete,
        secrets: token ? [token] : undefined,
      });
    }
  };
}

let inflight = 0;
export async function fetchRemoteJson(
  ...args: Parameters<typeof fetchPinnedRemoteJson>
): Promise<Response> {
  if (inflight >= 16)
    throw new RemoteA2AError("Remote connection capacity reached.");
  inflight++;
  try {
    return await fetchPinnedRemoteJson(...args);
  } finally {
    inflight--;
  }
}

/** Signed query strings are accepted only by the file transport, never Card/RPC. */
export function remoteFileUrl(
  value: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteA2AError("Invalid file HTTPS address.");
  }
  if (
    value !== value.trim() ||
    value.length > 8192 ||
    /[^\x21-\uFFFF]|[\x7f\\]/.test(value) ||
    !permitsTransportProtocol(url.protocol, policy) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new RemoteA2AError(
      "File addresses require HTTPS without credentials or fragment.",
    );
  return url;
}
/** Stream bytes directly to storage. No redirects, auth forwarding, proxy, or payload logging. */
export async function fetchRemoteFile(
  value: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const policy = await getTransportSettings();
  const url = remoteFileUrl(value, policy);
  if (inflight >= 16)
    throw new RemoteA2AError("Remote connection capacity reached.");
  inflight++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      inflight--;
    }
  };
  try {
    const abortSignal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const privateHosts = parseRemoteMcpPrivateHosts(
      (await resolvePrivateHostsSettings()).value,
    );
    const pinned = await addresses(host, abortSignal, privateHosts);
    const name = normalizeRemoteMcpHostname(host);
    const listedHost =
      privateHosts &&
      (privateHosts.hosts.has(name) ||
        [...privateHosts.suffixes].some((suffix) =>
          name.endsWith(`.${suffix}`),
        ));
    if (!listedHost && publicRemoteAddress(pinned.address)) {
      const clean = new URL(url);
      clean.search = "";
      remoteUrl(clean.href, policy);
    }
    abortSignal.throwIfAborted();
    const { promise, resolve, reject } =
      Promise.withResolvers<ReadableStream<Uint8Array>>();
    const req = (url.protocol === "http:" ? httpRequest : request)(
      url,
      {
        method: "GET",
        agent: false,
        signal: abortSignal,
        maxHeaderSize: 16_384,
        family: pinned.family,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        headers: { accept: "*/*", "accept-encoding": "identity" },
      },
      (res) => {
        const refuse = (error: Error) => {
          res.destroy();
          req.destroy();
          release();
          reject(error);
        };
        if (
          (res.statusCode ?? 0) !== 200 ||
          (res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity")
        ) {
          refuse(new RemoteA2AError("File download was rejected."));
          return;
        }
        if (Number(res.headers["content-length"]) > policy.a2aFileBytes) {
          refuse(taskFileLimitError("FILE_TOO_LARGE", policy.a2aFileBytes));
          return;
        }
        let bytes = 0;
        let ended = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const end = (error: Error) => {
              if (!ended) {
                ended = true;
                release();
                controller.error(error);
              }
            };
            const fail = () => end(new RemoteA2AError("File download failed."));
            res.on("data", (chunk: Buffer) => {
              if (ended) return;
              bytes += chunk.byteLength;
              if (bytes > policy.a2aFileBytes) {
                end(taskFileLimitError("FILE_TOO_LARGE", policy.a2aFileBytes));
                res.destroy();
                req.destroy();
                return;
              }
              controller.enqueue(chunk);
              if ((controller.desiredSize ?? 0) <= 0) res.pause();
            });
            res.on("error", fail);
            res.on("aborted", fail);
            req.on("error", fail);
            res.on("end", () => {
              if (!res.complete) {
                fail();
                return;
              }
              if (!ended) {
                ended = true;
                release();
                controller.close();
              }
            });
          },
          pull() {
            res.resume();
          },
          cancel() {
            ended = true;
            res.destroy();
            req.destroy();
            release();
          },
        });
        resolve(body);
      },
    );
    req.on("error", () => {
      release();
      reject(new RemoteA2AError("File download failed."));
    });
    req.end();
    return await promise;
  } catch (error) {
    release();
    throw error;
  }
}
