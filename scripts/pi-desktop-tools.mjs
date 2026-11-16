import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

// Desktop tools for sandboxes built from the ToolPlane desktop image. The image
// sets TOOLPLANE_DESKTOP_DISPLAY; any other image gets no desktop tools.
const LEASE_PATH = "/tmp/.toolplane-desktop/user-control";
const MAX_TEXT = 12_000;
const MAX_ELEMENTS = 150;
const COMMAND_TIMEOUT_MS = 20_000;
const CDP_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
export const TAKEOVER_REASONS = [
  "captcha",
  "sso",
  "passkey",
  "qr",
  "payment_verification",
  "human_required",
];

const fail = (code, message) =>
  Object.assign(new Error(`${code}: ${message}`), { code });

function text(value) {
  const body = String(value);
  return {
    type: "text",
    text:
      body.length > MAX_TEXT
        ? `${body.slice(0, MAX_TEXT)}\n…[truncated]`
        : body,
  };
}

function run(file, args, { env, signal, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env,
        signal,
        encoding,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            fail(
              "DESKTOP_COMMAND_FAILED",
              `${file} failed${error.code ? ` (${error.code})` : ""}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

async function assertAgentControl() {
  let expires = 0;
  try {
    expires = Number((await readFile(LEASE_PATH, "utf8")).trim());
  } catch {
    return;
  }
  if (Number.isFinite(expires) && expires > Date.now())
    throw fail(
      "DISPLAY_USER_CONTROLLED",
      "The user is controlling the desktop. Do not act on the screen until they hand it back; continue other work or wait.",
    );
}

function integer(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000)
    throw fail(
      "DESKTOP_INVALID_ARGUMENT",
      `${name} must be a non-negative integer.`,
    );
  return String(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value)
    throw fail("DESKTOP_INVALID_ARGUMENT", `${name} is required.`);
  return value;
}

// ---- computer: xdotool + ImageMagick against the X display -----------------

function createComputerTool(env) {
  const xenv = { ...process.env, DISPLAY: env.display };
  const xdotool = (args, signal) => run("xdotool", args, { env: xenv, signal });
  async function screenshot(signal) {
    const jpeg = await run(
      "import",
      ["-silent", "-window", "root", "-quality", "70", "jpeg:-"],
      { env: xenv, signal, encoding: "buffer" },
    );
    return {
      type: "image",
      data: jpeg.toString("base64"),
      mimeType: "image/jpeg",
    };
  }
  const buttons = { click: "1", right_click: "3", middle_click: "2" };
  return {
    name: "desktop_computer",
    label: "Desktop",
    description: `Operate the sandbox's graphical desktop (${env.size}, X display ${env.display}) that the user can watch live and take over. Coordinates are screen pixels from the top-left. Actions: screenshot; click, double_click, right_click, middle_click, move (x, y); drag (x, y → to_x, to_y); type (text); key (keys in xdotool syntax, e.g. "ctrl+l", "Return", "Escape"); scroll (x, y, direction, amount); wait (seconds). Mutating actions return a fresh screenshot unless screenshot is false. Prefer desktop_browser for web pages. If the user is controlling the screen, actions fail with DISPLAY_USER_CONTROLLED.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "click",
            "double_click",
            "right_click",
            "middle_click",
            "move",
            "drag",
            "type",
            "key",
            "scroll",
            "wait",
          ],
        },
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        to_x: { type: "integer", minimum: 0 },
        to_y: { type: "integer", minimum: 0 },
        text: { type: "string", maxLength: 4000 },
        keys: { type: "string", maxLength: 200 },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 50 },
        seconds: { type: "number", minimum: 0, maximum: 30 },
        screenshot: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await assertAgentControl();
      const action = params?.action;
      if (action === "screenshot")
        return { content: [await screenshot(signal)], details: { action } };
      if (action === "wait") {
        await delay(Math.min(Number(params.seconds) || 1, 30) * 1000, signal);
      } else if (action in buttons || action === "double_click") {
        const x = integer(params.x, "x");
        const y = integer(params.y, "y");
        await xdotool(
          action === "double_click"
            ? ["mousemove", "--sync", x, y, "click", "--repeat", "2", "1"]
            : ["mousemove", "--sync", x, y, "click", buttons[action]],
          signal,
        );
      } else if (action === "move") {
        await xdotool(
          [
            "mousemove",
            "--sync",
            integer(params.x, "x"),
            integer(params.y, "y"),
          ],
          signal,
        );
      } else if (action === "drag") {
        await xdotool(
          [
            "mousemove",
            "--sync",
            integer(params.x, "x"),
            integer(params.y, "y"),
            "mousedown",
            "1",
            "mousemove",
            "--sync",
            integer(params.to_x, "to_x"),
            integer(params.to_y, "to_y"),
            "mouseup",
            "1",
          ],
          signal,
        );
      } else if (action === "type") {
        await xdotool(
          ["type", "--delay", "12", "--", requiredText(params.text, "text")],
          signal,
        );
      } else if (action === "key") {
        const keys = requiredText(params.keys, "keys")
          .split(/\s+/)
          .filter(Boolean);
        if (!keys.every((key) => /^[A-Za-z0-9_+]+$/.test(key)))
          throw fail("DESKTOP_INVALID_ARGUMENT", "Invalid key syntax.");
        await xdotool(["key", "--", ...keys], signal);
      } else if (action === "scroll") {
        const button = { up: "4", down: "5", left: "6", right: "7" }[
          params.direction ?? "down"
        ];
        if (!button)
          throw fail("DESKTOP_INVALID_ARGUMENT", "Invalid scroll direction.");
        await xdotool(
          [
            "mousemove",
            "--sync",
            integer(params.x, "x"),
            integer(params.y, "y"),
            "click",
            "--repeat",
            String(Math.min(Math.max(Number(params.amount) || 3, 1), 50)),
            button,
          ],
          signal,
        );
      } else {
        throw fail("DESKTOP_INVALID_ARGUMENT", "Unknown action.");
      }
      if (params.screenshot === false || action === "wait")
        return { content: [text(`${action} done`)], details: { action } };
      await delay(400, signal);
      return {
        content: [text(`${action} done`), await screenshot(signal)],
        details: { action },
      };
    },
  };
}

