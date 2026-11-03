import { posix } from "node:path";
import { beginAgentConversationSandboxAccess } from "@/lib/agents/conversation-sandbox";

export async function proxyConversationWorkspace(
  req: Request,
  path: string[],
  resolve: () => Promise<{
    port: number;
    sandboxId: string;
    workspaceRoot: string;
  } | null>,
) {
  const targetPath =
    path[0] === "rpc" && path.length === 1
      ? "/"
      : path[0] === "terminal"
        ? `/terminal/session${path.length > 1 ? `/${path.slice(1).map(encodeURIComponent).join("/")}` : ""}`
        : null;
  if (!targetPath)
    return Response.json({ error: "Not found" }, { status: 404 });
  const target = await resolve();
  if (!target)
    return Response.json(
      { error: "Conversation workspace is unavailable" },
      { status: 404 },
    );
  let body = ["GET", "DELETE"].includes(req.method)
    ? undefined
    : await req.text();
  if (body && Buffer.byteLength(body) > 1_000_000)
    return Response.json({ error: "Request too large" }, { status: 413 });
  if (body) {
    try {
      const payload = JSON.parse(body);
      const scopedPath = (value: unknown) => {
        if (value !== undefined && typeof value !== "string")
          throw new Error("Invalid path");
        const relative = String(value ?? ".").replace(
          /^\/workspace(?:\/|$)/,
          "",
        );
        const normalized = posix.normalize(relative || ".");
        if (
          posix.isAbsolute(normalized) ||
          normalized === ".." ||
          normalized.startsWith("../")
        )
          throw new Error("Invalid path");
        return posix.relative(
          "/workspace",
          posix.join(target.workspaceRoot, normalized),
        );
      };
      if (
        path[0] === "terminal" &&
        path.length === 1 &&
        req.method === "POST"
      ) {
        payload.cwd = scopedPath(payload.cwd);
      } else if (path[0] === "rpc" && payload.method === "tools/call") {
        const params = payload.params;
        const args = params.arguments ?? {};
        if (
          [
            "list_dir",
            "read_file",
            "download_file",
            "write_file",
            "delete_file",
          ].includes(params.name)
        )
          params.arguments = { ...args, path: scopedPath(args.path) };
        else if (["shell_exec", "process_exec"].includes(params.name))
          params.arguments = { ...args, cwd: scopedPath(args.cwd) };
      }
      body = JSON.stringify(payload);
    } catch {
      return Response.json(
        { error: "Invalid workspace request" },
        { status: 400 },
      );
    }
  }
  const release = beginAgentConversationSandboxAccess(target.sandboxId);
  let timer: NodeJS.Timeout | undefined;
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    release();
  };
  try {
    const stream = req.method === "GET" && path.at(-1) === "stream";
    const upstream = await fetch(
      `http://127.0.0.1:${target.port}${targetPath}`,
      {
        method: req.method,
        headers: {
          accept: req.headers.get("accept") ?? "*/*",
          ...(body !== undefined
            ? {
                "content-type":
                  req.headers.get("content-type") ?? "application/json",
              }
            : {}),
        },
        body,
        cache: "no-store",
        signal: stream
          ? req.signal
          : AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      },
    );
    const reader = upstream.body?.getReader();
    if (stream && reader) {
      let checking = false;
      const revalidate = async () => {
        if (checking || released) return;
        checking = true;
        try {
          const current = await resolve();
          if (
            current?.sandboxId === target.sandboxId &&
            current.port === target.port &&
            current.workspaceRoot === target.workspaceRoot
          )
            return;
        } catch {
          // Authorization or mapping failures revoke the existing stream too.
        } finally {
          checking = false;
        }
        if (released) return;
        await reader.cancel().catch(() => undefined);
        done();
      };
      timer = setInterval(() => void revalidate(), 15_000);
      timer.unref?.();
    }
    const responseBody = reader
      ? new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                done();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              done();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              done();
            }
          },
        })
      : null;
    if (!reader) done();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        ...(stream
          ? {
              "cache-control": "no-cache, no-transform",
              "x-accel-buffering": "no",
            }
          : {}),
      },
    });
  } catch {
    done();
    return Response.json(
      { error: "Conversation workspace is unreachable" },
      { status: 502 },
    );
  }
}
