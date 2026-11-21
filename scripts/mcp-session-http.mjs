// One downstream session owns one upstream transport. IDs are directional: a
// server request with id=1 must never satisfy a pending client request id=1.
import { randomUUID } from "node:crypto";
import {
  JSONRPCMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

const sessions = new Map();
const limit = 64;
const lifetime = 10 * 60_000;
const request = (m) => typeof m.method === "string" && m.id !== undefined;
const reply = (res, status, message, id = null, code = -32600) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
};
function emit(stream, msg) {
  if (stream.writableLength > 4_000_000 || stream.destroyed) {
    stream.destroy();
    return false;
  }
  stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  return true;
}
function touch(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => void close(s), lifetime).unref();
}
async function close(s) {
  if (!sessions.delete(s.id)) return;
  clearTimeout(s.timer);
  s.get?.end();
  for (const { stream, timer } of s.calls.values()) {
    clearTimeout(timer);
    stream.end();
  }
  s.calls.clear();
  await s.upstream?.close().catch(() => {});
}
export async function closeSessions() {
  await Promise.all([...sessions.values()].map(close));
}
function deliver(s, m) {
  if (!sessions.has(s.id)) return;
  if (Array.isArray(m)) {
    for (const entry of m) deliver(s, entry);
    return;
  }
  if (!JSONRPCMessageSchema.safeParse(m).success) {
    void close(s);
    return;
  }
  if (!m.method) {
    const call = s.calls.get(m.id);
    if (!call) return;
    if (call.method === "initialize") {
      const version = m.result?.protocolVersion;
      if (SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        s.version = version;
        s.upstream.setProtocolVersion?.(version);
      }
    }
    emit(call.stream, m);
    clearTimeout(call.timer);
    s.calls.delete(m.id);
    if (![...s.calls.values()].some((c) => c.stream === call.stream))
      call.stream.end();
    return;
  }
  if (
    request(m) &&
    ["roots/list", "sampling/createMessage", "elicitation/create"].includes(
      m.method,
    ) &&
    !s.capabilities[m.method.split("/")[0]]
  ) {
    void s.upstream
      .send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: "MCP_CAPABILITY_NOT_NEGOTIATED" },
      })
      .catch(() => close(s));
    return;
  }
  // Explicit progress correlation takes precedence. Unrelated notifications use
  // the standalone GET; a single outstanding POST can host nested requests.
  const calls = [...s.calls.values()];
  const progress =
    m.method === "notifications/progress" &&
    calls.find(
      (c) => c.progress !== undefined && c.progress === m.params?.progressToken,
    );
  const stream =
    progress?.stream ??
    (request(m) && calls.length === 1
      ? calls[0].stream
      : (s.get ?? (calls.length === 1 ? calls[0].stream : null)));
  if (request(m) && (s.reverse.has(m.id) || s.reverse.size >= limit)) {
    void close(s);
    return;
  }
  if (stream && emit(stream, m)) {
    if (request(m)) s.reverse.add(m.id);
  } else if (request(m))
    void s.upstream
      .send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32000, message: "MCP_CLIENT_UNAVAILABLE" },
      })
      .catch(() => close(s));
}
export async function sessionHttp(req, res, open) {
  let created;
  try {
    const key = req.headers["mcp-session-id"];
    const owner = req.headers["x-toolplane-mcp-owner"];
    if (typeof owner !== "string" || !owner)
      return reply(res, 403, "MCP_SESSION_FORBIDDEN");
    let s = key && sessions.get(key);
    if (key && (!s || s.owner !== owner))
      return reply(res, 404, "MCP_SESSION_NOT_FOUND");
    if (s) {
      const header = req.headers["mcp-protocol-version"];
      if (!s.version || (header !== undefined && s.version !== header))
        return reply(res, 400, "MCP_VERSION_MISMATCH");
      touch(s);
    }
    if (req.method === "DELETE" && s) {
      await close(s);
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "GET" && s) {
      if (s.get) return reply(res, 409, "MCP_STREAM_ALREADY_OPEN");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      res.flushHeaders();
      s.get = res;
      res.once("close", () => {
        if (s.get === res) s.get = null;
      });
      return;
    }
    if (req.method !== "POST") return reply(res, 405, "MCP_METHOD_FORBIDDEN");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_048_576) return reply(res, 413, "MCP_PAYLOAD_TOO_LARGE");
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(res, 400, "MCP_PARSE_ERROR", null, -32700);
    }
    if (
      Array.isArray(body) &&
      (s?.version !== "2025-03-26" || !body.length || body.length > limit)
    )
      return reply(res, 400, "MCP_BATCH_FORBIDDEN");
    const list = Array.isArray(body) ? body : [body];
    if (list.some((m) => !JSONRPCMessageSchema.safeParse(m).success))
      return reply(res, 400, "MCP_INVALID_MESSAGE");
    if (!s) {
      if (body.method !== "initialize" || !request(body))
        return reply(res, 400, "MCP_SESSION_REQUIRED");
      if (sessions.size >= limit) return reply(res, 503, "MCP_SESSION_LIMIT");
      s = {
        id: randomUUID(),
        owner,
        capabilities: body.params?.capabilities ?? {},
        calls: new Map(),
        reverse: new Set(),
        get: null,
        version: null,
      };
      created = s;
      sessions.set(s.id, s);
      touch(s);
      s.upstream = await open({
        onmessage: (m) => deliver(s, m),
        onclose: () => void close(s),
      });
      if (!sessions.has(s.id) || res.destroyed) {
        await s.upstream.close();
        await close(s);
        return;
      }
    } else if (list.some((m) => m.method === "initialize"))
      return reply(res, 400, "MCP_ALREADY_INITIALIZED");
    const calls = list.filter(request);
    if (
      s.calls.size + calls.length > limit ||
      new Set(calls.map((m) => m.id)).size !== calls.length ||
      calls.some((m) => s.calls.has(m.id))
    )
      return reply(res, 400, "MCP_INVALID_REQUEST_ID");
    if (list.some((m) => !m.method && !s.reverse.has(m.id)))
      return reply(res, 400, "MCP_UNKNOWN_RESPONSE");
    if (calls.length) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "mcp-session-id": s.id,
      });
      res.flushHeaders();
      const cancel = (id) =>
        s.upstream
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          })
          .catch(() => close(s));
      for (const m of calls) {
        const timer = setTimeout(() => {
          void cancel(m.id);
          deliver(s, {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32000, message: "MCP_REQUEST_TIMEOUT" },
          });
        }, lifetime).unref();
        s.calls.set(m.id, {
          stream: res,
          timer,
          method: m.method,
          progress: m.params?._meta?.progressToken,
        });
      }
      res.once("close", () => {
        for (const m of calls) {
          const c = s.calls.get(m.id);
          if (c?.stream === res) {
            clearTimeout(c.timer);
            s.calls.delete(m.id);
            void cancel(m.id);
          }
        }
      });
    }
    for (const m of list) {
      if (!m.method) s.reverse.delete(m.id);
      await s.upstream.send(m);
      if (
        m.method === "notifications/cancelled" &&
        s.calls.has(m.params?.requestId)
      ) {
        deliver(s, {
          jsonrpc: "2.0",
          id: m.params.requestId,
          error: { code: -32800, message: "MCP_REQUEST_CANCELLED" },
        });
      }
    }
    if (!calls.length) {
      res.writeHead(202);
      res.end();
    }
  } catch {
    if (created) await close(created);
    if (!res.headersSent) reply(res, 502, "MCP_TRANSPORT_FAILED");
    else res.destroy();
  }
}