// ---- browser: Chrome DevTools Protocol against the desktop Chromium --------

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const max = ${MAX_ELEMENTS};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  document.querySelectorAll('[data-toolplane-ref]').forEach((el) => el.removeAttribute('data-toolplane-ref'));
  const nodes = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=""],[contenteditable=true],summary');
  const elements = [];
  for (const el of nodes) {
    if (elements.length >= max) break;
    if (!visible(el)) continue;
    const ref = String(elements.length + 1);
    el.setAttribute('data-toolplane-ref', ref);
    const label = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    elements.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.getAttribute('role') || undefined, label, href: el.tagName === 'A' ? el.href.slice(0, 200) : undefined });
  }
  return JSON.stringify({ url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, ${MAX_TEXT}), elements });
})()`;

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
};

async function cdpPage(port, signal) {
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    });
    targets = await response.json();
  } catch {
    throw fail(
      "DESKTOP_BROWSER_UNAVAILABLE",
      "Chromium is not reachable; it may still be starting. Retry shortly.",
    );
  }
  const page = Array.isArray(targets)
    ? targets.find(
        (target) => target.type === "page" && target.webSocketDebuggerUrl,
      )
    : null;
  if (!page)
    throw fail("DESKTOP_BROWSER_UNAVAILABLE", "No Chromium tab is open.");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () =>
        reject(fail("DESKTOP_BROWSER_UNAVAILABLE", "CDP connection failed.")),
      { once: true },
    );
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(fail("DESKTOP_BROWSER_FAILED", message.error.message));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.reject(fail("DESKTOP_BROWSER_FAILED", "CDP connection closed."));
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail("DESKTOP_BROWSER_TIMEOUT", `${method} timed out.`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw fail(
      "DESKTOP_BROWSER_FAILED",
      result.exceptionDetails.exception?.description?.slice(0, 300) ??
        "Page script failed.",
    );
  return result.result?.value;
}

async function waitForLoad(page, signal) {
  const until = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < until && !signal?.aborted) {
    await delay(250, signal);
    const state = await evaluate(page, "document.readyState").catch(() => "");
    if (state === "complete" || state === "interactive") return;
  }
}

// After an interaction, give a triggered navigation up to 1.5s to start before
// waiting for the document; interactions without navigation return quickly.
async function settle(page, signal) {
  const before = await evaluate(page, "location.href").catch(() => "");
  const until = Date.now() + 1_500;
  while (Date.now() < until && !signal?.aborted) {
    await delay(150, signal);
    const state = await evaluate(
      page,
      "JSON.stringify([location.href, document.readyState])",
    ).catch(() => null);
    if (!state) continue;
    const [href, readyState] = JSON.parse(state);
    if (href !== before || readyState === "loading") break;
  }
  await waitForLoad(page, signal);
}

async function elementCenter(page, ref) {
  if (!/^\d{1,4}$/.test(String(ref ?? "")))
    throw fail(
      "DESKTOP_INVALID_ARGUMENT",
      "ref must come from the latest snapshot.",
    );
  const value = await evaluate(
    page,
    `(() => { const el = document.querySelector('[data-toolplane-ref="${ref}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!value)
    throw fail(
      "DESKTOP_ELEMENT_NOT_FOUND",
      "Element ref not found; take a new snapshot.",
    );
  return value;
}

async function pressKey(page, name) {
  const key = KEYS[name];
  if (!key) throw fail("DESKTOP_INVALID_ARGUMENT", "Unsupported key.");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...key,
    text: undefined,
  });
}

