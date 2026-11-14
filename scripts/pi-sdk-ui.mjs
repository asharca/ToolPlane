import { randomUUID } from "node:crypto";
import { nativeTodos } from "./pi-sdk-native-resources.mjs";

const transportError = () =>
  Object.assign(new Error("PI_SDK_UI_FAILED"), {
    code: "PI_SDK_UI_FAILED",
  });
const MAX_PAYLOAD_BYTES = 256 * 1024;
// Pi 1.5.2 RPC UI semantics, transported over the current task's authenticated HTTP
// endpoint. This adapter does not make tool or permission decisions.
export function createNativeUi({ getContext, theme, onError }) {
  const pending = new Map();
  let writes = Promise.resolve();
  let cancelled = false;
  const capture = () => {
    const context = getContext();
    if (!context?.uiUrl || !context.runtimeToken)
      throw Object.assign(new Error("PI_SDK_CONTEXT_REQUIRED"), {
        code: "PI_SDK_CONTEXT_REQUIRED",
      });
    const url = new URL(context.uiUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/v1\/agent-runtime\/(?:tasks\/[^/]+\/ui|sessions\/ui)$/.test(
        url.pathname,
      )
    )
      throw transportError();
    return { url, token: context.runtimeToken };
  };
  async function post(target, body, signal) {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw transportError();
    const response = await fetch(target.url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: payload,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      if (body.action === "todos" && response.status === 413)
        throw Object.assign(new Error("PI_SDK_TODO_DISPLAY_LIMIT"), {
          code: "PI_SDK_TODO_DISPLAY_LIMIT",
        });
      throw transportError();
    }
    const reader = response.body?.getReader();
    if (!reader) throw transportError();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PAYLOAD_BYTES) throw transportError();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw transportError();
    return value;
  }
  function enqueue(body) {
    if (!getContext()?.uiUrl) return Promise.resolve();
    const target = capture();
    const operation = writes.then(() => post(target, body));
    writes = operation.catch((error) => {
      if (error.code !== "PI_SDK_TODO_DISPLAY_LIMIT") onError(error);
    });
    return operation;
  }
  function send(request) {
    void enqueue({
      action: "request",
      request: { type: "extension_ui_request", id: randomUUID(), ...request },
    }).catch(() => {});
  }
  function displayWarning() {
    return enqueue({
      action: "request",
      request: {
        type: "extension_ui_request",
        id: randomUUID(),
        method: "notify",
        notifyType: "warning",
        message:
          "Todo projection unavailable: native state exceeds the Web display capacity (256 KiB transport limit). Any previously displayed list is stale; native session state is unchanged.",
      },
    });
  }
  function dialog(opts, defaultValue, request, parseResponse) {
    if (cancelled || opts?.signal?.aborted || !getContext()?.uiUrl)
      return Promise.resolve(defaultValue);
    const target = capture();
    const id = randomUUID();
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      let registration;
      const cleanup = () => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", cancel);
        pending.delete(id);
        controller.abort();
      };
      const settle = (value, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const retire = () => {
        const resolution = Promise.resolve(registration)
          .catch(() => {})
          .then(() => post(target, { action: "resolve", id }));
        writes = Promise.all([writes, resolution]).then(() => {}, onError);
      };
      const cancel = () => {
        // Resolve immediately like upstream. The request must finish registering
        // before resolve is posted, otherwise cancellation can race registration.
        settle(defaultValue);
        retire();
      };
      pending.set(id, cancel);
      opts?.signal?.addEventListener("abort", cancel, { once: true });
      if (opts?.timeout) timer = setTimeout(cancel, opts.timeout);
      registration = post(target, {
        action: "request",
        request: { type: "extension_ui_request", id, ...request },
      });
      void (async () => {
        try {
          let result = await registration;
          while (!settled) {
            const response = result.response;
            if (response) {
              if (
                response.type !== "extension_ui_response" ||
                response.id !== id
              )
                throw Object.assign(new Error("PI_SDK_UI_FAILED"), {
                  code: "PI_SDK_UI_FAILED",
                });
              settle(parseResponse(response));
              return;
            }
            await new Promise((done) => {
              const finish = () => {
                clearTimeout(delay);
                controller.signal.removeEventListener("abort", finish);
                done();
              };
              const delay = setTimeout(finish, 250);
              controller.signal.addEventListener("abort", finish, {
                once: true,
              });
            });
            if (settled) return;
            result = await post(
              target,
              { action: "poll", id },
              controller.signal,
            );
          }
        } catch (error) {
          if (!settled) {
            settle(undefined, error);
            retire();
          }
        }
      })();
    });
  }
  const value = (response) => (response.cancelled ? undefined : response.value);
  const noop = () => {};
  const uiContext = {
    select: (title, options, opts) =>
      dialog(
        opts,
        undefined,
        { method: "select", title, options, timeout: opts?.timeout },
        value,
      ),
    confirm: (title, message, opts) =>
      dialog(
        opts,
        false,
        { method: "confirm", title, message, timeout: opts?.timeout },
        (response) =>
          response.cancelled ? false : (response.confirmed ?? false),
      ),
    input: (title, placeholder, opts) =>
      dialog(
        opts,
        undefined,
        { method: "input", title, placeholder, timeout: opts?.timeout },
        value,
      ),
    editor: (title, prefill) =>
      dialog(undefined, undefined, { method: "editor", title, prefill }, value),
    notify: (message, notifyType) =>
      send({ method: "notify", message, notifyType }),
    setStatus: (statusKey, statusText) =>
      send({ method: "setStatus", statusKey, statusText }),
    setWidget(widgetKey, content, options) {
      if (content === undefined || Array.isArray(content))
        send({
          method: "setWidget",
          widgetKey,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
    },
    setTitle: (title) => send({ method: "setTitle", title }),
    setEditorText: (text) => send({ method: "set_editor_text", text }),
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    getEditorText: () => "",
    onTerminalInput: () => noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setFooter: noop,
    setHeader: noop,
    custom: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "Theme switching not supported in RPC mode",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
  return {
    uiContext,
    start: () => {
      cancelled = false;
    },
    cancel: () => {
      cancelled = true;
      for (const cancel of pending.values()) cancel();
    },
    drain: () => writes,
    projectTodos(sessionManager) {
      const projection = {
        action: "todos",
        todos: nativeTodos(sessionManager),
      };
      if (Buffer.byteLength(JSON.stringify(projection)) > MAX_PAYLOAD_BYTES)
        return displayWarning();
      return enqueue(projection).catch((error) => {
        if (error.code === "PI_SDK_TODO_DISPLAY_LIMIT") return displayWarning();
        throw error;
      });
    },
  };
}
