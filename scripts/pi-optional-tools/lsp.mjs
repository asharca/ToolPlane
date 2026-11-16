import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const MAX_FILE = 1024 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_RESULT = 64 * 1024;
const IDLE_MS = 5 * 60 * 1000;
const failure = (code) => Object.assign(new Error(code), { code });
const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
const languages = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
};

// Resolve symlinks before scope checks, then refuse devices/FIFOs and bounded-read
// through a no-follow descriptor. Native bash is not a separate security domain.
async function readDocument(path, roots) {
  if (!roots.some((root) => within(root, path)))
    throw failure("LSP_PATH_DENIED");
  const actual = await realpath(path).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw failure("LSP_FILE_NOT_FOUND");
    throw error;
  });
  if (!roots.some((root) => within(root, actual)))
    throw failure("LSP_PATH_DENIED");
  const file = await open(
    actual,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw failure("LSP_FILE_INVALID");
    if (info.size > MAX_FILE) throw failure("LSP_FILE_TOO_LARGE");
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE) throw failure("LSP_FILE_TOO_LARGE");
    return {
      path: actual,
      uri: pathToFileURL(actual).href,
      text: bytes.toString("utf8", 0, size),
    };
  } finally {
    await file.close();
  }
}

class LanguageServer {
  constructor(root, language, paths, onStop) {
    this.root = root;
    this.language = language;
    this.paths = paths;
    this.onStop = onStop;
    this.pending = new Map();
    this.documents = new Map();
    this.diagnostics = new Map();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.queue = Promise.resolve();
    const entry =
      language === "python"
        ? join(paths.packageRoot, "node_modules/pyright/langserver.index.js")
        : join(
            paths.packageRoot,
            "node_modules/typescript-language-server/lib/cli.mjs",
          );
    // Dedicated process group includes the TypeScript server's own children.
    const env = { ...process.env };
    env.PYTHONDONTWRITEBYTECODE = "1";
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    delete env.NODE_OPTIONS;
    this.child = spawn(process.execPath, [entry, "--stdio"], {
      cwd: root,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdin.on("error", () => this.stop("LSP_SERVER_EXITED"));
    this.child.on("error", () => this.stop("LSP_SERVER_UNAVAILABLE"));
    this.child.on("exit", () => this.stop("LSP_SERVER_EXITED"));
    this.child.stdout.on("data", (bytes) => {
      try {
        this.consume(bytes);
      } catch {
        this.stop("LSP_PROTOCOL_INVALID");
      }
    });
    this.touch();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop("LSP_SERVER_IDLE"), IDLE_MS);
    this.idle.unref();
  }

  stop(code = "LSP_SERVER_EXITED") {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idle);
    for (const entry of this.pending.values()) entry.reject(failure(code));
    this.pending.clear();
    this.documents.clear();
    this.diagnostics.clear();
    const kill = (signal) => {
      try {
        if (this.child.pid) process.kill(-this.child.pid, signal);
      } catch {
        /* Already reaped. */
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1000);
    timer.unref();
    this.onStop();
  }

  send(message) {
    if (this.stopped) throw failure("LSP_SERVER_EXITED");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params, signal) {
    signal.throwIfAborted();
    const {
      promise,
      resolve: resolveRequest,
      reject: rejectRequest,
    } = Promise.withResolvers();
    const id = ++this.nextId;
    const finish = (callback, value) => {
      this.pending.delete(id);
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      try {
        this.notify("$/cancelRequest", { id });
      } catch {
        /* Process stopped. */
      }
      finish(rejectRequest, signal.reason);
    };
    this.pending.set(id, {
      resolve: (value) => finish(resolveRequest, value),
      reject: (error) => finish(rejectRequest, error),
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.send({ id, method, params });
    } catch (error) {
      finish(rejectRequest, error);
    }
    return promise;
  }

  consume(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > 8192) throw failure("LSP_PROTOCOL_INVALID");
        return;
      }
      const match = /^Content-Length: (\d+)$/im.exec(
        this.buffer.toString("ascii", 0, end),
      );
      const length = Number(match?.[1]);
      if (
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        length > MAX_FRAME ||
        end > 8192
      )
        throw failure("LSP_PROTOCOL_INVALID");
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(
        this.buffer.toString("utf8", end + 4, end + 4 + length),
      );
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method && message.id !== undefined) {
        // Read-only client: no server initiated edits or command execution.
        if (message.method === "workspace/configuration") {
          this.send({
            id: message.id,
            result: (message.params?.items ?? []).map((item) =>
              item.section === "python"
                ? {
                    analysis: {
                      diagnosticMode: "openFilesOnly",
                      autoSearchPaths: false,
                    },
                  }
                : {},
            ),
          });
        } else if (message.method === "workspace/workspaceFolders") {
          this.send({
            id: message.id,
            result: [{ uri: pathToFileURL(this.root).href, name: "session" }],
          });
        } else if (message.method === "workspace/applyEdit") {
          this.send({
            id: message.id,
            result: { applied: false, failureReason: "Read-only LSP tool" },
          });
        } else if (
          [
            "client/registerCapability",
            "client/unregisterCapability",
            "window/workDoneProgress/create",
          ].includes(message.method)
        ) {
          this.send({ id: message.id, result: null });
        } else
          this.send({
            id: message.id,
            error: { code: -32601, message: "Unsupported client method" },
          });
      } else if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params;
        const document = this.documents.get(params?.uri);
        if (
          document &&
          (params.version === undefined || params.version === document.version)
        ) {
          this.diagnostics.set(params.uri, {
            items: params.diagnostics ?? [],
            at: Date.now(),
          });
        }
      } else if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (message.error) pending?.reject(failure("LSP_REQUEST_FAILED"));
        else pending?.resolve(message.result);
      }
    }
  }

  async initialize(signal) {
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [
          { uri: pathToFileURL(this.root).href, name: "session" },
        ],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            definition: { linkSupport: true },
          },
        },
        initializationOptions:
          this.language === "python"
            ? {}
            : {
                disableAutomaticTypingAcquisition: true,
                tsserver: {
                  path: join(
                    this.paths.packageRoot,
                    "node_modules/typescript/lib/tsserver.js",
                  ),
                  fallbackPath: join(
                    this.paths.packageRoot,
                    "node_modules/typescript/lib/tsserver.js",
                  ),
                  useSyntaxServer: "never",
                },
                preferences: { includePackageJsonAutoImports: "off" },
              },
      },
      signal,
    );
    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", {
      settings: {
        python: {
          analysis: { diagnosticMode: "openFilesOnly", autoSearchPaths: false },
        },
      },
    });
    this.initialized = true;
  }

  async sync(document, roots, force = false) {
    // Reconcile all previously opened files so navigation reflects bash/edit/write.
    for (const [uri, previous] of this.documents) {
      if (uri === document.uri) continue;
      try {
        const current = await readDocument(previous.path, roots);
        if (current.uri !== uri) throw failure("LSP_PATH_DENIED");
        if (current.text !== previous.text) this.update(current);
      } catch {
        this.notify("textDocument/didClose", { textDocument: { uri } });
        this.documents.delete(uri);
        this.diagnostics.delete(uri);
      }
    }
    if (!this.documents.has(document.uri) && this.documents.size >= 32) {
      const uri = this.documents.keys().next().value;
      this.notify("textDocument/didClose", { textDocument: { uri } });
      this.documents.delete(uri);
      this.diagnostics.delete(uri);
    }
    const previous = this.documents.get(document.uri);
    if (!previous || force || previous.text !== document.text)
      this.update(document);
  }

  update(document) {
    const previous = this.documents.get(document.uri);
    const version = (previous?.version ?? 0) + 1;
    this.diagnostics.delete(document.uri);
    this.documents.set(document.uri, { ...document, version });
    if (previous) {
      this.notify("textDocument/didChange", {
        textDocument: { uri: document.uri, version },
        contentChanges: [{ text: document.text }],
      });
    } else {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId: languages[extname(document.path)],
          version,
          text: document.text,
        },
      });
    }
  }

  async diagnosticResult(uri, signal) {
    if (this.capabilities.diagnosticProvider) {
      const result = await this.request(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        signal,
      );
      if (result?.kind !== "full") throw failure("LSP_DIAGNOSTICS_UNAVAILABLE");
      return result.items ?? [];
    }
    // A real fresh publish is required: no response is never a clean bill of health.
    // Let TypeScript's syntax/semantic publications settle before returning.
    for (;;) {
      signal.throwIfAborted();
      if (this.stopped) throw failure("LSP_SERVER_EXITED");
      const result = this.diagnostics.get(uri);
      if (result && Date.now() - result.at >= 750) return result.items;
      await delay(50, undefined, { signal });
    }
  }
}

