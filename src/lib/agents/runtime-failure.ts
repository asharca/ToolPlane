import type { Task } from "@a2a-js/sdk";
import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

const mcpFailures = defineFailures({
  MCP_IMMUTABLE_IMAGE_REQUIRED: "MCP execution requires an immutable image.",
  MCP_CONNECTION_NOT_AUTHORIZED: "MCP connection not authorized.",
  MCP_CONNECTION_NOT_FOUND: "MCP connection not found.",
  MCP_CONNECTION_RESTART_REQUIRED: "it must be restarted before use",
  MCP_CONNECTION_UNAVAILABLE: "it cannot be reached right now",
  MCP_CREDENTIAL_INVALID: "its credential is invalid",
  MCP_CREDENTIAL_MIGRATION_REQUIRED: "its credential must be migrated first",
  MCP_CREDENTIAL_REQUIRED: "a required credential is missing",
  MCP_REAUTH_REQUIRED: "sign in to this MCP connection again",
  MCP_CREDENTIAL_SCOPE_INVALID: "its credential scope does not match",
  MCP_DEFINITION_CHANGED:
    "its configuration changed after the Agent was saved; save the Agent configuration again",
  MCP_GRANT_REVOKED: "this Agent's access was revoked",
  MCP_LISTING_UNAVAILABLE: "the plugin providing it was withdrawn",
  MCP_METHOD_FORBIDDEN: "MCP method forbidden.",
  MCP_PREPARATION_REQUIRED: "its runtime is not prepared yet",
  MCP_RESOURCE_UNAVAILABLE: "MCP resource unavailable.",
  MCP_RESULT_REDACTION_REQUIRED: "MCP result redaction required.",
  MCP_REVISION_FORBIDDEN: "this session's configuration is no longer valid",
  MCP_RUNTIME_FILES_CHANGED:
    "its runtime files changed after the Agent was saved; save the Agent configuration again",
  MCP_SANDBOX_UNAVAILABLE: "MCP sandbox unavailable.",
  MCP_SESSION_FORBIDDEN: "this session may not access it",
  MCP_SESSION_RECIPE_UNSUPPORTED: "MCP session recipe unsupported.",
  MCP_SESSION_REQUIRED: "MCP session required.",
  MCP_SESSION_STOP_FAILED: "MCP session stop failed.",
  MCP_SOURCE_IDENTITY_CHANGED: "MCP source identity changed.",
  MCP_SOURCE_UNAVAILABLE: "MCP source unavailable.",
  MCP_TOOLS_NOT_EXPOSED: "MCP tools not exposed.",
  MCP_TOOL_EXECUTION_UNKNOWN: "MCP tool execution unknown.",
  MCP_TOOL_FORBIDDEN: "no tools are enabled for this Agent",
  MCP_TOOL_SELECTION_CHANGED: "MCP tool selection changed.",
  MCP_TOOL_UNAVAILABLE: "the granted tools no longer exist",
  MCP_UNREACHABLE: "it could not be reached or returned an error",
});
const runtimeFailures = defineFailures({
  PI_CAPABILITY_CONFLICT: "PI capability conflict.",
  PI_CAPABILITY_PREFLIGHT_FAILED: "PI capability preflight failed.",
  PI_CAPABILITY_PREFLIGHT_TIMEOUT: "PI capability preflight timeout.",
  PI_EXECUTION_FAILED: "PI execution failed.",
  PI_EXTENSION_LOAD_FAILED:
    "A selected Pi extension failed to load. Check its headless SDK compatibility before starting a new conversation.",
  PI_EXTENSION_RESOURCE_DENIED:
    "The extension requested a resource outside this Agent's permitted directories. Execution was blocked.",
  PI_LSP_ARTIFACT_INVALID:
    "LSP dependencies failed offline integrity checks or installation. Ask an administrator to inspect the sandbox and restore the trusted LSP artifact.",
  PI_LSP_ARTIFACT_UNAVAILABLE:
    "LSP dependencies are unavailable. Ask an administrator to pull or build the configured LSP tools image on the application's Docker daemon, then try again.",
  PI_MCP_TOOLS_UNAVAILABLE:
    "MCP server “{name}” is unavailable: {reason}. This turn did not run; check the Agent's MCP settings and try again.",
  PI_OUTPUT_TRUNCATED: "The model stopped at its output limit.",
  PI_PACKAGE_CHECKSUM_MISMATCH:
    "The package snapshot was modified. Execution was blocked; ask an administrator to restore the reviewed snapshot.",
  PI_PACKAGE_ENV_CONFLICT:
    "A Pi package declares an environment variable that conflicts with another plugin or Agent credential. Review the Agent's plugins and credentials before continuing.",
  PI_PACKAGE_ENV_INCOMPLETE:
    "An enabled Pi package has incomplete environment configuration. Configure its platform preset or custom environment variables before continuing.",
  PI_PACKAGE_MCP_BINDING_REQUIRED:
    "This Pi package requires explicit MCP bindings in the current workspace. Open the package's installed-resource settings, choose permitted deployments and tools, then start a new Agent conversation or Work.",
  PI_PACKAGE_UNAVAILABLE:
    "An enabled Pi package is unavailable or no longer approved. Review the Agent's package bindings before continuing.",
  PI_PROCESS_STOP_UNCONFIRMED: "PI process stop unconfirmed.",
  PI_PROMPT_SOURCE_REQUIRED: "PI prompt source required.",
  PI_PROTOCOL_ERROR: "PI protocol error.",
  PI_SANDBOX_BUSY: "PI sandbox busy.",
  PI_SDK_ABORTED: "PI sdk aborted.",
  PI_SDK_ABORT_FAILED: "PI sdk abort failed.",
  PI_SDK_ARTIFACT_DIGEST_MISMATCH: "PI sdk artifact digest mismatch.",
  PI_SDK_ARTIFACT_METADATA_MISMATCH: "PI sdk artifact metadata mismatch.",
  PI_SDK_ARTIFACT_PREPARE_FAILED: "PI sdk artifact prepare failed.",
  PI_SDK_ARTIFACT_SIZE_MISMATCH: "PI sdk artifact size mismatch.",
  PI_SDK_ARTIFACT_TOO_LARGE: "PI sdk artifact too large.",
  PI_SDK_ARTIFACT_TRUNCATED: "PI sdk artifact truncated.",
  PI_SDK_ASYNC_FAILED: "PI sdk async failed.",
  PI_SDK_BUSY: "PI sdk busy.",
  PI_SDK_CACHE_DIGEST_MISMATCH: "PI sdk cache digest mismatch.",
  PI_SDK_CACHE_METADATA_MISMATCH: "PI sdk cache metadata mismatch.",
  PI_SDK_CACHE_SCOPE: "PI sdk cache scope.",
  PI_SDK_COMMAND_FAILED: "PI sdk command failed.",
  PI_SDK_COMMAND_UNKNOWN: "PI sdk command unknown.",
  PI_SDK_CONTEXT_REQUIRED: "PI sdk context required.",
  PI_SDK_ENTRY_NOT_FOUND:
    "The message's native session entry is missing. It cannot be replayed or branched; start a new Work.",
  PI_SDK_FAILED: "PI sdk failed.",
  PI_SDK_FORK_FAILED: "PI sdk fork failed.",
  PI_SDK_IMAGE_COMMAND_FAILED: "PI sdk image command failed.",
  PI_SDK_IMAGE_PLATFORM_MISMATCH: "PI sdk image platform mismatch.",
  PI_SDK_INSTALL_INCOMPLETE: "PI sdk install incomplete.",
  PI_SDK_INSTALL_SCOPE: "PI sdk install scope.",
  PI_SDK_INSTALL_TIMEOUT: "PI sdk install timeout.",
  PI_SDK_INTEGRITY_MISMATCH: "PI sdk integrity mismatch.",
  PI_SDK_LEGACY_RECOVERY_REQUIRED: "PI sdk legacy recovery required.",
  PI_SDK_MODEL_FAILED:
    "The Pi SDK model request failed or was interrupted. Check the provider and start a new request.",
  PI_SDK_MODEL_REQUIRED: "PI sdk model required.",
  PI_SDK_NAVIGATION_CANCELLED:
    "Native conversation navigation was cancelled. The turn did not run; existing history is preserved.",
  PI_SDK_PACKAGE_SET_CHANGED:
    "Enabled packages changed. Start a new conversation or Work to use them; existing history remains readable.",
  PI_SDK_PLATFORM_MISMATCH: "PI sdk platform mismatch.",
  PI_SDK_PREPARE_TIMEOUT: "PI sdk prepare timeout.",
  PI_SDK_PROTOCOL_ERROR: "PI sdk protocol error.",
  PI_SDK_PROTOCOL_INVALID: "PI sdk protocol invalid.",
  PI_SDK_QUEUE_FULL: "PI sdk queue full.",
  PI_SDK_QUEUE_INVALID: "PI sdk queue invalid.",
  PI_SDK_QUEUE_NOT_RUNNING: "PI sdk queue not running.",
  PI_SDK_REASONING_INVALID: "PI sdk reasoning invalid.",
  PI_SDK_REQUEST_FAILED:
    "The Pi session failed to start or run. No automatic replay was attempted. Common causes: the model service is unavailable, or an extension or MCP server failed to initialize. See this run's logs in Observability.",
  PI_SDK_REQUEST_INVALID: "PI sdk request invalid.",
  PI_SDK_RUNTIME_EXITED: "PI sdk runtime exited.",
  PI_SDK_RUNTIME_FAILED: "PI sdk runtime failed.",
  PI_SDK_SESSION_EXISTS: "PI sdk session exists.",
  PI_SDK_SESSION_MISSING:
    "The SDK session file or live unpersisted session is missing. Start a new conversation or Work; existing history remains readable.",
  PI_SDK_SESSION_SCOPE:
    "The extension tried to leave this Agent's private session directory. Execution was blocked.",
  PI_SDK_SHUTDOWN_TIMEOUT: "PI sdk shutdown timeout.",
  PI_SDK_TOOLSET_CHANGED:
    "Available tools changed. Start a new conversation or Work to use the current tools.",
  PI_SDK_UI_FAILED: "PI sdk ui failed.",
  PI_SDK_VERSION_MISMATCH:
    "This package requires a Pi SDK version this installation does not provide. Ask an administrator to check the installation.",
  PI_SKILL_PATH_INVALID: "PI skill path invalid.",
  PI_STORAGE_QUOTA_EXCEEDED: "PI storage quota exceeded.",
  PI_STREAM_RULE_DELIVERY_FAILED:
    "The streaming rule reminder could not be queued. Start a new request.",
  PI_TARGET_UNAVAILABLE: "PI target unavailable.",
  PI_TASK_AUTH_TIMEOUT:
    "The task expired while waiting for authorization. Confirm the required permissions before starting a new task; no automatic retry was attempted.",
  PI_TASK_DEPENDENCY_TIMEOUT:
    "The task expired while waiting for child-task results. Check child-task states and existing results to avoid duplicate operations; no automatic retry was attempted.",
  PI_TASK_FILE_TIMEOUT:
    "The task expired during file delivery or file preparation. Check the transfer status; no automatic retry was attempted.",
  PI_TASK_GENERATION_TIMEOUT:
    "The total task deadline was reached while the model was generating a response. Raise the Agent's task time limit for long work, or check existing output and continue in smaller steps; no automatic retry was attempted.",
  PI_TASK_INPUT_TIMEOUT:
    "The task expired while waiting for your response. Review the pending question before starting a new task; no automatic retry was attempted.",
  PI_TASK_MODEL_TIMEOUT:
    "The total task deadline was reached while waiting for a model response. It includes all earlier queueing, preparation and execution, so this does not establish a per-request model timeout. Raise the Agent's task time limit for long work, or split it and continue; no automatic retry was attempted.",
  PI_TASK_PREPARATION_TIMEOUT:
    "The total task deadline was reached during execution preparation. Check sandbox startup, runtime and resource preparation. No automatic retry was attempted.",
  PI_TASK_QUEUE_TIMEOUT:
    "The task expired while waiting for admission; execution had not started. This is not a model response timeout. Try again later; if it recurs, ask an administrator to check the queue and execution capacity.",
  PI_TASK_TIMEOUT:
    "The total task deadline was reached, including queueing, preparation and execution. The exact stage was not recorded, so a model or tool failure cannot be established. Check existing results; raise the Agent's task time limit for long work. No automatic retry was attempted.",
  PI_TASK_TOOL_TIMEOUT:
    "The total task deadline was reached while a tool was running. It may have performed partial operations. Check tool results and actual state before retrying to avoid duplicate actions; raise the Agent's task time limit for long work. No automatic retry was attempted.",
  MODEL_OVERRIDE_UNAVAILABLE:
    "This session's model override is no longer available. Send /model reset in the channel or choose another model.",
  AGENT_BUDGET_EXCEEDED:
    "This Agent has reached its monthly budget. Open Agent settings → Usage & budget to raise or remove the limit, or wait for the next UTC month.",
});

