"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  AnimatedToastStack,
  type ToastInput,
  type ToastStatus,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";

type ToastSeverity = "info" | "warning" | "error";
type NotifyOptions = {
  afterReload?: boolean;
  severity?: ToastSeverity;
  description?: ReactNode;
  duration?: number;
};
type PendingToast = {
  title: string;
  severity?: ToastSeverity;
  description?: string;
  duration?: number;
};

const STORAGE_KEY = "toolplane:pending-toasts";
const listeners = new Set<(toast: ToastInput) => void>();

function toToastInput(title: string, options?: NotifyOptions): ToastInput {
  const severity = options?.severity;
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
    ...(options?.description !== undefined
      ? { description: options.description }
      : {}),
    duration:
      options?.duration ??
      (severity === "error" || severity === "warning" ? 6000 : 4200),
  };
}

/**
 * Shows a transient console notification. With `afterReload`, the toast is
 * queued in sessionStorage and shown after a full navigation.
 */
export function notify(title: string, options?: NotifyOptions) {
  if (options?.afterReload) {
    const pending: PendingToast = {
      title,
      ...(options.severity ? { severity: options.severity } : {}),
      ...(typeof options.description === "string" && options.description
        ? { description: options.description }
        : {}),
      ...(typeof options.duration === "number"
        ? { duration: options.duration }
        : {}),
    };
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([...readPending(), pending]),
      );
    } catch {
      /* Ignore storage quota or restricted sessionStorage errors. */
    }
    return;
  }
  const toast = toToastInput(title, options);
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
      add(
        toToastInput(item.title, {
          severity: item.severity,
          description: item.description,
          duration: item.duration,
        }),
      );
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