async function locations(result, roots, signal) {
  const output = [];
  let omitted = 0;
  for (const item of result == null
    ? []
    : Array.isArray(result)
      ? result
      : [result]) {
    signal?.throwIfAborted();
    if (output.length >= 200) {
      omitted++;
      continue;
    }
    try {
      const path = await realpath(fileURLToPath(item.targetUri ?? item.uri));
      if (!roots.some((root) => within(root, path))) {
        omitted++;
        continue;
      }
      output.push({
        file: path,
        range: item.targetSelectionRange ?? item.targetRange ?? item.range,
      });
    } catch {
      omitted++;
    }
  }
  return { locations: output, omitted };
}

function resultContent(data) {
  let text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_RESULT) {
    const key = ["diagnostics", "locations", "symbols"].find((name) =>
      Array.isArray(data[name]),
    );
    if (key) {
      let removed = 0;
      while (data[key].length && Buffer.byteLength(text) > MAX_RESULT) {
        data[key].pop();
        removed++;
        text = JSON.stringify({
          ...data,
          truncated: true,
          omitted: (data.omitted ?? 0) + removed,
        });
      }
    }
    if (Buffer.byteLength(text) > MAX_RESULT)
      text = JSON.stringify({
        action: data.action,
        success: true,
        truncated: true,
        preview: Buffer.from(text)
          .subarray(0, MAX_RESULT - 512)
          .toString("utf8"),
      });
    // JSON escaping in preview can enlarge it; fall back to a bounded scalar.
    if (Buffer.byteLength(text) > MAX_RESULT)
      text = JSON.stringify({
        action: data.action,
        success: true,
        truncated: true,
        reason: "LSP_RESULT_TOO_LARGE",
      });
  }
  return {
    content: [{ type: "text", text }],
    details: {
      action: data.action,
      success: data.success,
      reason: data.reason,
    },
  };
}

