import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter, once } from "node:events";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const OUTPUT_BYTES = 64 * 1024;
const WIRE_BYTES = 1024 * 1024;
const SESSION_MS = 300_000;
const errors = {
  DEBUG_INVALID_ARGUMENT: "Invalid debug action arguments.",
  DEBUG_SESSION_ACTIVE:
    "Terminate the current debug session before launching another.",
  DEBUG_SESSION_MISSING: "Launch a debug session first.",
  DEBUG_NOT_STOPPED: "The debuggee is not paused.",
  DEBUG_DEPENDENCY_MISSING:
    "The sandbox needs Python 3 and the bundled debugpy runtime.",
  DEBUG_REQUEST_FAILED: "The debugger could not complete this action.",
  DEBUG_TIMEOUT: "The debugger timed out and was terminated.",
  DEBUG_ABORTED: "The debug session was cancelled and terminated.",
  DEBUG_OUTPUT_LIMIT: "The debugger protocol message exceeded its size limit.",
};
const fail = (code) => {
  throw Object.assign(new Error(`${code}: ${errors[code]}`), { code });
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8192 &&
  !value.includes("\0");

function installDebugpy() {
  const host = dirname(fileURLToPath(import.meta.url));
  const artifactPath = join(host, "debugpy.artifact.json");
  if (!existsSync(artifactPath)) fail("DEBUG_DEPENDENCY_MISSING");
  if (lstatSync(artifactPath).size > 12 * 1024 * 1024)
    fail("DEBUG_OUTPUT_LIMIT");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const bytes = Buffer.from(artifact.data, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || digest !== artifact.sha256)
    fail("DEBUG_DEPENDENCY_MISSING");
  const bundle = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 96 * 1024 * 1024 }).toString("utf8"),
  );
  if (
    bundle.version !== "1.8.17" ||
    !Array.isArray(bundle.files) ||
    bundle.files.length > 10_000
  )
    fail("DEBUG_DEPENDENCY_MISSING");
  const files = new Map();
  let total = 0;
  for (const file of bundle.files) {
    if (
      typeof file.path !== "string" ||
      !/^debugpy\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(file.path) ||
      file.path.split("/").some((part) => part === "." || part === "..") ||
      files.has(file.path)
    )
      fail("DEBUG_DEPENDENCY_MISSING");
    const content = Buffer.from(file.content, "base64");
    total += content.length;
    if (
      total > 64 * 1024 * 1024 ||
      createHash("sha256").update(content).digest("hex") !== file.sha256
    )
      fail("DEBUG_DEPENDENCY_MISSING");
    files.set(file.path, content);
  }
  if (!files.has("debugpy/adapter/__main__.py"))
    fail("DEBUG_DEPENDENCY_MISSING");
  const parent = join(host, ".toolplane-tools/debug");
  function directory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (realpathSync(path) !== path) fail("DEBUG_DEPENDENCY_MISSING");
  }
  directory(parent);
  const root = join(parent, digest);
  if (!existsSync(root)) {
    const stage = `${root}.install-${randomUUID()}`;
    try {
      directory(stage);
      for (const [path, content] of files) {
        directory(dirname(join(stage, path)));
        writeFileSync(join(stage, path), content, { flag: "wx", mode: 0o600 });
      }
      renameSync(stage, root);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  // Verify bytes and reject extra files; a disk marker is never authority.
  if (realpathSync(root) !== root) fail("DEBUG_DEPENDENCY_MISSING");
  function verify(path = "") {
    for (const name of readdirSync(join(root, path))) {
      const relative = path ? `${path}/${name}` : name;
      const absolute = join(root, relative);
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        verify(relative);
        continue;
      }
      const content = files.get(relative);
      if (
        !content ||
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== content.length ||
        realpathSync(absolute) !== absolute ||
        !readFileSync(absolute).equals(content)
      )
        fail("DEBUG_DEPENDENCY_MISSING");
      files.delete(relative);
    }
  }
  verify();
  if (files.size) fail("DEBUG_DEPENDENCY_MISSING");
  return root;
}

// Both protocols have bounded pending requests and a common disconnect path.
class Requests {
  constructor(send) {
    this.send = send;
    this.next = 1;
    this.pending = new Map();
  }
  request(command, args = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    const { promise, resolve, reject } = Promise.withResolvers();
    this.pending.set(id, { resolve, reject });
    try {
      this.send(id, command, args);
    } catch {
      this.close();
    }
    return promise;
  }
  response(id, result, failed) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (failed)
      pending?.reject(
        Object.assign(new Error(errors.DEBUG_REQUEST_FAILED), {
          code: "DEBUG_REQUEST_FAILED",
        }),
      );
    else pending?.resolve(result ?? {});
  }
  close(code = "DEBUG_REQUEST_FAILED") {
    this.closed = Object.assign(new Error(errors[code]), { code });
    for (const entry of this.pending.values()) entry.reject(this.closed);
    this.pending.clear();
  }
}

