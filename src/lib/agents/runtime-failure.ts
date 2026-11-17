import type { Task } from "@a2a-js/sdk";

/**
 * Runtime failures cross the sandbox, task-ledger and browser boundaries as
 * fixed tokens only: `CODE` plus an optional allowlisted reason. Native error
 * text can contain credentials or task content and never escapes.
 */
const MODEL_REASON =
  "HTTP_[1-5]\\d\\d|UNREACHABLE|TIMEOUT|EMPTY_STREAM|STREAM_INCOMPLETE|CONTENT_FILTER|PROVIDER_ERROR|GATEWAY_ERROR";
const FAILURE = new RegExp(
  `^((?:PI|OMP|MCP)_[A-Z0-9_]{1,60}|MODEL_OVERRIDE_UNAVAILABLE|AGENT_BUDGET_EXCEEDED)(?=[:\\s.]|$)(?::\\s*((?:${MODEL_REASON})(?: RETRIED_\\d{1,2})?|MCP_[A-Z0-9_]{1,40})(?=[\\s.]|$))?`,
);

export type RuntimeFailure = { code: string; reason?: string };

export function parseRuntimeFailure(
  text: string | null | undefined,
): RuntimeFailure | undefined {
  const match = text ? FAILURE.exec(text) : null;
  if (!match) return undefined;
  return match[2] ? { code: match[1], reason: match[2] } : { code: match[1] };
}

export function runtimeFailureText({ code, reason }: RuntimeFailure) {
  return reason ? `${code}: ${reason}` : code;
}

/** The fixed failure recorded in a settled task's status message, if any. */
export function taskRuntimeFailure(task: Task): RuntimeFailure | undefined {
  for (const part of task.status?.message?.parts ?? []) {
    if (part.content?.$case !== "text") continue;
    const failure = parseRuntimeFailure(part.content.value);
    if (failure) return failure;
  }
  return undefined;
}

/** The `console.runtimeCommands` translator, from `useTranslations` or `createTranslator`. */
export type RuntimeFailureTranslator = {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
};

const DESCRIBED_CODE =
  /\b(AGENT_BUDGET_EXCEEDED|MODEL_OVERRIDE_UNAVAILABLE|PI_[A-Z_]+|OMP_[A-Z_]+|modelOverrideInvalid|modelOverrideUnavailable)\b(?::\s*([^\n]*))?/;

function modelFailureKind(reason: string) {
  if (reason === "UNREACHABLE") return "unreachable";
  if (reason === "TIMEOUT") return "timeout";
  if (reason === "EMPTY_STREAM") return "emptyStream";
  if (reason === "STREAM_INCOMPLETE") return "streamIncomplete";
  if (reason === "CONTENT_FILTER") return "contentFilter";
  if (reason === "PROVIDER_ERROR") return "providerError";
  if (reason === "GATEWAY_ERROR") return "gatewayError";
  const status = Number(/^HTTP_(\d{3})$/.exec(reason)?.[1]);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "rejected";
  return undefined;
}

/**
 * Turns a stored runtime failure (`CODE` or `CODE: detail`) into a sentence
 * that says what went wrong. Returns null for free-text errors.
 */
export function describeRuntimeFailure(
  t: RuntimeFailureTranslator,
  message: string | null | undefined,
): { code: string; text: string } | null {
  if (message?.trim() === "Task deadline exceeded.")
    return { code: "PI_TASK_TIMEOUT", text: t("PI_TASK_TIMEOUT") };
  const match = message ? DESCRIBED_CODE.exec(message) : null;
  if (!match) return null;
  const [, code, detail = ""] = match;
  if (code === "PI_MCP_TOOLS_UNAVAILABLE") {
    const [, reason = "MCP_UNREACHABLE", name = ""] =
      /^([A-Z][A-Z0-9_]*)(?:\s+([^\n]*))?$/.exec(detail.trim()) ?? [];
    return {
      code,
      text: t("PI_MCP_TOOLS_UNAVAILABLE", {
        name: name || "MCP",
        reason: t(
          t.has(`mcpUnavailableReasons.${reason}`)
            ? `mcpUnavailableReasons.${reason}`
            : "mcpUnavailableReasons.MCP_UNREACHABLE",
        ),
      }),
    };
  }
  if (code === "PI_SDK_MODEL_FAILED" || code === "OMP_MODEL_FAILED") {
    const [, reason = "", retried] =
      /^([A-Z][A-Z0-9_]*)(?: RETRIED_(\d{1,2}))?/.exec(detail.trim()) ?? [];
    const kind = modelFailureKind(reason);
    if (kind) {
      const text = t(`modelFailure.${kind}`, {
        status: reason.replace(/^HTTP_/, ""),
      });
      return {
        code,
        text: retried
          ? `${text} ${t("modelFailure.retried", { count: Number(retried) })}`
          : text,
      };
    }
  }
  return {
    code,
    text: t.has(code)
      ? t(code)
      : t(
          code.startsWith("OMP_")
            ? "ompExecutionFailedWithCode"
            : "sdkExecutionFailedWithCode",
          { code },
        ),
  };
}
