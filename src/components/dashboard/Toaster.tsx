"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AnimatedToastStack,
  type ToastInput,
  type ToastStatus,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";

type ToastSeverity = "info" | "warning" | "error";
type PendingToast = { title: string; severity?: ToastSeverity };

const STORAGE_KEY = "toolplane:pending-toasts";
const listeners = new Set<(toast: ToastInput) => void>();

function toToastInput(title: string, severity?: ToastSeverity): ToastInput {
  const status: ToastStatus =
    severity === "error"
      ? "error"
      : severity === "warning"
        ? "warning"
        : severity === "info"
          ? "info"
          : "success";
  return {
    id: `${status}:${title}`,
    status,
    title,
    duration: severity === "error" || severity === "warning" ? 6000 : 4200,
  };
}

/**
 * Shows a transient console notification. With `afterReload`, the toast is
 * queued in sessionStorage and shown after a full navigation.
 */
export function notify(
  title: string,
  options?: {
    afterReload?: boolean;
    severity?: ToastSeverity;
  },
) {
  if (options?.afterReload) {
    const pending: PendingToast = options.severity
      ? { title, severity: options.severity }
      : { title };
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...readPending(), pending]),
    );
    return;
  }
  const toast = toToastInput(title, options?.severity);
  for (const listener of listeners) listener(toast);
}

function parsePendingEntry(entry: unknown): PendingToast | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title) return null;
  if (
    record.severity === "info" ||
    record.severity === "warning" ||
    record.severity === "error"
  ) {
    return { title: record.title, severity: record.severity };
  }
  if (record.severity === undefined) {
    if (record.status === "error") {
      return { title: record.title, severity: "error" };
    }
    if (record.status === "info") {
      return {
        title: record.title,
        severity: record.icon ? "warning" : "info",
      };
    }
    return { title: record.title };
  }
  return null;
}

function readPending(): PendingToast[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .map(parsePendingEntry)
      .filter((entry): entry is PendingToast => entry !== null);
  } catch {
    return [];
  }
}

export function Toaster() {
  const common = useTranslations("common");
  const [paused, setPaused] = useState(false);
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({
    limit: 4,
    paused,
  });

  useEffect(() => {
    const add = (toast: ToastInput) => {
      showToast(toast);
    };
    listeners.add(add);
    const pending = readPending();
    sessionStorage.removeItem(STORAGE_KEY);
    for (const item of pending) {
      add(toToastInput(item.title, item.severity));
    }
    return () => {
      listeners.delete(add);
    };
  }, [showToast]);

  return (
    <AnimatedToastStack
      toasts={toasts}
      onDismiss={dismissToast}
      onPauseChange={setPaused}
      dismissLabel={common("close")}
      position="top-center"
      placement="fixed"
      maxVisible={4}
    />
  );
}