class DebugSession {
  constructor(language, cwd) {
    this.language = language;
    this.cwd = cwd;
    this.events = new EventEmitter();
    this.output = Buffer.alloc(0);
    this.outputTruncated = false;
    this.state = "starting";
    this.frames = [];
    this.references = new Map();
    this.nextReference = 1;
    this.breakpoints = new Map();
    this.children = new Set();
    this.lifetime = setTimeout(() => this.dispose(), SESSION_MS);
    this.lifetime.unref();
  }
  append(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.length + this.output.length > OUTPUT_BYTES)
      this.outputTruncated = true;
    this.output = Buffer.concat([
      this.output,
      bytes.subarray(-OUTPUT_BYTES),
    ]).subarray(-OUTPUT_BYTES);
  }
  change(state) {
    this.state = state;
    if (state !== "stopped") {
      this.frames = [];
      this.references.clear();
    }
    this.events.emit("state");
  }
  async until(predicate) {
    while (!predicate()) await once(this.events, "state");
  }
  child(command, args, env) {
    if (this.disposed) fail("DEBUG_ABORTED");
    const child = spawn(command, args, {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    child.on("error", () => {
      this.wire?.close("DEBUG_DEPENDENCY_MISSING");
      this.change("terminated");
    });
    child.stdin.on("error", () => this.wire?.close());
    child.on("exit", (code) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
      this.children.delete(child);
      this.exitCode = code;
      this.wire?.close();
      this.change("terminated");
    });
    return child;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.lifetime);
    this.wire?.close();
    this.socket?.close();
    if (this.debuggeePid) {
      try {
        process.kill(this.debuggeePid, "SIGKILL");
      } catch {
        /* already exited */
      }
      this.debuggeePid = undefined;
    }
    // Kill owned adapter/process groups as well as the DAP-reported debuggee;
    // some debugpy versions create an independent debuggee process group.
    for (const child of this.children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    this.children.clear();
    this.change("terminated");
  }
  async launch(program, args) {
    const env = {
      ...process.env,
      NODE_CHANNEL_FD: undefined,
      NODE_CHANNEL_SERIALIZATION_MODE: undefined,
    };
    if (this.language === "python") {
      const pythonPath = await installDebugpy();
      const child = this.child("python3", ["-u", "-m", "debugpy.adapter"], {
        ...env,
        PYTHONPATH: pythonPath,
        PYTHONDONTWRITEBYTECODE: "1",
        PYDEVD_USE_CYTHON: "NO",
        PYDEVD_USE_FRAME_EVAL: "NO",
      });
      this.wire = new Requests((seq, command, args) => {
        const body = Buffer.from(
          JSON.stringify({ seq, type: "request", command, arguments: args }),
        );
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      });
      let buffer = Buffer.alloc(0);
      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > WIRE_BYTES) {
          this.wire.close("DEBUG_OUTPUT_LIMIT");
          this.dispose();
          return;
        }
        try {
          while (true) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) break;
            const length = Number(
              /Content-Length:\s*(\d+)/i.exec(
                buffer.subarray(0, end).toString(),
              )?.[1],
            );
            if (
              !Number.isSafeInteger(length) ||
              length < 1 ||
              length > WIRE_BYTES
            )
              throw new Error();
            if (buffer.length < end + 4 + length) break;
            const message = JSON.parse(
              buffer.subarray(end + 4, end + 4 + length).toString(),
            );
            buffer = buffer.subarray(end + 4 + length);
            if (message.type === "response")
              this.wire.response(
                message.request_seq,
                message.body,
                !message.success,
              );
            else if (message.type === "event")
              this.dapEvent(message.event, message.body ?? {});
            else if (message.type === "request") {
              const response = JSON.stringify({
                seq: 0,
                type: "response",
                request_seq: message.seq,
                command: message.command,
                success: false,
                message: "Reverse requests are not supported.",
              });
              child.stdin.write(
                `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`,
              );
            }
          }
        } catch {
          this.dispose();
        }
      });
      child.stderr.on("data", (chunk) => this.append(chunk));
      await this.wire.request("initialize", {
        adapterID: "debugpy",
        clientID: "toolplane",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsRunInTerminalRequest: false,
      });
      const launching = this.wire.request("launch", {
        program,
        args,
        cwd: this.cwd,
        console: "internalConsole",
        stopOnEntry: true,
        justMyCode: false,
        subProcess: false,
      });
      // debugpy does not answer launch until configurationDone. Attach the
      // rejection handler immediately so an early adapter failure is observed.
      launching.catch(() => {});
      await this.until(() => this.initialized || this.state === "terminated");
      if (!this.initialized) fail("DEBUG_REQUEST_FAILED");
      await this.wire.request("configurationDone");
      await launching;
    } else {
      const child = this.child(
        process.execPath,
        ["--inspect-brk=127.0.0.1:0", program, ...args],
        { ...env, NODE_OPTIONS: undefined },
      );
      child.stdout.on("data", (chunk) => this.append(chunk));
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        this.append(chunk);
        diagnostic = (diagnostic + chunk.toString()).slice(-8192);
        const url = /ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/.exec(
          diagnostic,
        )?.[0];
        if (url && !this.inspectorUrl) {
          this.inspectorUrl = url;
          this.events.emit("state");
        }
        if (diagnostic.includes("Waiting for the debugger to disconnect")) {
          this.change("terminated");
          this.socket?.close();
        }
      });
      await this.until(() => this.inspectorUrl || this.state === "terminated");
      if (!this.inspectorUrl) fail("DEBUG_REQUEST_FAILED");
      const socket = new WebSocket(this.inspectorUrl);
      this.socket = socket;
      this.wire = new Requests((id, method, params) =>
        socket.send(JSON.stringify({ id, method, params })),
      );
      socket.addEventListener("message", (event) => {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > WIRE_BYTES
        ) {
          this.dispose();
          return;
        }
        try {
          const message = JSON.parse(event.data);
          if (message.id)
            this.wire.response(
              message.id,
              message.result,
              Boolean(message.error),
            );
          else if (message.method === "Debugger.paused") {
            this.frames = message.params.callFrames;
            this.references.clear();
            this.reason = message.params.reason;
            this.change("stopped");
          } else if (message.method === "Debugger.resumed")
            this.change("running");
        } catch {
          this.dispose();
        }
      });
      socket.addEventListener("close", () => {
        this.wire.close();
        this.change("terminated");
      });
      socket.addEventListener("error", () => {
        this.wire.close();
        this.change("terminated");
      });
      const opened = Promise.withResolvers();
      socket.addEventListener("open", opened.resolve, { once: true });
      socket.addEventListener("error", () => opened.reject(new Error()), {
        once: true,
      });
      await opened.promise;
      await this.wire.request("Runtime.enable");
      await this.wire.request("Debugger.enable");
      await this.wire.request("Runtime.runIfWaitingForDebugger");
    }
    await this.until(() => ["stopped", "terminated"].includes(this.state));
    return this.snapshot();
  }
  dapEvent(event, body) {
    if (event === "initialized") {
      this.initialized = true;
      this.events.emit("state");
    }
    if (event === "output") this.append(body.output ?? "");
    if (
      event === "process" &&
      integer(body.systemProcessId) &&
      body.systemProcessId > 1
    )
      this.debuggeePid = body.systemProcessId;
    if (event === "stopped") {
      this.threadId = body.threadId;
      this.reason = body.reason;
      this.change("stopped");
    }
    if (event === "continued") this.change("running");
    if (event === "exited") {
      this.exitCode = body.exitCode;
      this.debuggeePid = undefined;
    }
    if (event === "terminated") this.change("terminated");
  }
  snapshot() {
    return {
      language: this.language,
      state: this.state,
      reason: this.reason,
      exitCode: this.exitCode,
      output: this.output.toString("utf8"),
      outputTruncated: this.outputTruncated,
    };
  }
  reference(objectId) {
    if (!objectId) return 0;
    if (this.references.size >= 1024) fail("DEBUG_OUTPUT_LIMIT");
    const id = this.nextReference++;
    this.references.set(id, objectId);
    return id;
  }
  remote(value) {
    return {
      value: String(
        value?.description ?? value?.value ?? value?.type ?? "undefined",
      ).slice(0, 8192),
      type: value?.type,
      variablesReference: this.reference(value?.objectId),
    };
  }
  async stack() {
    if (this.language === "python")
      return (
        await this.wire.request("stackTrace", {
          threadId: this.threadId,
          startFrame: 0,
          levels: 100,
        })
      ).stackFrames;
    return this.frames.slice(0, 100).map((frame, id) => ({
      id,
      name: frame.functionName,
      source: { path: frame.url },
      line: frame.location.lineNumber + 1,
      column: frame.location.columnNumber + 1,
    }));
  }
  async action(params) {
    const { action } = params;
    if (action === "output") return this.snapshot();
    if (action === "set_breakpoints") {
      if (
        !text(params.file) ||
        !Array.isArray(params.lines) ||
        params.lines.length > 100 ||
        !params.lines.every((line) => integer(line) && line > 0)
      )
        fail("DEBUG_INVALID_ARGUMENT");
      const file = resolve(this.cwd, params.file);
      if (this.language === "python")
        return this.wire.request("setBreakpoints", {
          source: { path: file },
          breakpoints: params.lines.map((line) => ({ line })),
        });
      for (const id of this.breakpoints.get(file) ?? [])
        await this.wire.request("Debugger.removeBreakpoint", {
          breakpointId: id,
        });
      const ids = [];
      this.breakpoints.set(file, ids);
      const breakpoints = [];
      for (const line of params.lines) {
        const result = await this.wire.request("Debugger.setBreakpointByUrl", {
          url: pathToFileURL(file).href,
          lineNumber: line - 1,
        });
        ids.push(result.breakpointId);
        breakpoints.push({ line, verified: result.locations.length > 0 });
      }
      return { breakpoints };
    }
    if (this.state !== "stopped") fail("DEBUG_NOT_STOPPED");
    if (["continue", "step_over", "step_in", "step_out"].includes(action)) {
      const method =
        this.language === "python"
          ? {
              continue: "continue",
              step_over: "next",
              step_in: "stepIn",
              step_out: "stepOut",
            }[action]
          : {
              continue: "Debugger.resume",
              step_over: "Debugger.stepOver",
              step_in: "Debugger.stepInto",
              step_out: "Debugger.stepOut",
            }[action];
      this.change("running");
      await this.wire.request(
        method,
        this.language === "python" ? { threadId: this.threadId } : {},
      );
      await this.until(() => ["stopped", "terminated"].includes(this.state));
      return this.snapshot();
    }
    if (action === "stack") return { stackFrames: await this.stack() };
    if (action === "variables") {
      if (
        !integer(params.variables_reference) ||
        params.variables_reference === 0
      )
        fail("DEBUG_INVALID_ARGUMENT");
      if (this.language === "python")
        return this.wire.request("variables", {
          variablesReference: params.variables_reference,
          start: 0,
          count: 100,
        });
      const objectId = this.references.get(params.variables_reference);
      if (!objectId) fail("DEBUG_INVALID_ARGUMENT");
      const result = await this.wire.request("Runtime.getProperties", {
        objectId,
        ownProperties: true,
        generatePreview: false,
      });
      return {
        variables: result.result
          .slice(0, 100)
          .map((entry) => ({ name: entry.name, ...this.remote(entry.value) })),
      };
    }
    const frames = await this.stack();
    const frameId = params.frame_id ?? frames[0]?.id;
    if (!integer(frameId)) fail("DEBUG_INVALID_ARGUMENT");
    if (action === "scopes") {
      if (this.language === "python")
        return this.wire.request("scopes", { frameId });
      const frame = this.frames[frameId];
      if (!frame) fail("DEBUG_INVALID_ARGUMENT");
      return {
        scopes: frame.scopeChain.slice(0, 100).map((scope) => ({
          name: scope.type,
          variablesReference: this.reference(scope.object.objectId),
          expensive: scope.type === "global",
        })),
      };
    }
    if (action === "evaluate") {
      if (!text(params.expr)) fail("DEBUG_INVALID_ARGUMENT");
      if (this.language === "python")
        return this.wire.request("evaluate", {
          expression: params.expr,
          frameId,
          context: "repl",
        });
      const frame = this.frames[frameId];
      if (!frame) fail("DEBUG_INVALID_ARGUMENT");
      const result = await this.wire.request("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression: params.expr,
        generatePreview: false,
      });
      if (result.exceptionDetails) fail("DEBUG_REQUEST_FAILED");
      return { result: this.remote(result.result) };
    }
    fail("DEBUG_INVALID_ARGUMENT");
  }
}

