"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { describeRuntimeFailure } from "@/lib/agents/runtime-failure";

/**
 * Turns a stored runtime failure (`CODE` or `CODE: detail`) into a sentence
 * that says what went wrong. Returns null for free-text errors.
 */
export function useRuntimeErrorText() {
  const t = useTranslations("console.runtimeCommands");
  return useCallback(
    (message: string | null | undefined) => describeRuntimeFailure(t, message),
    [t],
  );
}
