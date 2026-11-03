import "server-only";
import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { authorizeLogs, LogAccessError } from "../queries";
import { listMcpCalls, getMcpCall, pollMcpCalls } from "./mcp-calls";
import { listA2ATasks, getA2ATask, pollA2ATasks } from "./a2a-tasks";
import type { ViewScope } from "./types";

const text = z.string().max(200).optional();
const timeFields = {
  range: z.enum(["1h", "24h", "7d", "30d", "custom"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  workspaceId: text,
  q: text,
};
const mcpFilter = z.object({
  ...timeFields,
  deploymentId: text,
  tool: text,
  method: text,
  callerKind: z.enum(["user", "agent", "token"]).optional(),
  outcome: z.enum(["success", "error"]).optional(),
  slow: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .optional(),
  slowMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
  source: z.enum(["calls", "internal", "tools"]).optional(),
});
const a2aFilter = z.object({
  ...timeFields,
  agentId: text,
  direction: z.enum(["inbound", "outbound", "internal"]).optional(),
  state: text,
});
export type StreamCursor = { createdAt: string; id: string };
const cursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().max(200),
});
export function encodeStreamCursor(cursor: StreamCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function streamCursor(req: Request, query: URLSearchParams): StreamCursor {
  const last = req.headers.get("last-event-id");
  if (last)
    return cursorSchema.parse(
      JSON.parse(Buffer.from(last, "base64url").toString()),
    );
  return {
    createdAt:
      query.get("after") || query.get("since") || new Date().toISOString(),
    id: "",
  };
}
const noStore = { "Cache-Control": "no-store" };

export async function handleLogRequest(
  req: Request,
  target: { slug: string } | { admin: true },
  kind: "mcp" | "a2a" | "stream",
  id?: string,
): Promise<Response> {
  try {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const query = new URL(req.url).searchParams;
    let scope: ViewScope;
    if ("admin" in target) {
      scope = {
        kind: "admin",
        userId: user.id,
        workspaceId: query.get("workspaceId") || undefined,
      };
      await authorizeLogs({ adminId: user.id });
    } else {
      const workspace = await getWorkspaceForUser(target.slug, user.id);
      if (!workspace)
        return Response.json({ error: "Workspace not found" }, { status: 404 });
      scope = { kind: "workspace", workspaceId: workspace.id, userId: user.id };
      await authorizeLogs({ workspaceId: workspace.id, userId: user.id });
    }
    if (id) {
      const detail =
        kind === "mcp"
          ? await getMcpCall(scope, id)
          : await getA2ATask(scope, id);
      return detail
        ? Response.json(detail, { headers: noStore })
        : Response.json({ error: "Not found" }, { status: 404 });
    }
    const selected =
      kind === "stream"
        ? z.enum(["mcp", "a2a"]).parse(query.get("kind"))
        : kind;
    const values = Object.fromEntries(query);
    const filter =
      selected === "mcp" ? mcpFilter.parse(values) : a2aFilter.parse(values);
    const now = Date.now();
    const durations = {
      "1h": 3_600_000,
      "24h": 86_400_000,
      "7d": 604_800_000,
      "30d": 2_592_000_000,
      custom: 86_400_000,
    };
    const until = filter.until ? Date.parse(filter.until) : now;
    const since = filter.since
      ? Date.parse(filter.since)
      : until - durations[filter.range ?? "24h"];
    if (filter.range === "custom" && (!filter.since || !filter.until))
      return Response.json(
        { error: "Custom range requires since and until" },
        { status: 400 },
      );
    if (since > until || until - since > 31 * 86_400_000)
      return Response.json(
        { error: "Maximum window is 31 days" },
        { status: 400 },
      );
    if (kind === "stream") {
      const after = cursorSchema.parse(streamCursor(req, query));
      return logStream(req, scope, selected, filter, after);
    }
    const cursor = z
      .string()
      .max(1000)
      .optional()
      .parse(query.get("cursor") || undefined);
    const page =
      selected === "mcp"
        ? await listMcpCalls(scope, filter, cursor)
        : await listA2ATasks(scope, filter, cursor);
    return Response.json(page, { headers: noStore });
  } catch (error) {
    if (error instanceof LogAccessError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error &&
        /cursor|window|range|filter/i.test(error.message))
    )
      return Response.json(
        { error: "Invalid log filters or cursor" },
        { status: 400 },
      );
    throw error;
  }
}

export function logStream(
  req: Request,
  scope: ViewScope,
  kind: "mcp" | "a2a",
  filter: z.infer<typeof mcpFilter> | z.infer<typeof a2aFilter>,
  after: StreamCursor,
): Response {
  const encoder = new TextEncoder();
  const started = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let close: (() => void) | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(lifetime);
    wake?.();
    req.signal.removeEventListener("abort", stop);
    close?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
      lifetime = setTimeout(stop, 600_000);
      req.signal.addEventListener("abort", stop, { once: true });
      if (req.signal.aborted) {
        stop();
        return;
      }
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
      void (async () => {
        let cursor = after;
        let heartbeat = Date.now();
        try {
          while (!stopped && Date.now() - started < 600_000) {
            const page =
              kind === "mcp"
                ? await pollMcpCalls(scope, filter, cursor)
                : await pollA2ATasks(scope, filter, cursor);
            if (stopped) break;
            for (const entry of page.items) {
              controller.enqueue(
                encoder.encode(
                  `id: ${encodeStreamCursor(entry.cursor)}\nevent: item\ndata: ${JSON.stringify(entry.item)}\n\n`,
                ),
              );
            }
            cursor = page.nextCursor;
            if (Date.now() - heartbeat >= 15_000) {
              controller.enqueue(
                encoder.encode(
                  `id: ${encodeStreamCursor(cursor)}\nevent: heartbeat\ndata: {}\n\n`,
                ),
              );
              heartbeat = Date.now();
            }
            // Drain backlog immediately; otherwise one poll per second across processes.
            if (page.items.length >= 50) continue;
            const delay = Promise.withResolvers<void>();
            wake = delay.resolve;
            timer = setTimeout(
              delay.resolve,
              Math.min(1000, 600_000 - (Date.now() - started)),
            );
            await delay.promise;
            wake = undefined;
          }
          stop();
        } catch (error) {
          if (!stopped) {
            stopped = true;
            req.signal.removeEventListener("abort", stop);
            clearTimeout(lifetime);
            controller.error(error);
          }
        }
      })();
    },
    cancel() {
      close = undefined;
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