export default function debugExtension(pi) {
  let session;
  let busy = false;
  const cleanup = () => {
    session?.dispose();
    session = undefined;
  };
  pi.on("agent_end", cleanup);
  const onTerm = () => {
    cleanup();
    process.kill(process.pid, "SIGTERM");
  };
  const onInterrupt = () => {
    cleanup();
    process.kill(process.pid, "SIGINT");
  };
  pi.on("session_shutdown", () => {
    cleanup();
    process.off("exit", cleanup);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  });
  // Preserve normal signal termination after synchronously killing our groups.
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInterrupt);
  process.once("exit", cleanup);
  pi.registerTool({
    name: "debug",
    label: "Debug",
    executionMode: "sequential",
    description:
      "Debug one sandbox Python or Node.js program. Launch pauses on entry; set_breakpoints replaces a file's 1-based lines (empty clears); continue/step waits for the next pause or exit. Read stack, scopes and variables or evaluate expr while paused. IDs expire after resume. The process is killed on timeout, cancellation, or end of this agent turn; it cannot be resumed in a later user turn. Python requires python3. Evaluation executes sandbox code.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "launch",
            "set_breakpoints",
            "continue",
            "step_over",
            "step_in",
            "step_out",
            "stack",
            "scopes",
            "variables",
            "evaluate",
            "output",
            "terminate",
          ],
        },
        program: { type: "string", minLength: 1, maxLength: 8192 },
        args: {
          type: "array",
          items: { type: "string", maxLength: 8192 },
          maxItems: 128,
        },
        language: { type: "string", enum: ["python", "node"] },
        file: { type: "string", minLength: 1, maxLength: 8192 },
        lines: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          maxItems: 100,
        },
        frame_id: { type: "integer", minimum: 0 },
        variables_reference: { type: "integer", minimum: 1 },
        expr: { type: "string", minLength: 1, maxLength: 8192 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
      },
    },
    async execute(_id, params, signal, _update, ctx) {
      if (busy) fail("DEBUG_SESSION_ACTIVE");
      busy = true;
      let timer;
      let onAbort;
      let cancelledCode;
      try {
        if (signal?.aborted) {
          cleanup();
          fail("DEBUG_ABORTED");
        }
        const timeout = params.timeout_ms ?? 15_000;
        if (!integer(timeout) || timeout < 1000 || timeout > 60_000)
          fail("DEBUG_INVALID_ARGUMENT");
        const cancelled = Promise.withResolvers();
        const stop = (code) => {
          cancelledCode = code;
          cancelled.reject(Object.assign(new Error(errors[code]), { code }));
          cleanup();
        };
        onAbort = () => stop("DEBUG_ABORTED");
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => stop("DEBUG_TIMEOUT"), timeout);
        const operation = async () => {
          if (params.action === "terminate") {
            cleanup();
            return { state: "terminated" };
          }
          if (params.action === "launch") {
            if (session && session.state !== "terminated")
              fail("DEBUG_SESSION_ACTIVE");
            if (
              !text(params.program) ||
              !["python", "node"].includes(params.language) ||
              (params.args !== undefined &&
                (!Array.isArray(params.args) ||
                  params.args.length > 128 ||
                  !params.args.every(
                    (arg) =>
                      typeof arg === "string" &&
                      arg.length <= 8192 &&
                      !arg.includes("\0"),
                  )))
            )
              fail("DEBUG_INVALID_ARGUMENT");
            const program = resolve(ctx.cwd, params.program);
            if (!(await stat(program).catch(() => undefined))?.isFile())
              fail("DEBUG_INVALID_ARGUMENT");
            if (cancelledCode) fail(cancelledCode);
            cleanup();
            session = new DebugSession(params.language, ctx.cwd);
            return session.launch(program, params.args ?? []);
          }
          if (!session) fail("DEBUG_SESSION_MISSING");
          const result = await session.action(params);
          return { ...session.snapshot(), ...result };
        };
        const result = await Promise.race([operation(), cancelled.promise]);
        const json = JSON.stringify(result);
        const bounded =
          Buffer.byteLength(json) <= OUTPUT_BYTES
            ? result
            : {
                state: session?.state,
                truncated: true,
                preview: Buffer.from(json)
                  .subarray(0, OUTPUT_BYTES / 2)
                  .toString("utf8"),
              };
        return {
          content: [{ type: "text", text: JSON.stringify(bounded) }],
          details: { action: params.action, ...bounded },
        };
      } catch (error) {
        // Argument/state errors are recoverable without losing a paused session.
        const code =
          cancelledCode ??
          (Object.hasOwn(errors, error?.code)
            ? error.code
            : "DEBUG_REQUEST_FAILED");
        if (
          ![
            "DEBUG_INVALID_ARGUMENT",
            "DEBUG_SESSION_ACTIVE",
            "DEBUG_SESSION_MISSING",
            "DEBUG_NOT_STOPPED",
          ].includes(code)
        )
          cleanup();
        fail(code);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        busy = false;
      }
    },
  });
}