function createBrowserTool(env) {
  return {
    name: "desktop_browser",
    label: "Browser",
    description: `Control the Chromium window on the sandbox desktop (the user can watch and take over the same window). Actions: navigate (url); snapshot (page text plus numbered interactive elements); click (ref); type (ref, text, optional submit); press (key: ${Object.keys(KEYS).join(", ")}); scroll (direction, amount); back; screenshot. Element refs come from the latest snapshot and change after navigation. Sign-in pages, CAPTCHAs, passkeys, QR codes and payment verification need the user: call desktop_request_takeover instead of guessing credentials.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate",
            "snapshot",
            "click",
            "type",
            "press",
            "scroll",
            "back",
            "screenshot",
          ],
        },
        url: { type: "string", maxLength: 4000 },
        ref: { type: "string", maxLength: 8 },
        text: { type: "string", maxLength: 8000 },
        submit: { type: "boolean" },
        key: { type: "string", enum: Object.keys(KEYS) },
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await assertAgentControl();
      const action = params?.action;
      const page = await cdpPage(env.cdpPort, signal);
      try {
        const snapshot = async () => {
          const value = JSON.parse(await evaluate(page, SNAPSHOT_SCRIPT));
          return {
            content: [
              text(
                [
                  `URL: ${value.url}`,
                  `Title: ${value.title}`,
                  "",
                  value.text,
                  "",
                  "Interactive elements:",
                  ...value.elements.map(
                    (element) =>
                      `[${element.ref}] ${element.tag}${element.type ? `(${element.type})` : ""} ${element.label}${element.href ? ` → ${element.href}` : ""}`,
                  ),
                ].join("\n"),
              ),
            ],
            details: { action, url: value.url, title: value.title },
          };
        };
        const location = async () => {
          const value = await evaluate(
            page,
            "JSON.stringify({ url: location.href, title: document.title })",
          );
          const { url, title } = JSON.parse(value);
          return {
            content: [text(`${action} done. URL: ${url}\nTitle: ${title}`)],
            details: { action, url, title },
          };
        };
        if (action === "navigate") {
          let url;
          try {
            url = new URL(requiredText(params.url, "url"));
          } catch {
            throw fail("DESKTOP_INVALID_ARGUMENT", "url must be absolute.");
          }
          if (!["http:", "https:"].includes(url.protocol))
            throw fail(
              "DESKTOP_INVALID_ARGUMENT",
              "Only http(s) URLs are allowed.",
            );
          const result = await page.send("Page.navigate", { url: url.href });
          if (result.errorText)
            throw fail("DESKTOP_NAVIGATION_FAILED", result.errorText);
          await waitForLoad(page, signal);
          return await snapshot();
        }
        if (action === "snapshot") return await snapshot();
        if (action === "screenshot") {
          const shot = await page.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 70,
          });
          return {
            content: [
              { type: "image", data: shot.data, mimeType: "image/jpeg" },
            ],
            details: { action },
          };
        }
        if (action === "click") {
          const { x, y } = await elementCenter(page, params.ref);
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
            await page.send("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: type === "mouseMoved" ? "none" : "left",
              clickCount: type === "mouseMoved" ? 0 : 1,
            });
          await settle(page, signal);
          return await location();
        }
        if (action === "type") {
          if (params.ref !== undefined) {
            await elementCenter(page, params.ref);
            await evaluate(
              page,
              `(() => { const el = document.querySelector('[data-toolplane-ref="${params.ref}"]'); el.focus(); if ('select' in el && typeof el.select === 'function') el.select(); else if (el.isContentEditable) document.execCommand('selectAll'); })()`,
            );
          }
          await page.send("Input.insertText", {
            text: requiredText(params.text, "text"),
          });
          if (params.submit) {
            await pressKey(page, "Enter");
            await settle(page, signal);
          }
          return await location();
        }
        if (action === "press") {
          await pressKey(page, params.key);
          await settle(page, signal);
          return await location();
        }
        if (action === "scroll") {
          const amount = Math.min(Math.max(Number(params.amount) || 1, 1), 20);
          const sign = params.direction === "up" ? -1 : 1;
          await evaluate(
            page,
            `window.scrollBy(0, ${sign * amount} * Math.round(window.innerHeight * 0.8))`,
          );
          return await location();
        }
        if (action === "back") {
          await evaluate(page, "history.back()");
          await settle(page, signal);
          return await location();
        }
        throw fail("DESKTOP_INVALID_ARGUMENT", "Unknown action.");
      } finally {
        page.close();
      }
    },
  };
}

// ---- takeover: blocking native UI dialog -----------------------------------

function createTakeoverTool(requestTakeover) {
  return {
    name: "desktop_request_takeover",
    label: "Request takeover",
    description: `Hand the desktop to the user for a step only a human can do (${TAKEOVER_REASONS.join(", ")}), then wait until they finish or decline. Never ask for passwords, codes or secrets in chat; leave the page ready, call this tool, and verify the result with a fresh snapshot afterwards.`,
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: TAKEOVER_REASONS },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "What the user should do on the screen, in the user's language.",
        },
      },
      required: ["reason", "message"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      if (!TAKEOVER_REASONS.includes(params?.reason))
        throw fail("DESKTOP_INVALID_ARGUMENT", "Unsupported takeover reason.");
      const message = requiredText(params.message, "message").slice(0, 500);
      const outcome = await requestTakeover({
        reason: params.reason,
        message,
        signal,
      });
      // The user's answer is the hand-back; the viewer drops its lease right after.
      if (outcome === "completed") await rm(LEASE_PATH, { force: true });
      const content = {
        completed:
          "The user finished the step and handed the desktop back. Take a fresh snapshot before continuing.",
        declined:
          "The user declined the takeover. Do not retry the blocked step automatically; explain what is needed in your reply.",
        unavailable:
          "Takeover is not available in this conversation entry. Explain in your reply what the user must do on the desktop.",
      }[outcome];
      return { content: [text(content)], details: { outcome } };
    },
  };
}

export function createDesktopTools({
  requestTakeover,
  env = process.env,
} = {}) {
  const display = env.TOOLPLANE_DESKTOP_DISPLAY;
  if (!display || !/^:\d{1,3}$/.test(display)) return [];
  const cdpPort = Number(env.TOOLPLANE_DESKTOP_CDP_PORT || 9222);
  const size = /^\d{2,5}x\d{2,5}$/.test(env.TOOLPLANE_DESKTOP_SIZE ?? "")
    ? env.TOOLPLANE_DESKTOP_SIZE
    : "unknown size";
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) return [];
  const desktop = { display, cdpPort, size };
  return [
    createComputerTool(desktop),
    createBrowserTool(desktop),
    createTakeoverTool(requestTakeover),
  ];
}
