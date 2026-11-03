"use client";
import { Button } from "@/components/motion/button";
import { SafeStreamdown } from "./SafeStreamdown";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, ExternalLink, RefreshCw } from "lucide-react";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/motion/popover";

export const SYSTEM_UPDATE_LOCAL_STATUS_PATH =
  "/api/v1/admin/system/update?local=1";
const RESTART_POLL_INTERVAL_MS = 1_500;
const RESTART_TIMEOUT_MS = 15 * 60_000;

type UpdateStatus = {
  enabled: boolean;
  canUpdate: boolean;
  runtimeId: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  releaseName: string | null;
  releaseUrl: string | null;
  repository: string;
  releaseNotes: string | null;
  artifactName: string;
  reason: string | null;
};

type UpdateResult = {
  ok: boolean;
  status:
    | "up_to_date"
    | "updating"
    | "restarting"
    | "disabled"
    | "unavailable"
    | "failed";
  runtimeId: string;
  currentVersion: string;
  latestVersion: string | null;
  artifactName: string;
  message?: string;
};

type LocalUpdateStatus = {
  runtimeId?: string;
  runtimeReady?: boolean;
  currentVersion: string;
  artifactName: string;
  updateJob?: {
    status: "idle" | "downloading" | "applying" | "restarting" | "failed";
    targetVersion: string | null;
    message: string | null;
  };
};

type UpdateWaitResult =
  | { status: "ready" }
  | { status: "failed"; message: string }
  | { status: "timeout" };

type UiState =
  | "idle"
  | "checking"
  | "updating"
  | "applying"
  | "restarting"
  | "error";

function versionsMatch(current: string, expected: string | null): boolean {
  return Boolean(expected && current.trim() === expected.trim());
}

export function systemUpdateVersionDetail(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): string | null {
  if (!currentVersion) return null;
  if (!latestVersion || versionsMatch(currentVersion, latestVersion))
    return currentVersion;
  return `${currentVersion} → ${latestVersion}`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function waitForSystemUpdateReady(
  expectedVersion: string | null,
  options: {
    previousRuntimeId?: string | null;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: LocalUpdateStatus["updateJob"]) => void;
    fallbackFailureMessage?: string;
    requestNotStartedMessage?: string;
  } = {},
): Promise<UpdateWaitResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? RESTART_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { status: "timeout" };
    try {
      const response = await fetchImpl(SYSTEM_UPDATE_LOCAL_STATUS_PATH, {
        cache: "no-store",
        signal: options.signal,
      });
      if (response.ok) {
        const data = (await response.json()) as LocalUpdateStatus;
        options.onProgress?.(data.updateJob);
        if (data.updateJob?.status === "failed") {
          return {
            status: "failed",
            message:
              data.updateJob.message ??
              options.fallbackFailureMessage ??
              "System update failed.",
          };
        }
        const versionReady = expectedVersion
          ? versionsMatch(data.currentVersion, expectedVersion)
          : Boolean(options.previousRuntimeId);
        const runtimeReplaced = options.previousRuntimeId
          ? Boolean(
              data.runtimeId && data.runtimeId !== options.previousRuntimeId,
            )
          : true;
        if (versionReady && runtimeReplaced) {
          // A new HTTP process can still be recovering or blocked by ownership.
          if (data.runtimeReady === true) return { status: "ready" };
        } else if (data.updateJob?.status === "idle") {
          return {
            status: "failed",
            message:
              options.requestNotStartedMessage ??
              "The update request did not start.",
          };
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        return { status: "timeout" };
    }
    await wait(
      Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
      options.signal,
    ).catch(() => undefined);
  }

  return { status: "timeout" };
}

