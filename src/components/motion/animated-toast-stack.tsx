"use client";
// asharca.github.io/ui/components/motion/animated-toast-stack

import {
  AlertCircle,
  Bell,
  Check,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type ToastStatus =
  | "neutral"
  | "info"
  | "loading"
  | "success"
  | "warning"
  | "error";
export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type AnimatedToastAction = {
  label: ReactNode;
  onClick: (toast: AnimatedToast) => void;
};

export type AnimatedToast = {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  status?: ToastStatus;
  icon?: ReactNode;
  action?: AnimatedToastAction;
  duration?: number;
  dismissible?: boolean;
  createdAt?: number;
};

export type ToastInput = Omit<AnimatedToast, "id" | "createdAt"> & {
  id?: string;
};

export type ToastClassNames = {
  root?: string;
  item?: string;
  surface?: string;
  iconWrap?: string;
  content?: string;
  title?: string;
  description?: string;
  action?: string;
  close?: string;
  progress?: string;
};

export interface AnimatedToastStackProps {
  toasts: AnimatedToast[];
  onDismiss?: (id: string) => void;
  dismissLabel?: string;
  onPauseChange?: (paused: boolean) => void;
  position?: ToastPosition;
  placement?: "static" | "fixed" | "absolute";
  fixed?: boolean;
  portal?: boolean;
  portalRoot?: Element | null;
  maxVisible?: number;
  className?: string;
  classNames?: ToastClassNames;
  icons?: Partial<Record<ToastStatus, ReactNode>>;
  renderToast?: (toast: AnimatedToast) => ReactNode;
}

export interface UseAnimatedToastStackOptions {
  initialToasts?: ToastInput[];
  defaultDuration?: number;
  limit?: number;
  paused?: boolean;
}

const STACK_SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.75,
};

const CONTENT_TRANSITION = {
  duration: 0.28,
  ease: EASE_OUT,
} as const;

const STATUS_ICON: Record<ToastStatus, LucideIcon> = {
  neutral: Bell,
  info: Info,
  loading: LoaderCircle,
  success: Check,
  warning: TriangleAlert,
  error: AlertCircle,
};

const STATUS_CLASS: Record<ToastStatus, string> = {
  neutral: "text-muted-foreground bg-muted/60",
  info: "text-primary bg-muted",
  loading: "text-primary bg-muted",
  success: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400",
  warning: "text-amber-600 bg-amber-500/10 dark:text-amber-400",
  error: "text-destructive bg-destructive/10",
};

const POSITION_CLASS: Record<ToastPosition, string> = {
  "top-left": "left-4 top-[max(1rem,env(safe-area-inset-top))]",
  "top-center":
    "left-1/2 top-[max(1rem,env(safe-area-inset-top))] -translate-x-1/2",
  "top-right": "right-4 top-[max(1rem,env(safe-area-inset-top))]",
  "bottom-left": "bottom-6 left-4",
  "bottom-center": "bottom-6 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-6 right-4",
};

let idSeed = 0;

function createToast(
  input: ToastInput,
  defaultDuration: number,
): AnimatedToast {
  return {
    duration: defaultDuration,
    dismissible: true,
    ...input,
    id: input.id ?? `toast-${Date.now()}-${idSeed++}`,
    createdAt: Date.now(),
  };
}

