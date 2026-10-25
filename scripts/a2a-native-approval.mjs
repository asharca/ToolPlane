/** Runtime-side pre-execution gate. No shell evaluation, redirects or credential logging. */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
const DENIED =
  "Tool execution was not approved. Review the request in the ToolPlane console.";
const MAX_INPUT = 16_384;
const WAIT_MS = 290_000; // Below platform expiry and the enclosing native turn timeout.
function settings() {
  const url = new URL(process.env.TOOLPLANE_APPROVAL_URL || "invalid:");
  const token = process.env.TOOLPLANE_RUNTIME_TOKEN;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!/^\/api\/v1\/agent-runtime\/a2a\/[^/]+\/approvals$/.test(url.pathname) &&
      url.pathname !== "/api/v1/agent-runtime/sessions/approvals") ||
    !token
  )
    throw new Error(DENIED);
  return { url, token };
}
async function post(body, signal) {
  const { url, token } = settings();
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_INPUT + 1024) throw new Error(DENIED);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
    : AbortSignal.timeout(8_000);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: payload,
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    await response.body?.cancel();
    throw new Error(DENIED);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(DENIED);
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error(DENIED);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function approvalReady() {
  if ((await post({ action: "ready" })).status !== "ready")
    throw new Error(DENIED);
}
export async function approveNativeTool(toolName, input, nativeCallId, signal) {
  try {
    if (typeof toolName !== "string" || !toolName || toolName.length > 200)
      return false;
    const body = {
      action: "check",
      callId:
        typeof nativeCallId === "string" && nativeCallId
          ? nativeCallId
          : randomUUID(),
      toolName,
      input,
    };
    // Serialize once: approval must describe the exact arguments, not a mutable live object.
    const frozen = JSON.parse(JSON.stringify(body));
    const expires = Date.now() + WAIT_MS;
    while (Date.now() < expires) {
      signal?.throwIfAborted();
      const result = await post(frozen, signal);
      if (result.status === "allow") return true;
      if (result.status !== "pending") return false;
      await sleep(2500, undefined, { signal });
    }
  } catch {
    /* An uncertain permission delivery is denial, never permission to retry an action. */
  }
  return false;
}
export function freezeArguments(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeArguments(child);
    Object.freeze(value);
  }
  return value;
}