export function SystemUpdateButton({
  canInstall,
  compact = false,
}: {
  canInstall: boolean;
  /** Icon-only trigger for the collapsed sidebar rail. */
  compact?: boolean;
}) {
  const t = useTranslations("console.systemUpdate");
  const settingsT = useTranslations("console.settings");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [uiState, setUiState] = useState<UiState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const restartPollRef = useRef<AbortController | null>(null);
  const checkedOnMountRef = useRef(false);

  const refresh = useCallback(async () => {
    setUiState((state) =>
      state === "updating" || state === "applying" || state === "restarting"
        ? state
        : "checking",
    );
    setMessage(null);
    try {
      const response = await fetch("/api/v1/admin/system/update", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
      const data = (await response.json()) as UpdateStatus;
      setStatus(data);
      setMessage(data.reason);
      setUiState("idle");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setUiState("error");
    }
  }, []);

  useEffect(() => {
    return () => restartPollRef.current?.abort();
  }, []);

  useEffect(() => {
    if (checkedOnMountRef.current) return;
    checkedOnMountRef.current = true;
    void refresh();
  }, [refresh]);

  const waitForRestart = useCallback(
    async (
      latestVersion: string | null,
      previousRuntimeId: string | null,
      requestError?: string,
    ) => {
      restartPollRef.current?.abort();
      const controller = new AbortController();
      restartPollRef.current = controller;
      const outcome = await waitForSystemUpdateReady(latestVersion, {
        previousRuntimeId,
        signal: controller.signal,
        onProgress(updateJob) {
          if (updateJob?.status === "downloading") {
            setUiState("updating");
            setMessage(updateJob.message ?? t("updating"));
          } else if (updateJob?.status === "applying") {
            setUiState("applying");
            setMessage(updateJob.message ?? t("applying"));
          } else if (updateJob?.status === "restarting") {
            setUiState("restarting");
            setMessage(updateJob.message ?? t("restarting"));
          }
        },
        fallbackFailureMessage: t("systemUpdateFailed"),
        requestNotStartedMessage: t("updateDidNotStart"),
      });
      if (controller.signal.aborted) return;
      if (outcome.status === "ready") {
        window.location.reload();
        return;
      }
      setMessage(
        outcome.status === "failed"
          ? outcome.message
          : (requestError ?? t("restartTimeout")),
      );
      setUiState("error");
    },
    [t],
  );

  const runUpdate = async () => {
    if (
      !canInstall ||
      !status?.canUpdate ||
      status.updateAvailable !== true ||
      uiState === "updating" ||
      uiState === "applying" ||
      uiState === "restarting"
    )
      return;
    if (
      !window.confirm(
        t("confirmUpdate", { version: status.latestVersion ?? "" }),
      )
    )
      return;
    setUiState("updating");
    setMessage(null);
    const targetVersion = status?.latestVersion ?? null;
    const previousRuntimeId = status?.runtimeId ?? null;
    try {
      const response = await fetch("/api/v1/admin/system/update", {
        method: "POST",
      });
      const result = (await response
        .json()
        .catch(() => null)) as UpdateResult | null;
      if (!response.ok) {
        if (result && !result.ok) {
          setMessage(
            result.message ?? `${response.status} ${response.statusText}`,
          );
          setUiState("error");
          return;
        }
        void waitForRestart(
          targetVersion,
          previousRuntimeId,
          `${response.status} ${response.statusText}`,
        );
        return;
      }
      if (!result?.ok) {
        void waitForRestart(
          targetVersion,
          previousRuntimeId,
          t("invalidUpdateResponse"),
        );
        return;
      }
      if (result.status === "updating" || result.status === "restarting") {
        setUiState(result.status === "restarting" ? "restarting" : "updating");
        setMessage(
          result.status === "restarting" ? t("restarting") : t("updating"),
        );
        void waitForRestart(
          result.latestVersion ?? targetVersion,
          result.runtimeId ?? previousRuntimeId,
        );
        return;
      }
      setUiState("idle");
      setMessage(t("upToDate"));
      await refresh();
    } catch (error) {
      // The reverse proxy can drop this request while the app is replacing its
      // runtime or restarting. Poll the authenticated local status endpoint to
      // distinguish that expected outage from a real update failure.
      void waitForRestart(
        targetVersion,
        previousRuntimeId,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const busy =
    uiState === "checking" ||
    uiState === "updating" ||
    uiState === "applying" ||
    uiState === "restarting";
  let label = t("checkAndUpdate");
  if (uiState === "checking") label = t("checking");
  else if (uiState === "updating") label = t("updating");
  else if (uiState === "applying") label = t("applying");
  else if (uiState === "restarting") label = t("restartingShort");
  else if (uiState === "error") label = t("failed");
  else if (status && !status.canUpdate) label = t("unavailable");
  else if (status?.updateAvailable === false) label = t("upToDate");
  else if (status?.updateAvailable === true) label = t("updateAvailable");

  const versionDetail = systemUpdateVersionDetail(
    status?.currentVersion,
    status?.latestVersion,
  );
  const detail = message || status?.reason || null;
  const showUpdate =
    canInstall && status?.canUpdate === true && status.updateAvailable === true;
  const hasUpdate = status?.updateAvailable === true;
  const triggerLabel = hasUpdate
    ? `${settingsT("systemUpdate")}: ${t("updateAvailable")}`
    : settingsT("systemUpdate");
  const activeStage =
    uiState === "updating"
      ? 0
      : uiState === "applying"
        ? 1
        : uiState === "restarting"
          ? 2
          : -1;
  const stages = [t("downloading"), t("applying"), t("restartingShort")];

  return (
    <Popover
      side="top"
      align="start"
      onOpenChange={(open) => {
        if (open && !busy) void refresh();
      }}
    >
      <PopoverTrigger>
        <Button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          variant="ghost"
          className={`relative h-9 shrink-0 gap-[9px] rounded-lg px-[9px] text-sm font-normal text-foreground hover:bg-foreground/5 ${compact ? "w-9 justify-center" : "w-full justify-start"}`}
        >
          {busy ? (
            <RefreshCw
              aria-hidden="true"
              className="size-[18px] shrink-0 animate-spin"
            />
          ) : (
            <MarkGithubIcon
              aria-hidden="true"
              size={18}
              className="size-[18px] shrink-0"
            />
          )}
          {compact ? null : (
            <span className="truncate">{settingsT("systemUpdate")}</span>
          )}
          {hasUpdate ? (
            <span
              aria-hidden="true"
              className={`absolute size-2 rounded-full bg-(--color-warning) ${compact ? "right-1.5 top-1.5" : "right-2 top-1/2 -translate-y-1/2"}`}
            />
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] w-[30rem] max-w-[calc(100vw-1rem)] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <div aria-live="polite" className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {settingsT("systemUpdate")}
            </p>
            {canInstall ? (
              <>
                <p
                  role={uiState === "error" ? "alert" : "status"}
                  className="mt-1 text-sm font-medium text-foreground"
                >
                  {label}
                </p>
                {detail ? (
                  <p
                    className="mt-0.5 break-words text-xs leading-5 text-muted-foreground"
                    title={detail}
                  >
                    {detail}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {canInstall ? (
            <Button
              type="button"
              onClick={refresh}
              disabled={busy}
              aria-label={t("checkAndUpdate")}
              title={t("checkAndUpdate")}
              variant="ghost"
              size="icon"
              className="shrink-0"
            >
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
            </Button>
          ) : null}
        </div>

        <dl
          aria-label={versionDetail ?? t("currentVersion")}
          className="grid grid-cols-2 gap-4 rounded-xl bg-muted/50 p-3"
        >
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("currentVersion")}
            </dt>
            <dd className="mt-1 break-all font-mono text-lg font-semibold">
              {status?.currentVersion ?? "—"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("latestVersion")}
            </dt>
            <dd className="mt-1 break-all font-mono text-lg font-semibold">
              {status?.latestVersion ?? "—"}
            </dd>
          </div>
        </dl>

        {status?.repository ? (
          <a
            href={`https://github.com/${status.repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <MarkGithubIcon aria-hidden="true" size={16} className="shrink-0" />
            <span className="min-w-0 flex-1 break-all">
              {status.repository}
            </span>
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
        ) : null}

        <section
          className="min-h-0 border-t border-border pt-4"
          aria-label={t("changelog")}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t("changelog")}</h3>
            {status?.releaseUrl ? (
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <span className="truncate">
                  {status.releaseName || status.latestVersion}
                </span>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              </a>
            ) : null}
          </div>
          {status?.releaseNotes?.trim() ? (
            <div className="max-h-64 overflow-y-auto overscroll-contain break-words pr-2 text-sm leading-6 [overflow-wrap:anywhere]">
              <SafeStreamdown mode="static" parseIncompleteMarkdown={false}>
                {status.releaseNotes}
              </SafeStreamdown>
            </div>
          ) : (
            <p className="py-3 text-sm text-muted-foreground">
              {uiState === "checking" ? t("checking") : t("noReleaseNotes")}
            </p>
          )}
        </section>

        {activeStage >= 0 ? (
          <ol aria-label={t("updateProgress")} className="flex flex-col gap-2">
            {stages.map((stage, index) => {
              const complete = index < activeStage;
              const active = index === activeStage;
              return (
                <li
                  key={stage}
                  className={`flex items-center gap-2 text-xs ${
                    active
                      ? "font-medium text-foreground"
                      : complete
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : complete
                          ? "bg-muted text-primary"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {complete ? (
                      <Check className="size-3" />
                    ) : active ? (
                      <RefreshCw className="size-3 animate-spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span>{stage}</span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {showUpdate ? (
          <Button
            type="button"
            onClick={runUpdate}
            disabled={
              uiState === "updating" ||
              uiState === "applying" ||
              uiState === "restarting"
            }
            variant="primary"
            size="sm"
            className="w-full"
          >
            {uiState === "updating" ||
            uiState === "applying" ||
            uiState === "restarting" ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {uiState === "updating"
              ? t("updating")
              : uiState === "applying"
                ? t("applying")
                : uiState === "restarting"
                  ? t("restartingShort")
                  : t("updateNow")}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
