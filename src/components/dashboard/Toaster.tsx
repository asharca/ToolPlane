"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import {
  AnimatedToastStack,
  type ToastInput,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";

const STORAGE_KEY = "toolplane:pending-toasts";
const listeners = new Set<(toast: ToastInput) => void>();

/**
 * Shows a transient console notification. With `afterReload`, the toast is
 * queued in sessionStorage and shown after a full navigation.
 */
export function notify(
  title: string,
  options?: {
    afterReload?: boolean;
    severity?: "info" | "warning" | "error";
  },
) {
  const toast: ToastInput = {
    status:
      options?.severity === "error"
        ? "error"
        : options?.severity
          ? "info"
          : "success",
    title,
    icon:
      options?.severity === "warning" ? (
        <TriangleAlert className="size-4" />
      ) : undefined,
  };
  if (options?.afterReload) {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...readPending(), toast]),
    );
    return;
  }
  for (const listener of listeners) listener(toast);
}

function readPending(): ToastInput[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function Toaster() {
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({
    limit: 5,
  });

  useEffect(() => {
    const add = (toast: ToastInput) => {
      showToast(toast);
    };
    listeners.add(add);
    const pending = readPending();
    sessionStorage.removeItem(STORAGE_KEY);
    for (const toast of pending) add(toast);
    return () => {
      listeners.delete(add);
    };
  }, [showToast]);

  return (
    <AnimatedToastStack
      toasts={toasts}
      onDismiss={dismissToast}
      position="bottom-right"
      placement="fixed"
    />
  );
}
