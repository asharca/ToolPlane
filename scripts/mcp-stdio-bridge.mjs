// Bridges a stdio MCP server (spawned from MCP_COMMAND/MCP_ARGS) to the HTTP
// JSON-RPC surface the rest of the app speaks. Holds ONE persistent stdio
// connection, performs the MCP initialize handshake once, then forwards each
// incoming HTTP JSON-RPC request onto that connection (remapping ids so
// concurrent callers cannot collide). Prints LISTENING <port> once ready,
// mirroring scripts/mcp-server.mjs so the supervisor/gateway are unchanged.
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { spawnWorkspaceProcess } from "./mcp-workspace-stdio.mjs";
import { closeSessions, sessionHttp } from "./mcp-session-http.mjs";
import { buildBridgeChildEnv } from "./bridge-env.mjs";
import {
  expandMcpArguments,
  secretEnvironmentLine,
  withSecretEnvironmentBootstrap,
} from "./mcp-secret-bootstrap.mjs";

const NAME = process.env.MCP_NAME || "mcp";
const COMMAND = process.env.MCP_COMMAND;
let ARGS = [];
try {
  ARGS = JSON.parse(process.env.MCP_ARGS || "[]");
  if (!Array.isArray(ARGS)) throw new Error("MCP_ARGS must be a JSON array");
} catch (error) {
  process.stderr.write(
    "mcp-stdio-bridge: invalid MCP_ARGS: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
}
const PROTOCOL_VERSION = "2025-06-18";
// Callers set the effective per-deployment deadline (up to 300s, see
// src/lib/process/mcp-tool-timeout.ts); this only bounds an abandoned call.
const CALL_TIMEOUT_MS = 300000;
const DEFAULT_STARTUP_IDLE_TIMEOUT_MS = 90000;
const DEFAULT_STARTUP_MAX_TIMEOUT_MS = 300000;
const CONTAINER_POLL_MS = 1000;
const DOCKER_INSPECT_TIMEOUT_MS = 5000;
const CONTAINER_TERMINAL_STATES = new Set(["dead", "exited", "removing"]);

function positiveTimeout(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const STARTUP_IDLE_TIMEOUT_MS = positiveTimeout(
  "MCP_STARTUP_IDLE_TIMEOUT_MS",
  DEFAULT_STARTUP_IDLE_TIMEOUT_MS,
);
const STARTUP_MAX_TIMEOUT_MS = positiveTimeout(
  "MCP_STARTUP_MAX_TIMEOUT_MS",
  DEFAULT_STARTUP_MAX_TIMEOUT_MS,
);
const CONTAINER_NAME = (process.env.MCP_CONTAINER_NAME || "").trim();
const MCP_IMAGE = (process.env.MCP_IMAGE || "").trim();
const RUNTIME_EVENT_TOKEN = (process.env.MCP_RUNTIME_EVENT_TOKEN || "").trim();
const workspaceTransport =
  process.env.MCP_WORKSPACE_TRANSPORT &&
  JSON.parse(process.env.MCP_WORKSPACE_TRANSPORT);
delete process.env.MCP_WORKSPACE_TRANSPORT;
const IS_DOCKER_BRIDGE =
  !workspaceTransport && /(?:^|[\\/])docker(?:\.exe)?$/i.test(COMMAND || "");
const IS_MANAGED_DOCKER_BRIDGE = IS_DOCKER_BRIDGE && Boolean(CONTAINER_NAME);

if (!COMMAND) {
  process.stderr.write("mcp-stdio-bridge: MCP_COMMAND is required\n");
  process.exitCode = 1;
}

// The Docker CLI receives only its connection allowlist. Configured values
// travel on stdin after container creation, never Docker Config.Env.
let childEnv = {};
let runtimeEnv = {};
let runtimeEnvironmentLine = "";
let sessionCommand;
let supportsTrackedExec;
try {
  childEnv = buildBridgeChildEnv(process.env, "{}");
  runtimeEnv = buildBridgeChildEnv({}, process.env.MCP_CHILD_ENV);
  delete process.env.MCP_CHILD_ENV;
} catch (error) {
  process.stderr.write(
    "mcp-stdio-bridge: " +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
}

function runtimePhase(phase, details = {}) {
  const event = { type: "phase", phase };
  if (RUNTIME_EVENT_TOKEN) event.token = RUNTIME_EVENT_TOKEN;
  if (details.containerState) event.containerState = details.containerState;
  if (details.imageState) event.imageState = details.imageState;
  if (details.message) event.message = details.message;
  process.stderr.write(`[toolplane-runtime] ${JSON.stringify(event)}\n`);
}

function startupFailure(message, details = {}) {
  const error = new Error(message);
  error.runtimeDetails = details;
  return error;
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

function detailsFor(error) {
  if (
    error &&
    typeof error === "object" &&
    error.runtimeDetails &&
    typeof error.runtimeDetails === "object"
  ) {
    return error.runtimeDetails;
  }
  return {};
}

// Startup has both a hard ceiling and an inactivity deadline. Docker pull
// output, image/container state changes, and the transition into initialize
// refresh the inactivity deadline. This prevents a slow but progressing pull
// from being treated as a fixed initialize timeout, while still guaranteeing a
// finite failure when Docker or the MCP gets stuck.
function createStartupWatchdog(idleTimeoutMs, maxTimeoutMs) {
  let done = false;
  let failure = null;
  let idleTimer = null;
  let maxTimer = null;
  const failureListeners = new Set();
  let rejectAborted;
  const aborted = new Promise((_resolve, reject) => {
    rejectAborted = reject;
  });
  // A timer may fire between awaits. Keep the rejection observed until the
  // active startup operation races it.
  void aborted.catch(() => {});

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    idleTimer = null;
    maxTimer = null;
  };

  const fail = (error) => {
    if (done) return false;
    done = true;
    failure = error;
    clearTimers();
    for (const listener of failureListeners) listener(error);
    failureListeners.clear();
    rejectAborted(error);
    return true;
  };

  const progress = () => {
    if (done) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      fail(
        startupFailure(
          `startup idle timeout after ${idleTimeoutMs}ms without progress`,
        ),
      );
    }, idleTimeoutMs);
  };

  maxTimer = setTimeout(() => {
    fail(startupFailure(`startup maximum timeout after ${maxTimeoutMs}ms`));
  }, maxTimeoutMs);
  progress();

  return {
    progress,
    fail,
    abort() {
      fail(startupFailure("startup cancelled"));
    },
    complete() {
      if (done) return;
      done = true;
      clearTimers();
      failureListeners.clear();
    },
    race(promise) {
      return Promise.race([promise, aborted]);
    },
    onFailure(listener) {
      if (failure) {
        queueMicrotask(() => listener(failure));
        return () => {};
      }
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
  };
}

function runDockerCli(
  args,
  { timeoutMs = DOCKER_INSPECT_TIMEOUT_MS, progress } = {},
) {
  return new Promise((resolve) => {
    let cli;
    let stdout = "";
    let settled = false;
    let timer = null;

    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, error });
    };

    try {
      cli = spawn(COMMAND, args, {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, messageFor(error));
      return;
    }

    cli.stdout.on("data", (chunk) => {
      progress?.();
      stdout += chunk.toString();
    });
    // Docker diagnostic output is intentionally not copied into lifecycle
    // events. The actual MCP container stderr is captured from the run child.
    cli.stderr.on("data", () => progress?.());
    cli.once("error", (error) => finish(null, messageFor(error)));
    cli.once("close", (code) => finish(code));
    timer = setTimeout(() => {
      try {
        cli.kill("SIGTERM");
      } catch {
        // The inspect command may already have exited.
      }
      finish(null, "docker inspect timed out");
    }, timeoutMs);
  });
}