// Read-only compatibility for persisted results from the retired OMP runtime.
const historicalRuntimeFailures = defineFailures({
  OMP_MODEL_FAILED: "The retired OMP runtime's model request failed.",
});

type ActiveCode =
  | FailureCodeOf<typeof runtimeFailures>
  | FailureCodeOf<typeof mcpFailures>;
export type RuntimeFailure = { code: ActiveCode; reason?: string };
type StoredRuntimeFailure = {
  code: ActiveCode | FailureCodeOf<typeof historicalRuntimeFailures>;
  reason?: string;
};

const modelReasons = defineFailures({
  UNREACHABLE: "The provider could not be reached.",
  TIMEOUT: "The model request timed out.",
  EMPTY_STREAM: "The provider returned an empty stream.",
  STREAM_INCOMPLETE: "The provider stream ended prematurely.",
  CONTENT_FILTER: "The provider blocked the content.",
  PROVIDER_ERROR: "The provider reported an error.",
  GATEWAY_ERROR: "The model gateway reported an error.",
  OUTPUT_TRUNCATED: "The provider output was truncated.",
  INVALID_OUTPUT: "The provider output was invalid.",
});
const FAILURE =
  /^([A-Z][A-Z0-9_]*)(?=[:\s.]|$)(?::\s*([A-Z][A-Z0-9_]*(?: RETRIED_\d{1,2})?)(?=[\s.]|$))?/;

