import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_TIMEOUT_SECONDS = 300;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const INTERRUPT_GRACE_MS = 1000;
const MESSAGES = {
  EVAL_INPUT_INVALID: "Invalid eval cell parameters.",
  EVAL_PYTHON_UNAVAILABLE:
    "Python 3 is not available in this sandbox. Install python3 in the sandbox image to use Python eval.",
  EVAL_KERNEL_UNAVAILABLE: "The eval kernel could not be started.",
  EVAL_KERNEL_EXITED:
    "The eval kernel exited. Its state is unavailable and will be reset on the next cell.",
  EVAL_KERNEL_PROTOCOL:
    "The eval kernel returned an invalid response. Its state has been reset.",
  EVAL_KERNEL_RESET:
    "The previous eval kernel is unavailable (host restart, kernel exit, or idle collection). Its variables have been reset.",
  EVAL_CODE_FAILED:
    "The cell raised an exception. Variables assigned before the exception may still exist.",
  EVAL_TIMEOUT:
    "The cell exceeded its timeout and was interrupted. Variables assigned before interruption may still exist.",
  EVAL_ABORTED:
    "The cell was aborted. Variables assigned before interruption may still exist.",
  EVAL_INTERRUPT_RESET:
    "The kernel did not stop after interruption and was terminated. Its variables have been reset.",
  EVAL_BUSY: "Another cell is already executing in this session and language.",
};

// One self-contained module is materialized by the optional-tools loader. The
// runners need only Python's standard library or the sandbox host's Node binary.
const PYTHON_RUNNER = String.raw`
import ast, asyncio, builtins, json, os, reprlib, signal, sys
send_fd = os.fdopen(3, "w", buffering=1)
wire_json = json.dumps
wire_write = send_fd.write
wire_flush = send_fd.flush
def send(value):
    wire_write(wire_json(value, ensure_ascii=True) + "\n")
    wire_flush()
limit = 51200
remaining = limit
truncated = False
running = False
class Output:
    encoding = "utf-8"
    errors = "replace"
    def write(self, text):
        global remaining, truncated
        text = str(text)
        if remaining <= 0:
            truncated = truncated or bool(text)
            return len(text)
        data = text.encode("utf-8", "replace")
        clipped = data[:remaining]
        truncated = truncated or len(data) > remaining
        remaining -= len(clipped)
        send({"type": "output", "text": clipped.decode("utf-8", "replace")})
        return len(text)
    def flush(self):
        pass
    def isatty(self):
        return False
def interrupt(_signal, _frame):
    if running:
        raise KeyboardInterrupt()
def no_input(*_args, **_kwargs):
    raise RuntimeError("Interactive stdin is unavailable")
signal.signal(signal.SIGINT, interrupt)
builtins.input = no_input
scope = {"__name__": "__main__", "__builtins__": builtins}
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
protocol_input = sys.stdin
sys.stdin = open(os.devnull)
sys.stdout = sys.stderr = Output()
send({"type": "ready"})
for line in protocol_input:
    cell = json.loads(line)
    remaining = limit
    truncated = False
    running = True
    reason = None
    try:
        tree = ast.parse(cell["code"], filename="<eval>", mode="exec")
        expression = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
        value = eval(compile(tree, "<eval>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), scope)
        if asyncio.iscoroutine(value):
            loop.run_until_complete(value)
        if expression is not None:
            value = eval(compile(expression, "<eval>", "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), scope)
            if asyncio.iscoroutine(value):
                value = loop.run_until_complete(value)
            if value is not None:
                print(reprlib.repr(value))
    except KeyboardInterrupt:
        reason = "EVAL_ABORTED"
    except BaseException:
        reason = "EVAL_CODE_FAILED"
    finally:
        running = False
        # Background tasks must not mutate retained state after a finished cell.
        tasks = asyncio.all_tasks(loop)
        for task in tasks:
            task.cancel()
        if tasks:
            loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
    send({"type": "done", "reason": reason, "truncated": truncated})
`;

