"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

const CODE =
  /\b(PI_[A-Z_]+|OMP_[A-Z_]+|modelOverrideInvalid|modelOverrideUnavailable)\b(?::\s*([^\n]*))?/;

/**
 * Turns a stored runtime failure (`CODE` or `CODE: detail`) into a sentence
 * that says what went wrong. Returns null for free-text errors.
 */
export function useRuntimeErrorText() {
  const t = useTranslations("console.runtimeCommands");
  return useCallback(
    (message: string | null | undefined) => {
      const match = message ? CODE.exec(message) : null;
      if (!match) return null;
      const [, code, detail = ""] = match;
      if (code === "PI_MCP_TOOLS_UNAVAILABLE") {
        const [, reason = "MCP_UNREACHABLE", name = ""] =
          /^([A-Z][A-Z0-9_]*)\s+([^\n]*)$/.exec(detail.trim()) ?? [];
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