function failureReason(code: StoredRuntimeFailure["code"], detail?: string) {
  if (!detail) return undefined;
  if (code === "PI_SDK_MODEL_FAILED" || code === "OMP_MODEL_FAILED") {
    const reason = /^([A-Z][A-Z0-9_]*)(?: RETRIED_\d{1,2})?$/.exec(detail)?.[1];
    if (reason && (modelReasons.is(reason) || /^HTTP_[1-5]\d\d$/.test(reason)))
      return detail;
  }
  if (code === "PI_MCP_TOOLS_UNAVAILABLE" && mcpFailures.is(detail))
    return detail;
  return undefined;
}

export function parseRuntimeFailure(
  text: string | null | undefined,
): RuntimeFailure | undefined {
  const match = text ? FAILURE.exec(text) : null;
  if (!match) return undefined;
  const [, code, detail] = match;
  if (!runtimeFailures.is(code) && !mcpFailures.is(code)) return undefined;
  const reason = failureReason(code, detail);
  return reason ? { code, reason } : { code };
}

export function runtimeFailureText({ code, reason }: StoredRuntimeFailure) {
  const safeReason = failureReason(code, reason);
  return safeReason ? `${code}: ${safeReason}` : code;
}

/** The fixed failure recorded in a settled task's status message, if any. */
export function taskRuntimeFailure(
  task: Task,
): StoredRuntimeFailure | undefined {
  for (const part of task.status?.message?.parts ?? []) {
    if (part.content?.$case !== "text") continue;
    const failure = parseRuntimeFailure(part.content.value);
    if (failure) return failure;
    const match = FAILURE.exec(part.content.value);
    if (match && historicalRuntimeFailures.is(match[1])) {
      const reason = failureReason(match[1], match[2]);
      return reason ? { code: match[1], reason } : { code: match[1] };
    }
  }
  return undefined;
}

