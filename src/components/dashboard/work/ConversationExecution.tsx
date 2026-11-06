"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { z } from "zod";
import {
  NativeProjectionSchema,
  NativeSessionUi,
  type NativeResponse,
} from "./NativeSessionUi";
import { ThinkingShimmer } from "@/components/agents/loading-states";
import { Button } from "@/components/motion/button";
import { notify } from "@/components/dashboard/Toaster";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";

const ExecutionResponse = z.object({
  execution: NativeProjectionSchema.extend({
    id: z.string(),
    status: z.string(),
    error: z
      .object({
        code: z.string(),
        reason: z.string().optional(),
        message: z.string(),
      })
      .optional(),
  }).nullable(),
});
type Execution = NonNullable<z.infer<typeof ExecutionResponse>["execution"]>;

const ACTIVE_STATUSES = new Set<string>([
  "queued",
  "running",
  "input-required",
]);
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 3;
const REVOKED_STATUSES = new Set([401, 403, 404]);

export function ConversationExecution({
  showStatus,
  endpoint,
  onSetEditorText,
  belowEditorElement,
  active = false,
  settingsHref,
  className,
  onChange,
  renderedActivityIds,
  showActivities = true,
  onBusyChange,
}: {
  /** Same-origin endpoint returning the native execution projection. */
  endpoint: string;
  onSetEditorText?: (text: string) => void;
  belowEditorElement?: HTMLDivElement | null;
  /** False where the conversation already shows its own progress and errors. */
  showStatus: boolean;
  /** Poll at the active rate while the surrounding view is running a turn. */
  active?: boolean;
  settingsHref?: string;
  /** Applied to the wrapper, which only renders when there is something to act on. */
  className?: string;
  onChange?: () => void;
  /** Settled child parts already rendered in the surrounding conversation. */
  renderedActivityIds?: readonly string[];
  /** False when the surrounding Work transcript owns live and persisted activities. */
  showActivities?: boolean;
  /** Reports whether the execution is active or its initial status is still unknown. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const describeRuntimeError = useRuntimeErrorText();
  const nativeT = useTranslations("console.work.nativeUi");
  const url = endpoint;
  const [execution, setExecution] = useState<Execution | null>(null);
  const [failed, setFailed] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [decisionFailed, setDecisionFailed] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const decisionFlight = useRef<AbortController | null>(null);
  const statusRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    activeRef.current = active;
    onChangeRef.current = onChange;
  }, [active, onChange]);
  const observedKey = useRef<string | null>(null);
  // Another scope never inherits this one's privileged dialog inputs.
  const [scope, setScope] = useState(url);
  if (scope !== url) {
    setScope(url);
    setExecution(null);
    setFailed(false);
    setRevoked(false);
    setDecisionFailed(false);
    setFresh(false);
    setBusyRequestId(null);
  }
  const executionStatus = execution?.status;
  useEffect(() => {
    onBusyChange?.(!fresh || ACTIVE_STATUSES.has(executionStatus ?? ""));
    return () => onBusyChange?.(false);
  }, [executionStatus, fresh, onBusyChange]);
  useEffect(() => {
    void url;
    return () => {
      decisionFlight.current?.abort();
      decisionFlight.current = null;
      observedKey.current = null;
      statusRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    // A decision or manual refresh restarts polling for the same conversation.
    void reload;
    if (revoked) return;
    let alive = true;
    let failures = 0;
    let stopped = false;
    let timer: number | undefined;
    let flight: AbortController | undefined;
    const schedule = () => {
      if (!alive || stopped || document.hidden || failures >= MAX_FAILURES)
        return;
      const base =
        activeRef.current || ACTIVE_STATUSES.has(statusRef.current ?? "")
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS;
      timer = window.setTimeout(load, base * (1 + failures));
    };
    async function load() {
      timer = undefined;
      if (!alive || stopped || document.hidden || flight) return;
      const controller = new AbortController();
      flight = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!alive) return;
        if (REVOKED_STATUSES.has(response.status)) {
          // Lost access: drop privileged inputs and stop asking.
          stopped = true;
          statusRef.current = null;
          setExecution(null);
          setRevoked(true);
          return;
        }
        if (!response.ok) throw new Error();
        const parsed = ExecutionResponse.safeParse(await response.json());
        if (!parsed.success) throw new Error();
        const next = parsed.data.execution;
        if (!alive) return;
        failures = 0;
        statusRef.current = next?.status ?? null;
        setExecution(next);
        setFailed(false);
        setFresh(true);
        const key = next ? `${next.id}:${next.status}` : "";
        if (observedKey.current !== null && observedKey.current !== key) {
          setDecisionFailed(false);
          onChangeRef.current?.();
        }
        observedKey.current = key;
      } catch {
        // Hiding the page aborts the read; that is not a failure.
        if (!alive || document.hidden) return;
        setFailed(true);
        setFresh(false);
        failures += 1;
        if (failures >= MAX_FAILURES) {
          statusRef.current = null;
          setExecution(null);
          setFailed(true);
        }
      } finally {
        clearTimeout(timeout);
        if (flight === controller) flight = undefined;
        schedule();
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      timer = undefined;
      setFresh(false);
      if (document.hidden) flight?.abort();
      else void load();
    };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      flight?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [url, reload, revoked]);

  // Pick up a turn started in the surrounding view without waiting a full idle tick.
  useEffect(() => {
    if (active) setReload((value) => value + 1);
  }, [active]);

  async function respond(result: NativeResponse) {
    if (
      decisionFlight.current ||
      failed ||
      revoked ||
      !fresh ||
      document.hidden ||
      !execution ||
      !ACTIVE_STATUSES.has(execution.status) ||
      !execution.uiRequests.some((request) => request.id === result.id)
    )
      return;
    const controller = new AbortController();
    decisionFlight.current = controller;
    // Leaving the conversation or unmounting releases ownership of the result.
    const owned = () => decisionFlight.current === controller;
    setBusyRequestId(result.id);
    setFresh(false);
    setDecisionFailed(false);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!owned()) return;
      if (REVOKED_STATUSES.has(response.status)) {
        statusRef.current = null;
        setExecution(null);
        setRevoked(true);
        return;
      }
      if (!response.ok) throw new Error();
      notify(nativeT("submitted"));
    } catch {
      // The outcome is unknown; never resend it. Show fresh state instead.
      if (owned()) setDecisionFailed(true);
    } finally {
      clearTimeout(timeout);
      if (owned()) {
        decisionFlight.current = null;
        setBusyRequestId(null);
        // Drop the decided request until the server state replaces it.
        setExecution((current) =>
          current
            ? {
                ...current,
                uiRequests: current.uiRequests.filter(
                  (item) => item.id !== result.id,
                ),
              }
            : current,
        );
        setReload((value) => value + 1);
      }
    }
  }

  function executionContent() {
    if (revoked) return null;

    if (failed)
      return (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          <span>{t("executionUnavailable")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => {
              setFailed(false);
              setReload((value) => value + 1);
            }}
          >
            {t("executionRefresh")}
          </Button>
        </div>
      );

    if (!execution || !ACTIVE_STATUSES.has(execution.status)) {
      if (!showStatus || execution?.status !== "failed") return null;
      // The server message is a fixed channel reply; show the cause in the
      // reader's language instead. MCP codes use the runtime's
      // "PI_MCP_TOOLS_UNAVAILABLE: REASON name" form.
      const code = execution.error?.code ?? "";
      const reason = execution.error?.reason;
      const runtimeError = describeRuntimeError(
        code.startsWith("MCP_")
          ? `PI_MCP_TOOLS_UNAVAILABLE: ${code} MCP`
          : reason
            ? `${code}: ${reason}`
            : code,
      );
      return (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          <span className="min-w-0 break-words">
            {runtimeError?.text ?? t("executionFailed")}
          </span>
          {runtimeError?.code === "PI_MCP_TOOLS_UNAVAILABLE" && settingsHref ? (
            <Link
              href={settingsHref}
              className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              {tAgents("configureAgent")}
            </Link>
          ) : null}
        </div>
      );
    }

    const pending = execution.uiRequests;
    if (!pending.length && !showStatus && !decisionFailed) return null;
    const statusLabel =
      execution.status === "queued"
        ? t("statusQueued")
        : execution.status === "running"
          ? t("statusRunning")
          : t("statusWaitingUser");

    return (
      <section aria-label={statusLabel} className="space-y-3">
        {decisionFailed ? (
          <p role="alert" className="px-1 text-sm text-muted-foreground">
            {t("executionDecisionUnknown")}
          </p>
        ) : null}
        {!pending.length && showStatus ? (
          <p role="status" className="px-1 text-sm text-muted-foreground">
            {execution.status === "queued" || execution.status === "running" ? (
              <ThinkingShimmer>{statusLabel}</ThinkingShimmer>
            ) : (
              statusLabel
            )}
          </p>
        ) : null}
      </section>
    );
  }

  const content = executionContent();
  const renderedIds = renderedActivityIds?.length
    ? new Set(renderedActivityIds)
    : null;
  const projection =
    execution && (!showActivities || renderedIds)
      ? {
          ...execution,
          activities: showActivities
            ? execution.activities.filter(
                (activity) =>
                  !renderedIds?.has(
                    `native-child:${execution.id}:${JSON.stringify([activity.type, activity.source.subagentId, activity.toolCallId ?? null])}`,
                  ),
              )
            : [],
          hooks: execution.hooks.filter(
            (hook) => !renderedIds?.has(`native-hook:${hook.id}`),
          ),
        }
      : execution;
  const hasProjection =
    projection &&
    (projection.todos.length ||
      projection.activities.length ||
      projection.hooks.length ||
      projection.uiRequests.length ||
      projection.uiEvents.length);
  return content || hasProjection ? (
    <div className={className}>
      {content}
      {!revoked && projection && hasProjection ? (
        <NativeSessionUi
          projection={projection}
          scope={`${url}:${projection.id}`}
          disabled={
            failed ||
            revoked ||
            !fresh ||
            !ACTIVE_STATUSES.has(projection.status)
          }
          busyId={busyRequestId}
          onRespond={(result) => void respond(result)}
          onSetEditorText={onSetEditorText}
          belowEditorElement={belowEditorElement}
        />
      ) : null}
    </div>
  ) : null;
}
