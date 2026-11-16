import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROWSER_IMAGE_BYTES = 150 * 1024;
const OUTPUT_CHARS = 16_000;
const COMMAND_MS = 15_000;
const IDLE_MS = 5 * 60_000;
const FRAME_BYTES = 2 * 1024 * 1024;
const MESSAGES = {
  BROWSER_CHROMIUM_MISSING:
    "Chromium is not installed in this sandbox image. Use the ToolPlane sandbox image containing Chromium.",
  BROWSER_LAUNCH_FAILED: "Chromium could not start in this sandbox.",
  BROWSER_RESOURCE_LIMIT:
    "Chromium exceeded the sandbox process, memory or CPU resource budget. Do not change sandbox system files; close unused processes or request a larger sandbox.",
  BROWSER_SUPERVISOR_MISSING:
    "The sandbox browser requires Python 3 for process supervision. Use the ToolPlane sandbox image.",
  BROWSER_NOT_OPEN: "Open a browser page before using this action.",
  BROWSER_INVALID_ARGUMENT: "The browser action or its arguments are invalid.",
  BROWSER_NETWORK_ISOLATED:
    "Sandbox networking is disabled (network=none); external browser requests are unavailable.",
  BROWSER_NAVIGATION_FAILED: "The browser could not load the requested page.",
  BROWSER_SELECTOR_NOT_FOUND: "No visible element matches the CSS selector.",
  BROWSER_EVALUATION_FAILED: "The page JavaScript could not be evaluated.",
  BROWSER_OUTPUT_LIMIT: "The browser result exceeds its output size limit.",
  BROWSER_TIMEOUT:
    "The browser action exceeded its time limit; the browser was closed. Open the page again.",
  BROWSER_ABORTED: "The browser action was cancelled; the browser was closed.",
  BROWSER_CLOSED: "The browser process closed. Open the page again.",
  BROWSER_ACTION_FAILED: "The browser action failed.",
};
class BrowserFailure extends Error {
  constructor(reason) {
    super(MESSAGES[reason]);
    this.reason = reason;
  }
}
const fail = (reason) => {
  throw new BrowserFailure(reason);
};
const textResult = (value, details = {}) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
  details,
});
const string = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

// Linux subreaper owns Chromium descendants even when crash handlers daemonize.
// Killing a whole group including its parent would strand zombies under sleep(1).
// Keep this supervisor alive until every descendant is killed AND waitpid-reaped.
const SUPERVISOR = String.raw`
import ctypes, math, os, signal, subprocess, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    sys.exit(70)
parent = os.getppid()
child = None
stopping = False
def stop(signum, frame):
    global stopping
    stopping = True
    if child is not None:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
    sys.exit(70)
if os.getppid() != parent:
    sys.exit(0)
allowed = sorted(os.sched_getaffinity(0))
# One page gets at most two CPUs, and never more than its cgroup quota.
cpus = min(2, len(allowed))
try:
    quota, period = open('/sys/fs/cgroup/cpu.max').read().split()
    if quota != 'max': cpus = min(cpus, max(1, math.floor(int(quota)/int(period))))
except (OSError, ValueError):
    try:
        quota = int(open('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').read())
        period = int(open('/sys/fs/cgroup/cpu/cpu.cfs_period_us').read())
        if quota > 0: cpus = min(cpus, max(1, math.floor(quota/period)))
    except (OSError, ValueError): pass
os.sched_setaffinity(0, allowed[:cpus])
status = 0
try:
    if not stopping:
        child = subprocess.Popen(sys.argv[1:], pass_fds=(3,4), start_new_session=True)
        if stopping: stop(0, None)
        status = child.wait()
        if status == -signal.SIGKILL and not stopping:
            sys.stderr.write('BROWSER_RESOURCE_LIMIT\n')
except OSError as error:
    if error.errno in (11,12): sys.stderr.write('BROWSER_RESOURCE_LIMIT\n')
    status = 71
finally:
    stop(0, None)
    while True:
        # All orphan descendants are adopted here, including new process groups.
        try:
            children = open('/proc/self/task/%d/children' % os.getpid()).read().split()
            for pid in children:
                try: os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError: pass
            # ECHILD from waitpid, not a /proc snapshot, is the completion barrier.
            os.waitpid(-1, 0)
        except ChildProcessError: break
sys.exit(0 if status == 0 else 71)
`;

// A private CDP pipe, not a TCP debugging port: the sandbox network policy applies
// to Chromium itself, and no unauthenticated debugging endpoint is exposed.
export class BrowserDriver {
  constructor({ executable, network = "isolated", idleMs = IDLE_MS } = {}) {
    this.executable = executable;
    this.network = network;
    this.idleMs = idleMs;
    this.pending = new Map();
    this.loaded = new Set();
    this.nextId = 0;
    this.queue = Promise.resolve();
    this.onExit = () => this.kill();
    process.once("exit", this.onExit);
  }