async function imageStatus(image) {
  const result = await runDockerCli([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  if (result.code === 0) return "cached";
  if (result.code === 1) return "missing";
  return "unknown";
}

async function containerStatus(name) {
  const result = await runDockerCli([
    "inspect",
    "--format",
    "{{.State.Status}}",
    name,
  ]);
  if (result.code !== 0) return null;
  const state = result.stdout.trim().split(/\s+/)[0];
  return state || null;
}

let child = null;
let nextId = 1;
const pending = new Map();
let buffer = "";
let initResult = null;
let bridgeReady = false;
let shuttingDown = false;
let childTerminationReported = false;
let startupWatchdog = null;
let exitRequested = false;

function rejectPending(error) {
  for (const [id, request] of pending) {
    pending.delete(id);
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
  }
}

function callChild(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer = null;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
    }
    pending.set(id, { resolve, reject, timer });
    try {
      if (!child?.stdin?.writable) {
        throw new Error("MCP child stdin is unavailable");
      }
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    } catch (error) {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(error);
    }
  });
}

function notifyChild(method, params) {
  if (!child?.stdin?.writable) {
    throw new Error("MCP child stdin is unavailable");
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function handshake() {
  // Initialization is bounded by the startup watchdog, not CALL_TIMEOUT_MS,
  // which applies only to the calls forwarded below.
  const reply = await callChild(
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "toolplane-bridge", version: "1.0.0" },
    },
    null,
  );
  if (reply.error) {
    throw startupFailure(
      `initialize failed: ${reply.error.message || "MCP returned an error"}`,
    );
  }
  if (!reply.result) {
    throw startupFailure("initialize failed: MCP returned no result");
  }
  initResult = reply.result;
  notifyChild("notifications/initialized", {});
}

