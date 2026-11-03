const MAX_BYTES = 256 * 1024;
export function createOmpUi({ url, token, send, onError }) {
  const pending = new Map();
  let writes = Promise.resolve();
  let stopped = false;
  async function post(body, signal) {
    if (!url) throw new Error("OMP_UI_UNAVAILABLE");
    const target = new URL(url);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !/^\/api\/v1\/agent-runtime\/(?:tasks\/[^/]+\/ui|sessions\/ui)$/.test(
        target.pathname,
      )
    )
      throw new Error("OMP_UI_INVALID");
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_BYTES)
      throw new Error("OMP_UI_DISPLAY_LIMIT");
    const response = await fetch(target, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: encoded,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      throw new Error("OMP_UI_FAILED");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("OMP_UI_DISPLAY_LIMIT");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function enqueue(body) {
    if (!url) return Promise.resolve();
    const operation = writes.then(() => post(body));
    writes = operation.catch(onError);
    return operation;
  }
  async function retire(id) {
    const record = pending.get(id);
    if (!record) return;
    pending.delete(id);
    record.controller.abort();
    await record.registration.catch(() => {});
    await post({ action: "resolve", id });
  }
  function request(frame) {
    if (frame.method === "cancel") {
      return retire(frame.targetId);
    }
    const dialog = ["select", "confirm", "input", "editor", "ask"].includes(
      frame.method,
    );
    if (stopped || !url || frame.secret === true) {
      if (dialog)
        send({ type: "extension_ui_response", id: frame.id, cancelled: true });
      return Promise.resolve();
    }
    const request = { ...frame };
    delete request.optionDetails;
    delete request.promptStyle;
    if (frame.method === "ask") {
      request.title = frame.title || frame.source?.subagentName || "OMP";
      request.questions = frame.questions.map(
        ({ id, question, options, multi, recommended }) => ({
          id,
          question,
          options: options.map(({ label, description }) => ({
            label,
            ...(description ? { description } : {}),
          })),
          ...(multi !== undefined ? { multi } : {}),
          ...(recommended !== undefined ? { recommended } : {}),
        }),
      );
    }
    if (!dialog) {
      if (
        [
          "notify",
          "setStatus",
          "setWidget",
          "setTitle",
          "set_editor_text",
        ].includes(frame.method)
      )
        return enqueue({ action: "request", request });
      return Promise.resolve(); // Login/open_url is intentionally not an authentication escape hatch.
    }
    const controller = new AbortController();
    const registration = post(
      { action: "request", request },
      controller.signal,
    );
    pending.set(frame.id, { controller, registration });
    return (async () => {
      try {
        let result = await registration;
        while (pending.has(frame.id)) {
          if (result.response) {
            const response = result.response;
            if (
              response.type !== "extension_ui_response" ||
              response.id !== frame.id
            )
              throw new Error("OMP_UI_PROTOCOL_INVALID");
            if (
              frame.method === "select" &&
              !response.cancelled &&
              !frame.options.includes(response.value)
            )
              throw new Error("OMP_UI_PROTOCOL_INVALID");
            pending.delete(frame.id);
            controller.abort();
            send(response);
            return;
          }
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 250);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
          if (!pending.has(frame.id)) return;
          result = await post(
            { action: "poll", id: frame.id },
            controller.signal,
          );
        }
      } catch (error) {
        if (!pending.has(frame.id)) return;
        send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        await retire(frame.id).catch(() => {});
        throw error;
      }
    })();
  }
  return {
    request,
    activity(activity) {
      return enqueue({ action: "activity", activity });
    },
    hook(hook) {
      return enqueue({ action: "hook", hook });
    },
    todos(phases, source) {
      let id = 0;
      const todos = (phases ?? []).flatMap((phase) =>
        (phase.tasks ?? []).map((task) => ({
          id: ++id,
          text: task.content,
          done: task.status === "completed",
          status: task.status,
          phase: phase.name,
          ...(task.blocker ? { blocker: task.blocker } : {}),
        })),
      );
      return enqueue({ action: "todos", todos, ...(source ? { source } : {}) });
    },
    async close() {
      stopped = true;
      await Promise.all(
        [...pending.keys()].map((id) => {
          send({ type: "extension_ui_response", id, cancelled: true });
          return retire(id);
        }),
      );
      await writes;
    },
  };
}
