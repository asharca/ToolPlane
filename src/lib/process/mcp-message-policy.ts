import "server-only";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type McpToolPolicy,
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
} from "@/lib/workspace/mcp-tool-exposure";

const granted = [
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
];
export function gatewayDenial(
  msg: JSONRPCMessage,
  toolsOnly: boolean,
  policy: McpToolPolicy,
) {
  if (!("method" in msg)) return null;
  if (toolsOnly && !granted.includes(msg.method))
    return {
      code: -32601,
      message: "Method is outside the package grant.",
      data: { reason: "MCP_METHOD_FORBIDDEN" },
    };
  const name = msg.params?.name;
  if (
    msg.method === "tools/call" &&
    (typeof name !== "string" || !isMcpToolExposedToAi(policy, name))
  )
    return {
      code: -32602,
      message: `Unknown tool: ${typeof name === "string" ? name : ""}`,
      data: { reason: "MCP_TOOL_FORBIDDEN" },
    };
  return null;
}
export function filterGatewayReply(
  message: unknown,
  calls: Map<string | number, string>,
  toolsOnly: boolean,
  policy: McpToolPolicy,
): JSONRPCMessage | null {
  const m = JSONRPCMessageSchema.parse(message);
  if ("method" in m) {
    if (
      toolsOnly &&
      ![
        "ping",
        "notifications/progress",
        "notifications/cancelled",
        "notifications/tools/list_changed",
      ].includes(m.method)
    )
      return null;
    return m;
  }
  if (!("result" in m)) return m;
  const method = calls.get(m.id);
  if (!method) return null;
  if (toolsOnly && method === "initialize")
    return { ...m, result: { ...m.result, capabilities: { tools: {} } } };
  if (method === "tools/list") {
    const tools = m.result.tools;
    return {
      ...m,
      result: {
        ...m.result,
        tools: Array.isArray(tools)
          ? filterMcpToolsForAi(
              tools.filter(
                (t): t is { name: string } => typeof t?.name === "string",
              ),
              policy,
            )
          : [],
      },
    };
  }
  return m;
}

/** Decode complete SSE records (not transport chunks) before applying message policy. */
export function gatewayEventStream(
  body: ReadableStream<Uint8Array>,
  filter: (m: unknown) => unknown,
  onEnd: (error?: string) => void,
  denied: readonly JSONRPCMessage[],
) {
  let buffer = "";
  let data: string[] = [];
  let frameSize = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const enc = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      for (const m of denied)
        controller.enqueue(
          enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`),
        );
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (
        let end = buffer.indexOf("\n");
        end >= 0;
        end = buffer.indexOf("\n", start)
      ) {
        const line = buffer.slice(
          start,
          end > start && buffer[end - 1] === "\r" ? end - 1 : end,
        );
        start = end + 1;
        frameSize += line.length;
        if (frameSize > 16_777_216) throw new Error("MCP_FRAME_TOO_LARGE");
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        if (line !== "") continue;
        const payload = data.join("\n");
        data = [];
        frameSize = 0;
        if (!payload) continue;
        const m = filter(JSON.parse(payload));
        if (m)
          controller.enqueue(
            enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`),
          );
      }
      buffer = buffer.slice(start);
      if (buffer.length + frameSize > 16_777_216)
        throw new Error("MCP_FRAME_TOO_LARGE");
    },
    flush() {
      if (decoder.decode() || buffer.trim() || data.length)
        throw new Error("MCP_STREAM_TRUNCATED");
    },
  });
  void body.pipeTo(transform.writable).then(
    () => onEnd(),
    () => onEnd("MCP_STREAM_INTERRUPTED"),
  );
  return transform.readable;
}