export function useAnimatedToastStack({
  initialToasts = [],
  defaultDuration = 4200,
  limit,
  paused = false,
}: UseAnimatedToastStackOptions = {}) {
  const toastTimers = useRef<
    Map<
      string,
      {
        timer: number | null;
        remaining: number;
        startedAt: number | null;
        signature: string;
      }
    >
  >(new Map());
  const [toasts, setToasts] = useState<AnimatedToast[]>(() =>
    initialToasts.map((toast) => createToast(toast, defaultDuration)),
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (input: ToastInput) => {
      const toast = createToast(input, defaultDuration);
      setToasts((current) => {
        const existingIndex = current.findIndex((item) => item.id === toast.id);
        if (existingIndex !== -1) {
          const next = [...current];
          next[existingIndex] = { ...current[existingIndex], ...toast };
          return typeof limit === "number" ? next.slice(-limit) : next;
        }
        const next = [...current, toast];
        return typeof limit === "number" ? next.slice(-limit) : next;
      });
      return toast.id;
    },
    [defaultDuration, limit],
  );

  const updateToast = useCallback((id: string, patch: Partial<ToastInput>) => {
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id
          ? {
              ...toast,
              ...patch,
              id,
              createdAt:
                patch.duration === undefined ? toast.createdAt : Date.now(),
            }
          : toast,
      ),
    );
  }, []);

  useEffect(() => {
    const activeIds = new Set(toasts.map((toast) => toast.id));

    toastTimers.current.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
        toastTimers.current.delete(id);
      }
    });

    const now = Date.now();

    toasts.forEach((toast) => {
      const duration = toast.duration ?? defaultDuration;
      const existing = toastTimers.current.get(toast.id);

      if (duration <= 0) {
        if (existing) {
          if (existing.timer !== null) window.clearTimeout(existing.timer);
          toastTimers.current.delete(toast.id);
        }
        return;
      }

      const createdAt = toast.createdAt ?? now;
      const signature = `${createdAt}:${duration}`;

      if (paused) {
        if (existing && existing.signature === signature) {
          if (existing.timer !== null) {
            window.clearTimeout(existing.timer);
            const elapsed =
              existing.startedAt !== null ? now - existing.startedAt : 0;
            toastTimers.current.set(toast.id, {
              timer: null,
              remaining: Math.max(existing.remaining - elapsed, 0),
              startedAt: null,
              signature,
            });
          }
        } else {
          if (existing?.timer !== null && existing?.timer !== undefined) {
            window.clearTimeout(existing.timer);
          }
          toastTimers.current.set(toast.id, {
            timer: null,
            remaining: Math.max(duration - (now - createdAt), 0),
            startedAt: null,
            signature,
          });
        }
        return;
      }

      if (existing?.signature === signature && existing.timer !== null) {
        return;
      }

      if (existing?.timer !== null && existing?.timer !== undefined) {
        window.clearTimeout(existing.timer);
      }

      const delay =
        existing && existing.signature === signature && existing.timer === null
          ? Math.min(duration, Math.max(existing.remaining, 1000))
          : Math.max(duration - (now - createdAt), 0);

      const timer = window.setTimeout(() => {
        toastTimers.current.delete(toast.id);
        dismissToast(toast.id);
      }, delay);

      toastTimers.current.set(toast.id, {
        timer,
        remaining: delay,
        startedAt: now,
        signature,
      });
    });
  }, [defaultDuration, dismissToast, paused, toasts]);

  useEffect(() => {
    const timers = toastTimers.current;

    return () => {
      timers.forEach((entry) => {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
      });
      timers.clear();
    };
  }, []);

  return useMemo(
    () => ({
      toasts,
      showToast,
      updateToast,
      dismissToast,
      clearToasts,
      setToasts,
    }),
    [clearToasts, dismissToast, showToast, toasts, updateToast],
  );
}