  kill() {
    // The supervisor kills Chromium's group and reaps every adopted descendant.
    this.child?.kill("SIGTERM");
  }

  close() {
    this.closing ??= this.closeBrowser().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  async closeBrowser() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.sessionId = undefined;
    this.loaded.clear();
    const profile = this.profile;
    this.profile = undefined;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new BrowserFailure("BROWSER_CLOSED"));
    }
    this.pending.clear();
    if (child?.pid) {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        const exited = Promise.withResolvers();
        child.once("exit", exited.resolve);
        await exited.promise;
      }
    }
    if (profile)
      await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  async dispose() {
    await this.close();
    process.removeListener("exit", this.onExit);
  }

  command(method, params = {}, sessionId = this.sessionId) {
    if (this.signal?.aborted)
      return Promise.reject(new BrowserFailure("BROWSER_ABORTED"));
    const remaining = (this.deadline ?? Infinity) - Date.now();
    if (remaining <= 0)
      return Promise.reject(new BrowserFailure("BROWSER_TIMEOUT"));
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return Promise.reject(new BrowserFailure("BROWSER_CLOSED"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new BrowserFailure("BROWSER_TIMEOUT"));
        },
        Math.min(COMMAND_MS, remaining),
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new BrowserFailure("BROWSER_CLOSED"));
        },
      );
    });
  }

  async launch() {
    await this.closing;
    if (this.child) return;
    const candidates = this.executable
      ? [this.executable]
      : [
          process.env.TOOLPLANE_CHROMIUM_PATH,
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
        ].filter(Boolean);
    let executable;
    for (const path of candidates) {
      try {
        await access(path, constants.X_OK);
        executable = path;
        break;
      } catch {}
    }
    if (!executable) fail("BROWSER_CHROMIUM_MISSING");
    try {
      await access("/usr/bin/python3", constants.X_OK);
    } catch {
      fail("BROWSER_SUPERVISOR_MISSING");
    }
    this.resourceLimit = false;
    this.profile = await mkdtemp(join(tmpdir(), "toolplane-browser-"));
    if (this.signal?.aborted) {
      await this.close();
      fail("BROWSER_ABORTED");
    }
    if (Date.now() >= this.deadline) {
      await this.close();
      fail("BROWSER_TIMEOUT");
    }
    this.child = spawn(
      "/usr/bin/python3",
      [
        "-c",
        SUPERVISOR,
        executable,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Single-process keeps room for the SDK host within PID128. Explicit
        // CPU-backed ANGLE avoids uninitialized headless Ozone GL contexts.
        "--single-process",
        "--no-zygote",
        "--in-process-gpu",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-crashpad-for-testing",
        "--renderer-process-limit=1",
        "--num-raster-threads=1",
        "--js-flags=--single-threaded",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--remote-debugging-pipe",
        `--user-data-dir=${this.profile}`,
        // Defense in depth for the no-network mode (the container also has no NIC).
        ...(this.network === "none"
          ? ["--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]
          : []),
        "about:blank",
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        // Do not pass the SDK's model/MCP runtime token to Chromium children.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR,
          CHROME_HEADLESS: "1",
        },
      },
    );
    const child = this.child;
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4096);
      if (
        /BROWSER_RESOURCE_LIMIT|pthread_create|Resource temporarily unavailable|Cannot allocate memory|Out of memory|OOM/i.test(
          diagnostics,
        )
      )
        this.resourceLimit = true;
    });
    let buffer = Buffer.alloc(0);
    child.stdio[3].on("error", () => {});
    child.stdio[4].on("error", () => {});
    child.stdio[4].on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FRAME_BYTES) {
        void this.close();
        return;
      }
      for (;;) {
        const end = buffer.indexOf(0);
        if (end < 0) break;
        const frame = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        let message;
        try {
          message = JSON.parse(frame.toString("utf8"));
        } catch {
          void this.close();
          return;
        }
        if (
          message.method === "Page.lifecycleEvent" &&
          message.params?.name === "DOMContentLoaded"
        ) {
          if (this.loaded.size > 64) this.loaded.clear();
          this.loaded.add(message.params.loaderId);
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new BrowserFailure("BROWSER_ACTION_FAILED"));
        else pending.resolve(message.result ?? {});
      }
    });
    const closed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.sessionId = undefined;
      clearTimeout(this.idle);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserFailure(
            this.resourceLimit ? "BROWSER_RESOURCE_LIMIT" : "BROWSER_CLOSED",
          ),
        );
      }
      this.pending.clear();
      const profile = this.profile;
      this.profile = undefined;
      if (profile)
        void rm(profile, { recursive: true, force: true }).catch(() => {});
    };
    child.once("error", (error) => {
      if (error.code === "EAGAIN" || error.code === "ENOMEM")
        this.resourceLimit = true;
      closed();
    });
    child.once("exit", closed);
    try {
      await this.command("Browser.getVersion");
      const { targetId } = await this.command("Target.createTarget", {
        url: "about:blank",
      });
      const attached = await this.command("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      this.sessionId = attached.sessionId;
      await this.command("Page.enable");
      await this.command("Page.setLifecycleEventsEnabled", { enabled: true });
      await this.command("Runtime.enable");
      await this.command("Emulation.setDeviceMetricsOverride", {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await this.command("Page.setDownloadBehavior", { behavior: "deny" });
      // Avoid alert/confirm blocking an unattended tool forever.
      await this.command("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;",
      });
    } catch (error) {
      await this.close();
      if (this.resourceLimit) fail("BROWSER_RESOURCE_LIMIT");
      if (
        error instanceof BrowserFailure &&
        ["BROWSER_TIMEOUT", "BROWSER_ABORTED"].includes(error.reason)
      )
        throw error;
      fail("BROWSER_LAUNCH_FAILED");
    }
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: COMMAND_MS - 1000,
    });
    if (result.exceptionDetails) fail("BROWSER_EVALUATION_FAILED");
    return result.result?.value;
  }

  run(args, signal) {
    const operation = this.queue.then(() => this.perform(args, signal));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async perform(args, signal) {
    clearTimeout(this.idle);
    if (signal?.aborted) fail("BROWSER_ABORTED");
    this.signal = signal;
    this.deadline = Date.now() + 30_000;
    const abort = () => {
      void this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.action(args);
      if (signal?.aborted) fail("BROWSER_ABORTED");
      return result;
    } catch (error) {
      const reason = signal?.aborted
        ? "BROWSER_ABORTED"
        : this.resourceLimit
          ? "BROWSER_RESOURCE_LIMIT"
          : error instanceof BrowserFailure
            ? error.reason
            : "BROWSER_ACTION_FAILED";
      if (
        [
          "BROWSER_TIMEOUT",
          "BROWSER_ABORTED",
          "BROWSER_CLOSED",
          "BROWSER_RESOURCE_LIMIT",
        ].includes(reason)
      )
        await this.close();
      throw new BrowserFailure(reason);
    } finally {
      this.signal = undefined;
      this.deadline = undefined;
      signal?.removeEventListener("abort", abort);
      if (this.child) {
        this.idle = setTimeout(() => {
          void this.close();
        }, this.idleMs);
        this.idle.unref();
      }
    }
  }

  async action(args) {
    if (!args || typeof args !== "object") fail("BROWSER_INVALID_ARGUMENT");
    const { action } = args;
    if (action === "close") {
      await this.close();
      return textResult({ closed: true });
    }
    if (action === "open") {
      if (!string(args.url, 8192)) fail("BROWSER_INVALID_ARGUMENT");
      let url;
      try {
        url = new URL(args.url);
      } catch {
        fail("BROWSER_INVALID_ARGUMENT");
      }
      if (
        !["http:", "https:", "file:", "data:", "about:"].includes(
          url.protocol,
        ) ||
        url.username ||
        url.password
      )
        fail("BROWSER_INVALID_ARGUMENT");
      if (this.network === "none" && ["http:", "https:"].includes(url.protocol))
        fail("BROWSER_NETWORK_ISOLATED");
      await this.launch();
      this.loaded.clear();
      const navigation = await this.command("Page.navigate", { url: url.href });
      if (navigation.errorText)
        fail(
          this.network === "none"
            ? "BROWSER_NETWORK_ISOLATED"
            : "BROWSER_NAVIGATION_FAILED",
        );
      // Wait for this navigation's document, never the previous loaded page.
      while (navigation.loaderId && !this.loaded.has(navigation.loaderId)) {
        if (this.signal?.aborted) fail("BROWSER_ABORTED");
        if (!this.child) fail("BROWSER_CLOSED");
        if (Date.now() >= this.deadline) fail("BROWSER_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return textResult(
        await this.evaluate("({url:location.href,title:document.title})"),
      );
    }
    if (!this.child || !this.sessionId) fail("BROWSER_NOT_OPEN");
    if (action === "text") {
      const result = await this.evaluate(
        `(() => { const text = document.body?.innerText ?? ''; return {text:text.slice(0,${OUTPUT_CHARS}),truncated:text.length>${OUTPUT_CHARS}}; })()`,
      );
      return textResult(result.text, { truncated: result.truncated });
    }
    if (action === "evaluate") {
      if (!string(args.js, OUTPUT_CHARS)) fail("BROWSER_INVALID_ARGUMENT");
      // Serialize and bound inside the page so CDP cannot ship an unbounded value.
      const result = await this.evaluate(
        `(async () => { const value = await (0,eval)(${JSON.stringify(args.js)}); const text = JSON.stringify(value) ?? 'null'; return {text:text.slice(0,${OUTPUT_CHARS}),truncated:text.length>${OUTPUT_CHARS}}; })()`,
      );
      return textResult(result.text, { truncated: result.truncated });
    }
    if (action === "screenshot") {
      const capture = await this.command("Page.captureScreenshot", {
        format: "jpeg",
        quality: 60,
        captureBeyondViewport: false,
        fromSurface: true,
      });
      if (
        typeof capture.data !== "string" ||
        capture.data.length > Math.ceil(BROWSER_IMAGE_BYTES / 3) * 4
      )
        fail("BROWSER_OUTPUT_LIMIT");
      return {
        content: [
          { type: "image", data: capture.data, mimeType: "image/jpeg" },
        ],
        details: {
          width: 1024,
          height: 768,
          bytes: Buffer.byteLength(capture.data, "base64"),
        },
      };
    }
    if (action === "click" || action === "type") {
      if (
        !string(args.selector, 2048) ||
        (action === "type" &&
          (typeof args.text !== "string" || args.text.length > OUTPUT_CHARS))
      )
        fail("BROWSER_INVALID_ARGUMENT");
      const point = await this.evaluate(
        `(() => { const el=document.querySelector(${JSON.stringify(args.selector)}); if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); el.focus(); const r=el.getBoundingClientRect(); return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`,
      );
      if (!point) fail("BROWSER_SELECTOR_NOT_FOUND");
      if (action === "type")
        await this.command("Input.insertText", { text: args.text });
      else {
        await this.command("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...point,
        });
        await this.command("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...point,
        });
      }
      return textResult({ action, completed: true });
    }
    if (action === "press") {
      if (!string(args.key, 64)) fail("BROWSER_INVALID_ARGUMENT");
      const parts = args.key.split("+");
      const key = parts.pop();
      const modifiers = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
      if (parts.some((part) => !modifiers[part]))
        fail("BROWSER_INVALID_ARGUMENT");
      const keys = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        Backspace: 8,
        Delete: 46,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Space: 32,
      };
      if (!keys[key] && !/^[a-zA-Z0-9]$/.test(key))
        fail("BROWSER_INVALID_ARGUMENT");
      const flags = parts.reduce((sum, part) => sum | modifiers[part], 0);
      const code = keys[key] ?? key.toUpperCase().charCodeAt(0);
      const event = {
        key: key === "Space" ? " " : key,
        modifiers: flags,
        windowsVirtualKeyCode: code,
      };
      await this.command("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...event,
        ...(!flags && key === "Enter"
          ? { text: "\r" }
          : !flags && (key.length === 1 || key === "Space")
            ? { text: event.key }
            : {}),
      });
      await this.command("Input.dispatchKeyEvent", { type: "keyUp", ...event });
      return textResult({ action, completed: true });
    }
    fail("BROWSER_INVALID_ARGUMENT");
  }
}