function javascriptRunner() {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const util = require("node:util");
  const readline = require("node:readline");
  const { createRequire } = require("node:module");
  let remaining = 51200;
  let truncated = false;
  const send = (value) => fs.writeSync(3, `${JSON.stringify(value)}\n`);
  const output = (...values) => {
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const text = `${util.formatWithOptions(
      {
        depth: 4,
        maxArrayLength: 100,
        maxStringLength: 10000,
        getters: false,
      },
      ...values,
    )}\n`;
    const data = Buffer.from(text);
    const clipped = data.subarray(0, remaining);
    truncated ||= data.length > remaining;
    remaining -= clipped.length;
    send({ type: "output", text: clipped.toString("utf8") });
  };
  const context = vm.createContext({
    console: {
      log: output,
      info: output,
      warn: output,
      error: output,
      dir: output,
    },
    print: output,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    require: createRequire(`${process.cwd()}/eval-cell.cjs`),
  });
  // breakOnSigint temporarily takes over this handler during synchronous code.
  // An uninterruptible native call or pending promise is killed by the parent.
  process.on("SIGINT", () => {});
  const input = readline.createInterface({ input: process.stdin });
  send({ type: "ready" });
  input.on("line", async (line) => {
    const cell = JSON.parse(line);
    remaining = 51200;
    truncated = false;
    let reason;
    try {
      // The parent owns the deadline for both synchronous and async work.
      // A second VM deadline can finish the cell before its SIGINT arrives,
      // allowing that stale signal to interrupt the next cell instead.
      const script = new vm.Script(cell.code, { filename: "<eval>" });
      const value = await script.runInContext(context, {
        breakOnSigint: true,
      });
      if (value !== undefined) output(value);
    } catch (error) {
      reason =
        error?.code === "ERR_SCRIPT_EXECUTION_INTERRUPTED"
          ? "EVAL_ABORTED"
          : "EVAL_CODE_FAILED";
    }
    send({ type: "done", reason, truncated });
  });
  input.on("close", () => process.exit(0));
}

function toolResult(language, output = "", reason, extra = {}) {
  const details = {
    language,
    output,
    ...(reason ? { reason, isError: true } : {}),
    ...extra,
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...details,
          ...(reason ? { message: MESSAGES[reason] } : {}),
        }),
      },
    ],
    details,
    ...(reason ? { isError: true } : {}),
  };
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* Process already exited. */
    }
  }
}

function createKernel(language, cwd) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const child = spawn(
    language === "python" ? "python3" : process.execPath,
    language === "python"
      ? ["-u", "-B", "-c", PYTHON_RUNNER]
      : ["-e", `(${javascriptRunner.toString()})()`],
    { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  let pending;
  let dead = false;
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let idle;
  let protocol = "";
  const kernel = {
    child,
    ready,
    get dead() {
      return dead;
    },
    get busy() {
      return Boolean(pending);
    },
    stop(reason = "EVAL_KERNEL_EXITED") {
      if (dead) return;
      dead = true;
      clearTimeout(idle);
      killGroup(child, "SIGKILL");
      readyResolve(reason);
      pending?.finish(reason, { stateReset: true });
    },
    async run(code, timeoutMs, signal) {
      if (pending) return toolResult(language, "", "EVAL_BUSY");
      clearTimeout(idle);
      return new Promise((resolve) => {
        const chunks = [];
        let bytes = 0;
        let truncated = false;
        let interrupted;
        let grace;
        let timeout;
        const collect = (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const available = Math.max(0, MAX_OUTPUT_BYTES - bytes);
          if (data.length > available) truncated = true;
          if (available) {
            const clipped = data.subarray(0, available);
            chunks.push(clipped);
            bytes += clipped.length;
          }
        };
        const finish = (reason, extra = {}) => {
          if (!pending) return;
          pending = undefined;
          clearTimeout(timeout);
          clearTimeout(grace);
          signal?.removeEventListener("abort", abort);
          if (!dead) {
            idle = setTimeout(() => kernel.stop(), IDLE_TIMEOUT_MS);
            idle.unref();
          }
          resolve(
            toolResult(
              language,
              new StringDecoder("utf8").write(Buffer.concat(chunks)),
              interrupted ?? reason,
              {
                ...(interrupted && extra.stateReset
                  ? { notice: MESSAGES.EVAL_INTERRUPT_RESET }
                  : {}),
                ...extra,
                truncated: truncated || extra.truncated === true,
              },
            ),
          );
        };
        const interrupt = (reason) => {
          if (interrupted || !pending) return;
          interrupted = reason;
          killGroup(child, "SIGINT");
          grace = setTimeout(() => kernel.stop(reason), INTERRUPT_GRACE_MS);
        };
        const abort = () => interrupt("EVAL_ABORTED");
        pending = { finish, collect };
        signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => interrupt("EVAL_TIMEOUT"), timeoutMs);
        if (signal?.aborted) abort();
        if (!interrupted) child.stdin.write(`${JSON.stringify({ code })}\n`);
      });
    },
    complete(message) {
      pending?.finish(message.reason, {
        truncated: message.truncated === true,
      });
    },
  };
  // Pipes are drained even after the retained output budget is exhausted.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => pending?.collect(chunk));
  child.stderr.on("data", (chunk) => pending?.collect(chunk));
  child.stdin.on("error", () => kernel.stop());
  child.stdio[3].setEncoding("utf8");
  child.stdio[3].on("data", (chunk) => {
    protocol += chunk;
    if (protocol.length > 512 * 1024)
      return kernel.stop("EVAL_KERNEL_PROTOCOL");
    while (true) {
      const newline = protocol.indexOf("\n");
      if (newline < 0) break;
      const line = protocol.slice(0, newline);
      protocol = protocol.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") readyResolve();
        else if (message.type === "output" && typeof message.text === "string")
          pending?.collect(message.text);
        else if (message.type === "done") {
          if (
            message.reason &&
            !["EVAL_TIMEOUT", "EVAL_ABORTED", "EVAL_CODE_FAILED"].includes(
              message.reason,
            )
          )
            return kernel.stop("EVAL_KERNEL_PROTOCOL");
          kernel.complete(message);
        } else return kernel.stop("EVAL_KERNEL_PROTOCOL");
      } catch {
        return kernel.stop("EVAL_KERNEL_PROTOCOL");
      }
    }
  });
  child.on("error", (error) =>
    kernel.stop(
      language === "python" && error.code === "ENOENT"
        ? "EVAL_PYTHON_UNAVAILABLE"
        : "EVAL_KERNEL_UNAVAILABLE",
    ),
  );
  child.on("exit", () => kernel.stop());
  return kernel;
}