function childFailure(watchdog, error, details = {}) {
  if (childTerminationReported || shuttingDown) return;
  childTerminationReported = true;
  const message = messageFor(error);
  process.stderr.write(`mcp-stdio-bridge: ${message}\n`);

  if (!bridgeReady) {
    watchdog.fail(startupFailure(message, details));
    return;
  }

  runtimePhase("error", { ...details, message });
  requestExit(1);
}

function attachChildListeners(watchdog) {
  child.stdout.on("data", (chunk) => {
    // MCP stdout is exclusively JSON-RPC. Parse it, but never copy it into
    // process logs: it can contain tool arguments and tool results.
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const request = pending.get(msg.id);
        pending.delete(msg.id);
        if (request.timer) clearTimeout(request.timer);
        request.resolve(msg);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    // Pull/install output is startup progress. Preserve it for the supervisor
    // to capture, but deliberately never mirror the MCP's stdout.
    watchdog.progress();
    process.stderr.write(chunk);
  });

  child.stdin.on("error", (error) => {
    childFailure(watchdog, error, {
      ...(IS_MANAGED_DOCKER_BRIDGE ? { containerState: "exited" } : {}),
    });
  });
  child.once("error", (error) => {
    childFailure(
      watchdog,
      startupFailure(`spawn failed: ${messageFor(error)}`),
      {
        ...(IS_MANAGED_DOCKER_BRIDGE ? { containerState: "exited" } : {}),
      },
    );
  });
  child.once("exit", (code, signal) => {
    if (childTerminationReported || shuttingDown) return;
    childTerminationReported = true;
    const suffix = signal ? `signal ${signal}` : String(code);
    const message = `child exited (${suffix})`;
    process.stderr.write(`mcp-stdio-bridge: ${message}\n`);
    const details = {
      ...(IS_MANAGED_DOCKER_BRIDGE ? { containerState: "exited" } : {}),
      message,
    };

    if (!bridgeReady) {
      watchdog.fail(startupFailure(message, details));
      return;
    }

    runtimePhase(code === 0 ? "stopped" : "error", details);
    requestExit(code === 0 ? 0 : 1);
  });
}

