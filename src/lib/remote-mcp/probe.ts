import "server-only";
import { request as http, type IncomingMessage } from "node:http";
import { request as https } from "node:https";
import { addresses } from "@/lib/a2a/remote-network";
import { resolvePrivateHostsSettings } from "@/lib/admin/settings";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { discoverMcpOAuth } from "./oauth/discovery";
import { clientAvailability } from "./oauth/clients";
import { connectorPreset } from "@/lib/connectors/presets";
import {
  parseRemoteMcpPrivateHosts,
  type PrivateHostsPolicy,
} from "../../../scripts/remote-mcp-private-hosts.mjs";
import {
  requireProbeBearer,
  type IntakeEntry,
} from "@/lib/workspace/mcp-intake";

type ProbeReply = {
  status: number;
  challenge?: string;
  session?: string;
  version?: string;
  data?: unknown;
};
const protocolVersion = "2025-06-18";

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
    return undefined;
  return (value as Record<string, unknown>)[key];
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function readProbeReply(
  response: IncomingMessage,
  budget: { remaining: number },
  notification: boolean,
  rpcId?: number,
) {
  const session = response.headers["mcp-session-id"];
  const version = response.headers["mcp-protocol-version"];
  const reply: ProbeReply = {
    status: response.statusCode ?? 0,
    challenge: response.headers["www-authenticate"],
    session: typeof session === "string" ? session : undefined,
    version: typeof version === "string" ? version : undefined,
  };
  if (reply.status < 200 || reply.status >= 300 || notification) {
    response.destroy();
    return reply;
  }
  const stream = response.headers["content-type"]
    ?.toLowerCase()
    .startsWith("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response) {
    budget.remaining -= chunk.length;
    if (budget.remaining < 0) throw new Error("probeLimit");
    pending += decoder.decode(chunk, { stream: true });
    if (!stream) continue;
    for (
      let boundary = /\r?\n\r?\n/.exec(pending);
      boundary;
      boundary = /\r?\n\r?\n/.exec(pending)
    ) {
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const lines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"));
      const data = parseJson(
        lines.map((line) => line.slice(5).trimStart()).join("\n"),
      );
      if (rpcId !== undefined && property(data, "id") === rpcId)
        return { ...reply, data };
    }
  }
  reply.data = parseJson(pending + decoder.decode());
  return reply;
}

// Every hop in this exchange (including well-known endpoints) shares one
// validated address, deadline, and response-body budget. Never follow redirects.
async function openProbe(url: URL, privateHosts: PrivateHostsPolicy | null) {
  const signal = AbortSignal.timeout(8000);
  const pinned = await addresses(
    url.hostname.replace(/^\[|\]$/g, ""),
    signal,
    privateHosts,
  );
  const budget = { remaining: 64 * 1024 };
  return async (
    pathname: string,
    body?: object,
    headers: Record<string, string> = {},
    rpcId?: number,
  ) => {
    const target = new URL(url);
    target.pathname = pathname;
    const { promise, resolve, reject } =
      Promise.withResolvers<IncomingMessage>();
    const request = (target.protocol === "https:" ? https : http)(
      target,
      {
        method: body ? "POST" : "GET",
        agent: false,
        signal,
        maxHeaderSize: 16384,
        family: pinned.family,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        headers: {
          accept: "application/json, text/event-stream",
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      resolve,
    );
    request.once("error", reject);
    request.end(body ? JSON.stringify(body) : undefined);
    return readProbeReply(
      await promise,
      budget,
      Boolean(body && rpcId === undefined),
      rpcId,
    );
  };
}

function rpc(method: string, params: object, id?: number) {
  return { jsonrpc: "2.0", id, method, params };
}

async function resolveDraftOAuth(
  entry: IntakeEntry,
  url: URL,
  allowHttp: boolean,
  challenge?: string,
) {
  const preset = entry.draft.presetId && connectorPreset(entry.draft.presetId);
  const { server } = await discoverMcpOAuth(url.href, {
    challenge,
    allowHttp,
    presetScopes: preset?.oauth?.scopes,
  });
  const { kind } = await clientAvailability(server);
  entry.draft.auth = { type: "oauth", issuer: server.issuer, client: kind };
}

async function probe(
  entry: IntakeEntry,
  allowHttp: boolean,
  privateHosts: PrivateHostsPolicy | null,
) {
  const url = new URL(JSON.parse(entry.draft.config).url);
  if (url.protocol === "http:" && !allowHttp) return;
  if (entry.draft.presetId) {
    await resolveDraftOAuth(entry, url, allowHttp);
    return;
  }
  const send = await openProbe(url, privateHosts);
  let reply = await send(
    url.pathname,
    rpc(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "ToolPlane", version: "1" },
      },
      1,
    ),
    {},
    1,
  );
  if (reply.status >= 200 && reply.status < 300) {
    const version =
      reply.version ??
      property(property(reply.data, "result"), "protocolVersion") ??
      protocolVersion;
    if (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version))
      throw new Error("probeProtocol");
    if (reply.session && !/^[!-~]{1,1024}$/.test(reply.session))
      throw new Error("probeProtocol");
    const headers: Record<string, string> = { "mcp-protocol-version": version };
    if (reply.session) headers["mcp-session-id"] = reply.session;
    reply = await send(
      url.pathname,
      rpc("notifications/initialized", {}),
      headers,
    );
    if (reply.status !== 401 && reply.status !== 403)
      reply = await send(url.pathname, rpc("tools/list", {}, 2), headers, 2);
  }
  if (reply.status >= 200 && reply.status < 300) {
    entry.draft.reachability = "ok";
    entry.draft.auth = { type: "none" };
  } else if (reply.status === 401 || reply.status === 403) {
    const challenged = /\bresource_metadata\s*=/i.test(reply.challenge ?? "");
    requireProbeBearer(entry);
    entry.draft.reachability = "auth";
    try {
      await resolveDraftOAuth(entry, url, allowHttp, reply.challenge ?? "");
    } catch {
      entry.draft.auth = challenged
        ? { type: "oauth", issuer: null, client: "missing" }
        : { type: "static" };
    }
  } else entry.draft.reachability = "unreachable";
}

export async function probeRemoteDrafts(entries: IntakeEntry[]) {
  const pending = entries.filter(
    (entry) =>
      entry.draft.kind === "remote" && !Object.keys(entry.literals).length,
  );
  if (!pending.length) return;
  try {
    const [transport, settings] = await Promise.all([
      getTransportSettings(),
      resolvePrivateHostsSettings(),
    ]);
    const hosts = parseRemoteMcpPrivateHosts(settings.value);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(5, pending.length) }, async () => {
        while (next < pending.length) {
          const entry = pending[next++];
          try {
            await probe(entry, transport.allowHttp, hosts);
          } catch {
            entry.draft.reachability = "unreachable";
          }
        }
      }),
    );
  } catch {
    for (const entry of pending) entry.draft.reachability = "unreachable";
  }
}