/** The `console.runtimeCommands` translator, from `useTranslations` or `createTranslator`. */
export type RuntimeFailureTranslator = {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
};

const DESCRIBED_CODE =
  /\b(AGENT_BUDGET_EXCEEDED|MODEL_OVERRIDE_UNAVAILABLE|(?:PI|OMP|MCP)_[A-Z0-9_]+|modelOverrideInvalid|modelOverrideUnavailable)\b(?::\s*([^\n]*))?/;

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
  if (
    !runtimeFailures.is(code) &&
    !mcpFailures.is(code) &&
    !historicalRuntimeFailures.is(code) &&
    code !== "modelOverrideInvalid" &&
    code !== "modelOverrideUnavailable"
  )
    return null;
  if (code === "PI_MCP_TOOLS_UNAVAILABLE") {
    const reason =
      failureReason(code, detail.trim().split(/\s+/, 1)[0]) ??
      "MCP_UNREACHABLE";
    return {
      code,
      text: t("PI_MCP_TOOLS_UNAVAILABLE", {
        name: "MCP",
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
      /^([A-Z][A-Z0-9_]*)(?: RETRIED_(\d{1,2}))?(?=[\s.]|$)/.exec(
        detail.trim(),
      ) ?? [];
    const kind = failureReason(code, reason)
      ? modelFailureKind(reason)
      : undefined;
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