function launchChild(watchdog) {
  try {
    child = workspaceTransport
      ? spawnWorkspaceProcess(
          workspaceTransport,
          COMMAND,
          ARGS,
          runtimeEnv,
          childEnv,
        )
      : spawn(COMMAND, ARGS, {
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
  } catch (error) {
    throw startupFailure(`spawn failed: ${messageFor(error)}`);
  }
  attachChildListeners(watchdog);
  if (runtimeEnvironmentLine) {
    child.stdin.write(runtimeEnvironmentLine);
    runtimeEnvironmentLine = "";
  }
}

function waitForContainerRunning(watchdog, imageState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let lastState = null;
    let unsubscribe = () => {};

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };

    unsubscribe = watchdog.onFailure((error) => finish(error));

    const poll = async () => {
      if (settled) return;
      const state = await containerStatus(CONTAINER_NAME);
      if (settled) return;

      if (state && state !== lastState) {
        lastState = state;
        watchdog.progress();

        if (CONTAINER_TERMINAL_STATES.has(state)) {
          finish(
            startupFailure("container exited before MCP initialization", {
              containerState: state,
              ...(imageState ? { imageState } : {}),
            }),
          );
          return;
        }

        if (state === "running") {
          runtimePhase("initializing", {
            containerState: state,
            ...(imageState ? { imageState } : {}),
          });
          finish();
          return;
        }

        runtimePhase(
          state === "created" ? "starting-container" : "waiting-for-container",
          {
            containerState: state,
            ...(imageState ? { imageState } : {}),
          },
        );
      }

      timer = setTimeout(poll, CONTAINER_POLL_MS);
    };

    void poll();
  });
}

async function openStdioSession({ onmessage, onclose }) {
  if (!bridgeReady || shuttingDown)
    throw new Error("MCP_TRANSPORT_UNAVAILABLE");
  let proc;
  let sessionContainer;
  const target =
    workspaceTransport ||
    (IS_MANAGED_DOCKER_BRIDGE && { kind: "docker", container: CONTAINER_NAME });
  if (target) {
    if (!workspaceTransport && supportsTrackedExec === undefined) {
      const probe = await runDockerCli([
        "exec",
        CONTAINER_NAME,
        "sh",
        "-c",
        "command -v setsid && command -v mkfifo && command -v mktemp && command -v cat",
      ]);
      supportsTrackedExec = probe.code === 0;
    }
    if (!workspaceTransport && !supportsTrackedExec) {
      // Shell-free Docker images cannot use our exec supervisor. Create a
      // sibling with the same hardening, pinned image and work/config mounts.
      // Joining the primary's PID namespace ties its lifetime to the server.
      const inspected = await runDockerCli([
        "inspect",
        "--format",
        "{{.Image}}",
        CONTAINER_NAME,
      ]);
      const digest = inspected.stdout.trim();
      if (shuttingDown || !/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      const args = ARGS.slice(1);
      const image = args.indexOf(sessionCommand ? digest : MCP_IMAGE);
      if (image < 0) throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      const flags = args.slice(0, image);
      const name = flags.indexOf("--name");
      if (name < 0) throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      flags.splice(name, 2);
      const pid = flags.indexOf("--pid");
      if (pid >= 0) flags.splice(pid, 2);
      const created = await runDockerCli([
        "create",
        ...flags,
        "--pid",
        `container:${CONTAINER_NAME}`,
        digest,
        ...args.slice(image + 1),
      ]);
      sessionContainer = created.stdout.trim();
      if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(sessionContainer))
        throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      if (shuttingDown) {
        await runDockerCli(["rm", "-f", sessionContainer]);
        throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      }
      proc = spawn(COMMAND, ["start", "-ai", sessionContainer], {
        env: childEnv,
        stdio: "pipe",
      });
      if (sessionCommand && Object.keys(runtimeEnv).length)
        proc.stdin.write(
          secretEnvironmentLine(runtimeEnv, [
            sessionCommand[0],
            ...expandMcpArguments(sessionCommand.slice(1), runtimeEnv),
          ]),
        );
    } else {
      if (!workspaceTransport && !sessionCommand) {
        // Use the running container's resolved image entrypoint + CMD, including
        // distroless/custom entrypoints not present in the deployment document.
        const result = await runDockerCli([
          "inspect",
          "--format",
          "{{json .Path}}{{println}}{{json .Args}}",
          CONTAINER_NAME,
        ]);
        if (result.code !== 0) throw new Error("MCP_TRANSPORT_UNAVAILABLE");
        const [command, args] = result.stdout
          .trim()
          .split("\n")
          .map((v) => JSON.parse(v));
        sessionCommand = [command, ...args];
      }
      if (shuttingDown) throw new Error("MCP_TRANSPORT_UNAVAILABLE");
      const [command, ...args] = workspaceTransport
        ? [COMMAND, ...ARGS]
        : sessionCommand;
      proc = spawnWorkspaceProcess(target, command, args, runtimeEnv, childEnv);
    }
  } else {
    if (IS_DOCKER_BRIDGE) throw new Error("MCP_TRANSPORT_UNAVAILABLE");
    proc = spawn(COMMAND, ARGS, { env: childEnv, stdio: "pipe" });
  }
  let closed = false;
  const finished = new Promise((resolve) =>
    proc.once("close", () => {
      closed = true;
      resolve();
      onclose();
    }),
  );
  const close = async () => {
    if (!closed) {
      proc.stdin.end();
      if (!target) proc.kill("SIGTERM");
    }
    if (sessionContainer)
      await runDockerCli(["rm", "--force", sessionContainer]);
    await finished;
  };
  proc.stdin.on("error", () => {
    void close();
  });
  proc.stderr.resume();
  proc.stdout.setEncoding("utf8");
  let buffer = "";
  proc.stdout.on("data", (text) => {
    buffer += text;
    try {
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        if (i > 4_000_000) throw new Error();
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) onmessage(JSON.parse(line));
      }
      if (buffer.length > 4_000_000) throw new Error();
    } catch {
      void close();
    }
  });
  await once(proc, "spawn");
  return {
    close,
    send: (msg) =>
      new Promise((resolve, reject) =>
        proc.stdin.write(JSON.stringify(msg) + "\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  };
}

// --- HTTP surface (mirrors scripts/mcp-server.mjs) ---
const server = http.createServer((req, res) => {
  if (req.url === "/session") {
    void sessionHttp(req, res, openStdioSession);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: NAME }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", async () => {
    let msg;
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }
    // Notifications: nothing to forward, no response body.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    // The child is already initialized; answer initialize from our stored result.
    if (msg.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: initResult }),
      );
      return;
    }
    try {
      const reply = await callChild(msg.method, msg.params);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...reply, id: msg.id }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: messageFor(error) },
        }),
      );
    }
  });
});