export default function lspExtension(pi) {
  const clients = new Map();
  const stop = () => {
    for (const client of clients.values()) client.stop();
  };
  process.once("exit", stop);
  pi.on("session_shutdown", () => {
    stop();
    process.removeListener("exit", stop);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "lsp" || !event.isError) return;
    const reason = event.content?.find((item) => item.type === "text")?.text;
    if (!/^LSP_[A-Z_]+$/.test(reason ?? "")) return;
    const pathStatus =
      reason === "LSP_FILE_NOT_FOUND"
        ? "NOT_FOUND"
        : reason === "LSP_PATH_DENIED"
          ? "OUTSIDE_SESSION_SCOPE"
          : reason === "LSP_FILE_INVALID"
            ? "NOT_REGULAR_FILE"
            : undefined;
    const details = {
      success: false,
      reason,
      ...(pathStatus ? { pathStatus } : {}),
    };
    return {
      isError: true,
      details,
      content: [{ type: "text", text: JSON.stringify(details) }],
    };
  });
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "Read-only TypeScript/JavaScript and Python language intelligence in this session workspace. Relative file paths resolve from the session cwd, not a previous bash command's cd; use a cwd-relative subdirectory or an accessible absolute path for files elsewhere. Diagnostics return errors, warnings, information, and unspecified severities; hints (severity 4) are omitted. Positions use 1-based line and UTF-16 column. No project commands, edits, plugins, package installs or network downloads are run by this tool.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "file"],
      properties: {
        action: {
          type: "string",
          enum: ["diagnostics", "definition", "references", "hover", "symbols"],
        },
        file: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description:
            "Path relative to the session cwd, or an absolute path within the session workspace or shared directory.",
        },
        line: { type: "integer", minimum: 1 },
        col: { type: "integer", minimum: 1 },
        timeout: {
          type: "integer",
          minimum: 5,
          maximum: 120,
          description: "Total call timeout in seconds (default 30).",
        },
      },
    },
    async execute(_id, args, signal) {
      let client;
      const seconds =
        Number.isInteger(args.timeout) &&
        args.timeout >= 5 &&
        args.timeout <= 120
          ? args.timeout
          : 30;
      const timeout = AbortSignal.timeout(seconds * 1000);
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        if (
          ![
            "diagnostics",
            "definition",
            "references",
            "hover",
            "symbols",
          ].includes(args.action) ||
          typeof args.file !== "string" ||
          !args.file ||
          args.file.length > 4096 ||
          (args.timeout !== undefined &&
            (!Number.isInteger(args.timeout) ||
              args.timeout < 5 ||
              args.timeout > 120))
        )
          throw failure("LSP_INPUT_INVALID");
        const paths =
          globalThis[Symbol.for("toolplane.pi.host-context.v1")]?.lsp;
        if (!paths?.packageRoot || !isAbsolute(paths.cwd ?? ""))
          throw failure("LSP_SERVER_UNAVAILABLE");
        // The host supplies the same cwd used to create the native session.
        // SDK execution-context overrides must not select a different file root.
        const root = await realpath(paths.cwd);
        const roots = [root];
        if (paths.sharedDir) roots.push(await realpath(paths.sharedDir));
        const document = await readDocument(resolve(root, args.file), roots);
        const languageId = languages[extname(document.path)];
        if (!languageId) throw failure("LSP_LANGUAGE_UNSUPPORTED");
        const language = languageId === "python" ? "python" : "typescript";
        const key = `${root}\0${language}`;
        client = clients.get(key);
        if (!client) {
          client = new LanguageServer(root, language, paths, () =>
            clients.delete(key),
          );
          clients.set(key, client);
        }
        const operation = client.queue.then(async () => {
          deadline.throwIfAborted();
          client.touch();
          if (!client.initialized) await client.initialize(deadline);
          const current = await readDocument(resolve(root, args.file), roots);
          if (current.uri !== document.uri) throw failure("LSP_PATH_DENIED");
          document.text = current.text;
          await client.sync(document, roots, args.action === "diagnostics");
          const textDocument = { uri: document.uri };
          let data;
          if (args.action === "diagnostics") {
            data = {
              diagnostics: (
                await client.diagnosticResult(document.uri, deadline)
              ).filter((diagnostic) => diagnostic.severity !== 4),
            };
          } else if (args.action === "symbols") {
            const symbols = await client.request(
              "textDocument/documentSymbol",
              { textDocument },
              deadline,
            );
            // SymbolInformation carries locations; never leak an out-of-scope URI.
            const safe = [];
            for (const symbol of (symbols ?? []).slice(0, 200)) {
              if (
                !symbol.location ||
                (await locations(symbol.location, roots, deadline)).locations
                  .length
              )
                safe.push(symbol);
            }
            data = {
              symbols: safe,
              omitted: Math.max(0, (symbols?.length ?? 0) - safe.length),
            };
          } else {
            if (
              !Number.isInteger(args.line) ||
              !Number.isInteger(args.col) ||
              args.line < 1 ||
              args.col < 1
            )
              throw failure("LSP_POSITION_INVALID");
            const lines = document.text.split("\n");
            if (
              args.line > lines.length ||
              args.col > lines[args.line - 1].replace(/\r$/, "").length + 1
            )
              throw failure("LSP_POSITION_INVALID");
            const value = await client.request(
              `textDocument/${args.action}`,
              {
                textDocument,
                position: { line: args.line - 1, character: args.col - 1 },
                ...(args.action === "references"
                  ? { context: { includeDeclaration: true } }
                  : {}),
              },
              deadline,
            );
            data =
              args.action === "hover"
                ? { hover: value }
                : await locations(value, roots, deadline);
          }
          deadline.throwIfAborted();
          client.touch();
          return resultContent({
            action: args.action,
            success: true,
            server: language,
            file: document.path,
            ...data,
          });
        });
        client.queue = operation.catch(() => {});
        // Covers queueing, startup, synchronization, and diagnostics waits too.
        const {
          promise,
          resolve: resolveResult,
          reject: rejectResult,
        } = Promise.withResolvers();
        const abort = () => rejectResult(deadline.reason);
        deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
        operation
          .then(resolveResult, rejectResult)
          .finally(() => deadline.removeEventListener("abort", abort));
        return await promise;
      } catch (error) {
        if (deadline.aborted) client?.stop("LSP_TIMEOUT");
        if (client && !client.initialized)
          client.stop("LSP_SERVER_UNAVAILABLE");
        if (signal?.aborted) throw signal.reason;
        const allowed = new Set([
          "LSP_PATH_DENIED",
          "LSP_FILE_INVALID",
          "LSP_FILE_TOO_LARGE",
          "LSP_LANGUAGE_UNSUPPORTED",
          "LSP_INPUT_INVALID",
          "LSP_POSITION_INVALID",
          "LSP_FILE_NOT_FOUND",
          "LSP_SERVER_UNAVAILABLE",
          "LSP_SERVER_EXITED",
          "LSP_PROTOCOL_INVALID",
          "LSP_REQUEST_FAILED",
          "LSP_DIAGNOSTICS_UNAVAILABLE",
        ]);
        const reason = timeout.aborted
          ? "LSP_TIMEOUT"
          : allowed.has(error?.code)
            ? error.code
            : "LSP_FILE_UNAVAILABLE";
        // Throw only fixed safe text: Pi records a failed tool result, not a failed turn.
        throw failure(reason);
      }
    },
  });
}