export default function browserExtension(pi) {
  // Factory/preflight are offline and side-effect free; Chromium starts on open.
  let driver;
  pi.on("session_shutdown", async () => {
    await driver?.dispose();
  });
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Automate Chromium in this sandbox. Actions: open(url), click(CSS selector), type(selector,text; inserts at the current caret), press(key, e.g. Enter or Control+a), text, screenshot (1024x768 JPEG, at most 150 KiB), evaluate(js expression), close. Text/evaluation output is limited to 16000 characters. Browser state persists in this conversation until close or five minutes idle. Network follows the sandbox: isolated allows egress; none cannot reach external pages. File access is sandbox-local, not a host file API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "click",
            "type",
            "press",
            "screenshot",
            "text",
            "evaluate",
            "close",
          ],
        },
        url: { type: "string", maxLength: 8192 },
        selector: { type: "string", maxLength: 2048 },
        text: { type: "string", maxLength: OUTPUT_CHARS },
        key: { type: "string", maxLength: 64 },
        js: { type: "string", maxLength: OUTPUT_CHARS },
      },
      required: ["action"],
    },
    async execute(_toolCallId, args, signal) {
      driver ??= new BrowserDriver({
        network:
          process.env.TOOLPLANE_BROWSER_NETWORK === "isolated"
            ? "isolated"
            : "none",
      });
      try {
        return await driver.run(args, signal);
      } catch (error) {
        const reason =
          error instanceof BrowserFailure
            ? error.reason
            : "BROWSER_ACTION_FAILED";
        // Throw only fixed, safe text so Pi marks the native tool result failed,
        // without turning a handled tool failure into a failed conversation turn.
        throw new Error(JSON.stringify({ reason, message: MESSAGES[reason] }));
      }
    },
  });
}
