"use client";
import { Button } from "@/components/motion/button";
import { SafeStreamdown } from "./SafeStreamdown";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, ExternalLink, RefreshCw } from "lucide-react";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useTranslations } from "next-intl";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";

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
  const rawDetail = message || status?.reason || null;
  const detail = rawDetail === label ? null : rawDetail;
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

  // Same precedence as `label`, so the dot never contradicts the text.
  const statusTone =
    uiState === "error"
      ? "bg-(--color-destructive)"
      : busy
        ? "bg-primary"
        : status && !status.canUpdate
          ? "bg-muted-foreground"
          : hasUpdate
            ? "bg-(--color-warning)"
            : status?.updateAvailable === false
              ? "bg-(--color-success)"
              : "bg-muted-foreground";

  return (
    <MorphPopover
      className={compact ? undefined : "w-full"}
      onOpenChange={(open) => {
        if (open && !busy) void refresh();
      }}
    >
      <MorphPopoverTrigger>
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
      </MorphPopoverTrigger>

      <MorphPopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col border-foreground/15 bg-popover text-popover-foreground"
      >
        <header className="flex items-start gap-2 px-4 pb-3 pt-3.5">
          <div aria-live="polite" className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              {settingsT("systemUpdate")}
            </h2>
            <p
              className="mt-1 truncate font-mono text-xs text-muted-foreground"
              title={versionDetail ?? undefined}
            >
              {versionDetail ?? "—"}
            </p>
          </div>
          {status?.repository ? (
            <a
              href={`https://github.com/${status.repository}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={status.repository}
              title={status.repository}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <MarkGithubIcon aria-hidden="true" size={14} />
            </a>
          ) : null}
          {canInstall ? (
            <Button
              type="button"
              onClick={refresh}
              disabled={busy}
              aria-label={t("checkAndUpdate")}
              title={t("checkAndUpdate")}
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
            </Button>
          ) : null}
        </header>

        {canInstall ? (
          <div className="mx-3 mb-3 rounded-lg bg-foreground/[0.04] px-3 py-2">
            <p
              role={uiState === "error" ? "alert" : "status"}
              className="flex items-center gap-2 text-xs font-medium text-foreground"
            >
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${statusTone}`}
              />
              {label}
            </p>
            {detail ? (
              <p
                className="mt-1 line-clamp-3 break-words pl-3.5 text-xs leading-5 text-muted-foreground"
                title={detail}
              >
                {detail}
              </p>
            ) : null}
            {activeStage >= 0 ? (
              <ol
                aria-label={t("updateProgress")}
                className="mt-2 flex items-center gap-1.5 pl-3.5"
              >
                {stages.map((stage, index) => {
                  const complete = index < activeStage;
                  const active = index === activeStage;
                  return (
                    <li
                      key={stage}
                      className={`flex min-w-0 items-center gap-1 text-[11px] ${
                        active || complete
                          ? "text-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      {complete ? (
                        <Check className="size-3 shrink-0 text-primary" />
                      ) : active ? (
                        <RefreshCw className="size-3 shrink-0 animate-spin" />
                      ) : (
                        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                      )}
                      <span className="truncate">{stage}</span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        ) : null}

        <section
          className="border-t border-border px-4 py-3"
          aria-label={t("changelog")}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("changelog")}
            </h3>
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
            <div className="max-h-48 overflow-y-auto overscroll-contain break-words pr-1 text-xs leading-5 [overflow-wrap:anywhere] [&_h1]:mb-1 [&_h1]:mt-0 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-medium [&_li]:my-0 [&_li]:py-0.5 [&_p]:my-1 [&_ul]:my-1">
              <SafeStreamdown mode="static" parseIncompleteMarkdown={false}>
                {status.releaseNotes}
              </SafeStreamdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {uiState === "checking" ? t("checking") : t("noReleaseNotes")}
            </p>
          )}
        </section>

        {showUpdate ? (
          <footer className="border-t border-border p-3">
            <Button
              type="button"
              onClick={runUpdate}
              disabled={busy}
              variant="primary"
              size="sm"
              className="w-full"
            >
              {busy ? (
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
                    : uiState === "checking"
                      ? t("checking")
                      : t("updateNow")}
            </Button>
          </footer>
        ) : null}
      </MorphPopoverContent>
    </MorphPopover>
  );
}
