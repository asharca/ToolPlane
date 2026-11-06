"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

const CODE =
  /\b(AGENT_BUDGET_EXCEEDED|MODEL_OVERRIDE_UNAVAILABLE|PI_[A-Z_]+|OMP_[A-Z_]+|modelOverrideInvalid|modelOverrideUnavailable)\b(?::\s*([^\n]*))?/;

function modelFailureKind(reason: string) {
  if (reason === "UNREACHABLE") return "unreachable";
  if (reason === "TIMEOUT") return "timeout";
  if (reason === "EMPTY_STREAM") return "emptyStream";
  if (reason === "STREAM_INCOMPLETE") return "streamIncomplete";
  if (reason === "CONTENT_FILTER") return "contentFilter";
  if (reason === "PROVIDER_ERROR") return "providerError";
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
export function useRuntimeErrorText() {
  const t = useTranslations("console.runtimeCommands");
  return useCallback(
    (message: string | null | undefined) => {
      if (message?.trim() === "Task deadline exceeded.")
        return { code: "PI_TASK_TIMEOUT", text: t("PI_TASK_TIMEOUT") };
      const match = message ? CODE.exec(message) : null;
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
    },
    [t],
  );
}