export function AnimatedToastStack({
  toasts,
  onDismiss,
  dismissLabel = "Dismiss toast",
  onPauseChange,
  position = "bottom-right",
  placement,
  fixed = false,
  portal,
  portalRoot,
  maxVisible = 4,
  className,
  classNames,
  icons,
  renderToast,
}: AnimatedToastStackProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visibleToasts = toasts.slice(-maxVisible);
  const isBottom = position.startsWith("bottom");
  const resolvedPlacement = placement ?? (fixed ? "fixed" : "static");
  const shouldPortal = portal ?? resolvedPlacement === "fixed";

  useEffect(() => {
    setPortalTarget(shouldPortal ? (portalRoot ?? document.body) : null);
  }, [portalRoot, shouldPortal]);

  useEffect(() => {
    if (visibleToasts.length === 0) {
      setHovered(false);
      setFocused(false);
    }
  }, [visibleToasts.length]);

  useEffect(() => {
    onPauseChange?.(visibleToasts.length > 0 && (hovered || focused));
  }, [focused, hovered, onPauseChange, visibleToasts.length]);

  const stack = (
    <ol
      data-toast-stack=""
      aria-live="polite"
      aria-atomic="false"
      onPointerOver={() => setHovered(true)}
      onPointerOut={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setHovered(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setFocused(false);
      }}
      className={cn(
        "pointer-events-none flex w-[calc(100vw-2rem)] max-w-sm gap-2",
        isBottom ? "flex-col-reverse" : "flex-col",
        resolvedPlacement === "fixed" && "fixed z-[11000]",
        resolvedPlacement === "absolute" && "absolute z-20",
        resolvedPlacement !== "static" && POSITION_CLASS[position],
        classNames?.root,
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {visibleToasts.map((toast, index) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            index={index}
            isBottom={isBottom}
            dismissLabel={dismissLabel}
            onDismiss={onDismiss}
            classNames={classNames}
            icons={icons}
            renderToast={renderToast}
          />
        ))}
      </AnimatePresence>
    </ol>
  );

  if (shouldPortal && !portalTarget) {
    return null;
  }

  if (shouldPortal && portalTarget) {
    return createPortal(stack, portalTarget);
  }

  return stack;
}

const ToastItem = memo(function ToastItem({
  toast,
  index,
  isBottom,
  dismissLabel,
  onDismiss,
  classNames,
  icons,
  renderToast,
}: {
  toast: AnimatedToast;
  index: number;
  isBottom: boolean;
  dismissLabel: string;
  onDismiss?: (id: string) => void;
  classNames?: ToastClassNames;
  icons?: Partial<Record<ToastStatus, ReactNode>>;
  renderToast?: (toast: AnimatedToast) => ReactNode;
}) {
  const reduce = useReducedMotion();
  const status = toast.status ?? "neutral";
  const Icon = STATUS_ICON[status];
  const iconNode = icons?.[status] ?? toast.icon ?? (
    <Icon className="h-3.5 w-3.5" />
  );
  const canDismiss = toast.dismissible !== false && Boolean(onDismiss);
  const hasDetails = Boolean(toast.description || toast.action);

  return (
    <motion.li
      layout
      initial={
        reduce
          ? { opacity: 0 }
          : {
              opacity: 0,
              y: isBottom ? 22 : -18,
              scale: 0.96,
              filter: "blur(10px)",
            }
      }
      animate={
        reduce
          ? { opacity: 1 }
          : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
      }
      exit={
        reduce
          ? { opacity: 0 }
          : {
              opacity: 0,
              x: 32,
              scale: 0.96,
              filter: "blur(8px)",
              transition: { duration: 0.18, ease: EASE_OUT },
            }
      }
      transition={STACK_SPRING}
      drag={canDismiss && !reduce ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.18}
      onDragEnd={(_, info) => {
        if (!canDismiss || !onDismiss) return;
        if (Math.abs(info.offset.x) > 72 || Math.abs(info.velocity.x) > 520) {
          onDismiss(toast.id);
        }
      }}
      className={cn(
        "pointer-events-auto relative will-change-transform",
        classNames?.item,
      )}
      style={{ zIndex: 20 - index }}
    >
      <div
        role={status === "error" ? "alert" : "status"}
        className={cn(
          "relative overflow-hidden rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-xl",
          classNames?.surface,
        )}
      >
        {renderToast ? (
          renderToast(toast)
        ) : (
          <div
            className={cn(
              "flex gap-3",
              hasDetails ? "items-start" : "items-center",
            )}
          >
            <motion.span
              layout
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                hasDetails && "mt-0.5",
                STATUS_CLASS[status],
                classNames?.iconWrap,
              )}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={status}
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: 8, scale: 0.8, filter: "blur(6px)" }
                  }
                  animate={
                    reduce
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
                  }
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: -8, scale: 0.9, filter: "blur(6px)" }
                  }
                  transition={CONTENT_TRANSITION}
                  className="inline-flex"
                >
                  {status === "loading" ? (
                    <span className="inline-flex animate-spin">{iconNode}</span>
                  ) : (
                    iconNode
                  )}
                </motion.span>
              </AnimatePresence>
            </motion.span>

            <div className={cn("min-w-0 flex-1", classNames?.content)}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={`${toast.id}-${status}-${String(toast.title)}`}
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: 8, filter: "blur(6px)" }
                  }
                  animate={
                    reduce
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0, filter: "blur(0px)" }
                  }
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: -8, filter: "blur(6px)" }
                  }
                  transition={CONTENT_TRANSITION}
                >
                  <p
                    className={cn(
                      "line-clamp-3 break-words text-sm font-medium leading-5 text-foreground",
                      classNames?.title,
                    )}
                  >
                    {toast.title}
                  </p>
                  {toast.description ? (
                    <p
                      className={cn(
                        "mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground",
                        classNames?.description,
                      )}
                    >
                      {toast.description}
                    </p>
                  ) : null}
                </motion.div>
              </AnimatePresence>

              {toast.action ? (
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => toast.action?.onClick(toast)}
                  className={cn(
                    "mt-2 inline-flex h-7 items-center rounded-full bg-muted/80 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted",
                    classNames?.action,
                  )}
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>

            {canDismiss ? (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onDismiss?.(toast.id)}
                aria-label={dismissLabel}
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground",
                  classNames?.close,
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </motion.li>
  );
});