function stopChild() {
  try {
    if (workspaceTransport) child?.stdin.end();
    else if (child && IS_MANAGED_DOCKER_BRIDGE) {
      child.stdin.end();
      // docker run proxies SIGTERM to PID 1; a server may legally ignore it.
      // The named container (not its CLI process) owns all its stdio sessions.
      void runDockerCli(["rm", "--force", CONTAINER_NAME]).finally(() =>
        child?.kill("SIGTERM"),
      );
    } else child?.kill("SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

function requestExit(code) {
  if (exitRequested) {
    if (code !== 0) process.exitCode = code;
    return;
  }
  exitRequested = true;
  shuttingDown = true;
  // Reject any in-flight image inspect/container poll race. Merely clearing
  // its timers would let a resolved diagnostic await continue and launch a
  // child after SIGTERM.
  startupWatchdog?.abort();
  rejectPending(new Error("MCP bridge is shutting down"));
  void closeSessions();
  stopChild();
  // Setting exitCode lets Node flush stderr and close the child stdio pipes.
  // Calling process.exit() here loses exactly the final diagnostics needed to
  // understand a failed MCP startup.
  process.exitCode = code;
  if (server.listening) server.close(() => {});
}

const shutdown = () => requestExit(0);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function startBridge() {
  startupWatchdog = createStartupWatchdog(
    STARTUP_IDLE_TIMEOUT_MS,
    STARTUP_MAX_TIMEOUT_MS,
  );
  let imageState = null;

  try {
    if (IS_DOCKER_BRIDGE && MCP_IMAGE) {
      runtimePhase("preparing-image", {
        imageState: "checking",
        message: "Checking Docker image availability.",
      });
      startupWatchdog.progress();
      const availability = await startupWatchdog.race(imageStatus(MCP_IMAGE));
      if (shuttingDown) return;
      if (availability === "cached") {
        imageState = "cached";
        runtimePhase("preparing-image", {
          imageState,
          message: "Docker image is cached.",
        });
      } else if (availability === "missing") {
        imageState = "pulling";
        runtimePhase("pulling-image", {
          imageState,
          message: "Docker image will be pulled while starting the container.",
        });
      } else {
        imageState = "unknown";
        runtimePhase("preparing-image", {
          imageState,
          message:
            "Could not determine image cache state; starting the container.",
        });
      }
      startupWatchdog.progress();
    }

    if (IS_DOCKER_BRIDGE && Object.keys(runtimeEnv).length) {
      if (!MCP_IMAGE)
        throw startupFailure(
          "MCP runtime image is required for credential delivery.",
        );
      const dockerOptions = ARGS.slice(0, ARGS.indexOf(MCP_IMAGE, 1));
      const forcePull = dockerOptions.some(
        (arg, index) =>
          arg === "--pull=always" ||
          (arg === "--pull" && dockerOptions[index + 1] === "always"),
      );
      if (imageState === "pulling" || forcePull) {
        const pulled = await startupWatchdog.race(
          runDockerCli(["pull", MCP_IMAGE], {
            timeoutMs: STARTUP_MAX_TIMEOUT_MS,
            progress: () => startupWatchdog.progress(),
          }),
        );
        if (pulled.code !== 0)
          throw startupFailure("MCP runtime image pull failed.");
      }
      const inspected = await startupWatchdog.race(
        runDockerCli(["image", "inspect", "--format", "{{json .}}", MCP_IMAGE]),
      );
      if (inspected.code !== 0)
        throw startupFailure("MCP runtime image inspection failed.");
      let metadata;
      try {
        metadata = JSON.parse(inspected.stdout);
      } catch {
        throw startupFailure("MCP runtime image metadata is invalid.");
      }
      if (!/^sha256:[a-f0-9]{64}$/i.test(metadata?.Id) || !metadata.Config) {
        throw startupFailure("MCP runtime image metadata is invalid.");
      }
      ARGS = withSecretEnvironmentBootstrap(ARGS, MCP_IMAGE, metadata.Config);
      // Pin the inspected image so tag drift cannot change its exec contract.
      ARGS[ARGS.indexOf(MCP_IMAGE, 1)] = metadata.Id;
      sessionCommand = ARGS.slice(
        ARGS.indexOf("toolplane-mcp", ARGS.indexOf(metadata.Id, 1)) + 1,
      );
      runtimeEnvironmentLine = secretEnvironmentLine(runtimeEnv, [
        sessionCommand[0],
        ...expandMcpArguments(sessionCommand.slice(1), runtimeEnv),
      ]);
    } else if (!IS_DOCKER_BRIDGE && !workspaceTransport) {
      childEnv = { ...childEnv, ...runtimeEnv };
      runtimeEnv = {};
    }

    runtimePhase("starting-container", {
      ...(imageState ? { imageState } : {}),
    });
    startupWatchdog.progress();
    if (shuttingDown) return;
    launchChild(startupWatchdog);

    if (IS_MANAGED_DOCKER_BRIDGE) {
      runtimePhase("waiting-for-container", {
        containerState: "not-created",
        ...(imageState ? { imageState } : {}),
      });
      await startupWatchdog.race(
        waitForContainerRunning(startupWatchdog, imageState),
      );
      if (shuttingDown) return;
    } else {
      runtimePhase("initializing", {
        ...(imageState ? { imageState } : {}),
      });
      startupWatchdog.progress();
    }

    await startupWatchdog.race(handshake());
    if (shuttingDown) return;
    bridgeReady = true;
    startupWatchdog.complete();
    runtimePhase("ready", {
      ...(IS_MANAGED_DOCKER_BRIDGE ? { containerState: "running" } : {}),
      ...(imageState ? { imageState } : {}),
    });

    server.listen(Number(process.env.MCP_PORT || 0), "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      process.stdout.write(`LISTENING ${port}\n`);
    });
  } catch (error) {
    if (shuttingDown) return;
    startupWatchdog.complete();
    const details = detailsFor(error);
    runtimePhase("error", { ...details, message: messageFor(error) });
    process.stderr.write(
      `mcp-stdio-bridge: startup failed: ${messageFor(error)}\n`,
    );
    requestExit(1);
  }
}

if (COMMAND && process.exitCode !== 1) void startBridge();
