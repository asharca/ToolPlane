import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";

// Native Pi SDK stays alive between turns; console output is never a protocol channel.
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, "utf8"));
if (input.kind !== "pi-sdk") throw new Error("AGENT_RUNTIME_RETIRED");
const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(input.statePath).digest("hex").slice(0, 32)}.sock`;

if (process.argv[3] === "serve") await serve();
else await request();

async function request() {
  let launched = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let connected = false;
      let restart = false;
      let output = "";
      socket.once("connect", () => {
        connected = true;
        socket.write(`${JSON.stringify(input)}\n`);
      });
      socket.on("data", (data) => {
        output += data;
        while (true) {
          const index = output.indexOf("\n");
          if (index < 0) break;
          const line = output.slice(0, index);
          output = output.slice(index + 1);
          if (JSON.parse(line).type === "toolplane_session_restart")
            restart = true;
          else process.stdout.write(`${line}\n`);
        }
      });
      socket.once("error", (error) => {
        if (connected) reject(error);
        else if (error.code === "ECONNREFUSED")
          void unlink(socketPath)
            .catch(() => {})
            .then(() => resolve("missing"));
        else resolve("missing");
      });
      socket.once("end", () => resolve(restart ? "restart" : "done"));
      const abort = () => {
        socket.destroy();
        process.exit(1);
      };
      process.once("SIGTERM", abort);
      socket.once("close", () => process.removeListener("SIGTERM", abort));
    });
    if (result === "done") return;
    if (result === "restart") {
      launched = false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!launched) {
      const child = spawn(
        process.execPath,
        // Keep the driver's sandbox node flags (V8 pool) for the resident broker.
        [...process.execArgv, process.argv[1], inputPath, "serve"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      launched = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native runtime session did not start.");
}

async function serve() {
  let child, active, sdkRequestId, idle;
  let activeRunId;
  const controls = new Map();
  let buffer = "",
    stopping = false;
  const send = (event) => active?.write(`${JSON.stringify(event)}\n`);
  const fail = (code) => {
    if (!active || !sdkRequestId) return;
    send({
      type: "toolplane_sdk_response",
      id: sdkRequestId,
      success: false,
      error: { code, message: code },
    });
    sdkRequestId = undefined;
  };
  const server = createServer((socket) => {
    let requestBuffer = "";
    socket.on("error", () => {});
    socket.on("data", async (data) => {
      requestBuffer += data;
      if (Buffer.byteLength(requestBuffer) > 4 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      const newline = requestBuffer.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      try {
        const job = JSON.parse(requestBuffer.slice(0, newline));
        if (job.control) {
          if (
            !active ||
            !child ||
            job.runId !== activeRunId ||
            job.kind !== "pi-sdk" ||
            job.signature !== input.signature ||
            job.statePath !== input.statePath ||
            job.cwd !== input.cwd
          ) {
            socket.end(
              `${JSON.stringify({ type: "toolplane_sdk_response", success: false, error: { code: "PI_SDK_QUEUE_NOT_RUNNING", message: "PI_SDK_QUEUE_NOT_RUNNING" } })}\n`,
            );
            return;
          }
          if (
            !["steer", "follow_up", "clear_queue"].includes(job.control.type)
          ) {
            socket.end(
              `${JSON.stringify({ type: "toolplane_sdk_response", success: false, error: { code: "PI_SDK_QUEUE_INVALID", message: "PI_SDK_QUEUE_INVALID" } })}\n`,
            );
            return;
          }
          const id = randomUUID();
          controls.set(id, socket);
          socket.once("close", () => controls.delete(id));
          child.stdin.write(`${JSON.stringify({ ...job.control, id })}\n`);
          return;
        }
        if (active) {
          socket.end(
            `${JSON.stringify({ type: "toolplane_sdk_response", success: false, error: { code: "PI_SDK_BUSY", message: "PI_SDK_BUSY" } })}\n`,
          );
          return;
        }
        active = socket;
        sdkRequestId = randomUUID();
        activeRunId = job.runId;
        clearTimeout(idle);
        if (
          job.kind !== "pi-sdk" ||
          job.signature !== input.signature ||
          job.statePath !== input.statePath ||
          job.cwd !== input.cwd
        ) {
          send({ type: "toolplane_session_restart" });
          await stop();
          return;
        }
        if (!child) start();
        const args = job.command?.match(/^\/compact(?:\s+([\s\S]*))?$/);
        child.stdin.write(
          `${JSON.stringify({ id: sdkRequestId, type: job.type === "fork" ? "fork" : args ? "compact" : "prompt", ...(job.type === "fork" ? { entryId: job.entryId, target: job.target } : args ? { customInstructions: args[1] } : { message: job.command || job.message }), navigateBeforeEntryId: job.navigateBeforeEntryId, context: job.context })}\n`,
        );
      } catch {
        fail("PI_SDK_RUNTIME_FAILED");
        await stop();
      }
    });
    socket.on("close", () => {
      if (active === socket) void stop();
    });
  });
  function start() {
    child = spawn(input.binary, [...input.args], {
      cwd: input.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    // Extension console output is discarded, never parsed as broker protocol.
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (!stopping) {
        fail("PI_SDK_RUNTIME_FAILED");
        void stop();
      }
    });
    child.stdio[3].on("data", (chunk) => {
      if (stopping) return;
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
          fail("PI_SDK_PROTOCOL_INVALID");
          void stop();
          return;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          fail("PI_SDK_PROTOCOL_INVALID");
          void stop();
          return;
        }
        if (event.type !== "toolplane_sdk_response") {
          // Tool events, including patch/truncated/firstChangedLine, are forwarded
          // intact; only SDK response results use the whitelist below.
          if (active) send(event);
          continue;
        }
        const controlSocket = controls.get(event.id);
        if (!controlSocket && (!active || event.id !== sdkRequestId)) continue;
        const result = event.result && {
          text: event.result.text,
          commands: event.result.commands,
          ...(event.result.usage ? { usage: event.result.usage } : {}),
          ...(event.result.sessionEntries
            ? { sessionEntries: event.result.sessionEntries }
            : {}),
          ...(event.result.fork ? { fork: event.result.fork } : {}),
          ...(event.result.actualModel
            ? { actualModel: event.result.actualModel }
            : {}),
          ...(event.result.contextBreakdown
            ? { contextBreakdown: event.result.contextBreakdown }
            : {}),
          ...(event.result.streamRuleTriggers
            ? { streamRuleTriggers: event.result.streamRuleTriggers }
            : {}),
          ...(event.result.commandResult
            ? { commandResult: event.result.commandResult }
            : {}),
          ...(event.result.disposition
            ? { disposition: event.result.disposition }
            : {}),
          ...(event.result.queue ? { queue: event.result.queue } : {}),
        };
        const code = /^PI_[A-Z0-9_]{1,80}$/.test(event.error?.code)
          ? event.error.code
          : "PI_SDK_RUNTIME_FAILED";
        const reason =
          /^(HTTP_[1-5]\d\d|UNREACHABLE|TIMEOUT|EMPTY_STREAM|STREAM_INCOMPLETE|CONTENT_FILTER|PROVIDER_ERROR)( RETRIED_\d{1,2})?$/.test(
            event.error?.reason,
          )
            ? event.error.reason
            : undefined;
        if (controlSocket) {
          controls.delete(event.id);
          controlSocket.end(
            `${JSON.stringify({
              type: event.type,
              id: event.id,
              success: event.success === true,
              ...(event.success === true
                ? { result }
                : { error: { code, message: code } }),
            })}\n`,
          );
          continue;
        }
        // Tool discovery runs before the model request. Reload the persisted
        // session with fresh definitions instead of failing this user's turn.
        if (!event.success && code === "PI_SDK_TOOLSET_CHANGED") {
          send({ type: "toolplane_session_restart" });
          void stop();
          return;
        }
        send({
          type: event.type,
          id: event.id,
          success: event.success === true,
          ...(event.success === true
            ? { result }
            : {
                error: { code, message: code, ...(reason ? { reason } : {}) },
                ...(result
                  ? {
                      result: {
                        ...(event.result?.usage
                          ? { usage: event.result.usage }
                          : {}),
                        ...(event.result?.actualModel
                          ? { actualModel: event.result.actualModel }
                          : {}),
                        ...(event.result?.streamRuleTriggers
                          ? {
                              streamRuleTriggers:
                                event.result.streamRuleTriggers,
                            }
                          : {}),
                        ...(event.result?.sessionEntries
                          ? { sessionEntries: event.result.sessionEntries }
                          : {}),
                      },
                    }
                  : {}),
              }),
        });
        const socket = active;
        active = undefined;
        sdkRequestId = undefined;
        activeRunId = undefined;
        socket.end();
        idle = setTimeout(stop, 120000);
      }
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        fail("PI_SDK_PROTOCOL_INVALID");
        void stop();
      }
    });
    child.once("error", () => {
      fail("PI_SDK_RUNTIME_FAILED");
      void stop();
    });
    child.once("exit", () => {
      if (!stopping) fail("PI_SDK_RUNTIME_EXITED");
      void stop();
    });
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    if (child?.pid) {
      child.stdin.write(
        `${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`,
      );
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    active?.end();
    for (const socket of controls.values()) socket.end();
    controls.clear();
    active = undefined;
    server.close();
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  }
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") process.exit(0);
    else throw error;
  });
  server.listen(socketPath, () => {
    void chmod(socketPath, 0o600);
  });
  process.on("SIGTERM", stop);
}