export default function evalExtension(pi) {
  const kernels = new Map();
  const stopAll = () => {
    for (const entry of kernels.values()) entry.kernel?.stop();
    process.removeListener("exit", stopAll);
  };
  pi.on("session_shutdown", stopAll);
  process.once("exit", stopAll);
  pi.registerTool({
    name: "eval",
    label: "Eval",
    description:
      "Execute one Python or JavaScript cell in a retained sandbox kernel. Variables persist between calls in the same session and language. reset recreates only that language. Default timeout 30 seconds; maximum 300 seconds. Idle kernels are collected after 15 minutes. Output is capped at 50 KiB. Python supports top-level await; JavaScript uses Node vm script syntax (use require for modules and return a Promise for asynchronous work). A reset or restart loses variables and cannot undo filesystem side effects. This has the same sandbox execution authority as bash; the VM is not a security boundary.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["language", "code"],
      properties: {
        language: { type: "string", enum: ["python", "javascript"] },
        code: { type: "string", maxLength: MAX_CODE_BYTES },
        reset: { type: "boolean" },
        timeoutSeconds: {
          type: "number",
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
        },
      },
    },
    async execute(_id, args, signal, _update, ctx) {
      const language = args?.language;
      if (
        !["python", "javascript"].includes(language) ||
        typeof args.code !== "string" ||
        Buffer.byteLength(args.code) > MAX_CODE_BYTES ||
        (args.reset !== undefined && typeof args.reset !== "boolean") ||
        (args.timeoutSeconds !== undefined &&
          (!Number.isFinite(args.timeoutSeconds) ||
            args.timeoutSeconds < 1 ||
            args.timeoutSeconds > MAX_TIMEOUT_SECONDS))
      )
        return toolResult(language, "", "EVAL_INPUT_INVALID");
      if (signal?.aborted) return toolResult(language, "", "EVAL_ABORTED");
      let cwd;
      try {
        cwd = realpathSync(ctx.cwd);
      } catch {
        return toolResult(language, "", "EVAL_KERNEL_UNAVAILABLE");
      }
      const key = JSON.stringify([
        cwd,
        ctx.sessionManager.getSessionId(),
        language,
      ]);
      let entry = kernels.get(key);
      if (entry?.kernel?.busy) return toolResult(language, "", "EVAL_BUSY");
      if (args.reset) entry?.kernel?.stop();
      let stateReset = false;
      if (!entry?.kernel || entry.kernel.dead) {
        const priorCell =
          entry ||
          ctx.sessionManager
            .getBranch()
            .some(
              (item) =>
                item.type === "message" &&
                item.message.role === "toolResult" &&
                item.message.toolName === "eval" &&
                item.message.details?.language === language,
            );
        stateReset = !args.reset && Boolean(priorCell);
        entry = {};
        kernels.set(key, entry);
        entry.kernel = createKernel(language, cwd);
      }
      const kernel = entry.kernel;
      let startupTimer;
      const abortStartup = () => kernel.stop("EVAL_ABORTED");
      signal?.addEventListener("abort", abortStartup, { once: true });
      if (signal?.aborted) abortStartup();
      const startup = await Promise.race([
        kernel.ready,
        new Promise((resolve) => {
          startupTimer = setTimeout(() => {
            kernel.stop("EVAL_KERNEL_UNAVAILABLE");
            resolve("EVAL_KERNEL_UNAVAILABLE");
          }, 5000);
        }),
      ]);
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", abortStartup);
      if (startup) return toolResult(language, "", startup);
      if (kernel.dead)
        return toolResult(language, "", "EVAL_KERNEL_EXITED", {
          stateReset: true,
        });
      const result = await kernel.run(
        args.code,
        Math.ceil((args.timeoutSeconds ?? 30) * 1000),
        signal,
      );
      if (stateReset || args.reset) {
        result.details.stateReset = true;
        if (stateReset && !result.details.notice)
          result.details.notice = MESSAGES.EVAL_KERNEL_RESET;
        result.content[0].text = JSON.stringify({
          ...result.details,
          ...(result.details.reason
            ? { message: MESSAGES[result.details.reason] }
            : {}),
        });
      }
      return result;
    },
  });
}
