"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/client/api";
import type {
  PluginSourceSyncJob,
  PluginSourceSyncSummary,
} from "@/lib/plugins/source-sync-types";

const POLL_MS = 3000;
const MAX_POLL_MS = 30_000;

/** In-flight jobs as a stable string; any difference means the rendered page is stale. */
function activeJobsKey(jobs: (PluginSourceSyncJob | null)[]) {
  return jobs
    .flatMap((job) => (job ? [`${job.id}:${job.status}`] : []))
    .join(",");
}

/**
 * Polls the sources API while any job is queued or running and refreshes the
 * server page once a watched job changes state, so results come from the page.
 */
export function PluginSourceSyncWatcher({
  workspace,
  activeJobs,
}: {
  workspace: string;
  activeJobs: (PluginSourceSyncJob | null)[];
}) {
  const router = useRouter();
  const watched = activeJobsKey(activeJobs);
  useEffect(() => {
    if (!watched) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let delay = POLL_MS;
    const schedule = () => {
      timer = window.setTimeout(() => void poll(), delay);
    };
    async function poll() {
      const result = await apiRequest<{
        items?: { activeJob?: PluginSourceSyncJob | null }[];
      }>(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/plugins/sources`,
        {
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        delay = POLL_MS;
        const current = activeJobsKey(
          (result.data?.items ?? []).map((item) => item.activeJob ?? null),
        );
        if (current !== watched) router.refresh();
      } else {
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
      schedule();
    }
    schedule();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [watched, workspace, router]);
  return null;
}

function formatElapsed(total: number) {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Queued/running state shown in place of the sync button. */
export function PluginSourceSyncProgress({
  job,
}: {
  job: PluginSourceSyncJob | null;
}) {
  const t = useTranslations("console.plugins");
  const startedAt = job?.status === "running" ? job.startedAt : null;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [startedAt]);
  const elapsed =
    startedAt && now !== null
      ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
      : null;
  return (
    <p
      role="status"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground empty:hidden"
    >
      {job ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {job.status === "running"
            ? t("sourceStatuses.syncing")
            : t("syncQueued")}
          {elapsed !== null ? (
            <time
              role="timer"
              dateTime={`PT${elapsed}S`}
              className="tabular-nums"
            >
              {formatElapsed(elapsed)}
            </time>
          ) : null}
        </>
      ) : null}
    </p>
  );
}

/** Outcome of the latest finished sync, plus the source's persistent error. */
export function PluginSourceSyncResult({
  activeJob,
  lastJob,
  error,
}: {
  activeJob: PluginSourceSyncJob | null;
  lastJob: PluginSourceSyncJob | null;
  /** Registry-level error; set only for failures that need the user. */
  error: string | null;
}) {
  const t = useTranslations("console.plugins");
  const failed = lastJob?.status === "failed" ? lastJob : null;
  // Only a failure that already queued its follow-up job is informational.
  const retried = failed?.retried === true;
  const summary =
    !activeJob && lastJob?.status === "succeeded" ? lastJob.summary : null;
  const showError = Boolean(error) && !activeJob;
  const failedPath =
    failed && failed.error === error ? failed.failedPath : null;
  return (
    <>
      <div role="status" className="mt-3 space-y-1.5 text-sm empty:hidden">
        {retried ? (
          <p className="text-muted-foreground">{t("syncRetried")}</p>
        ) : null}
        {summary ? <SyncSummary summary={summary} /> : null}
      </div>
      {showError ? (
        <div
          role="alert"
          className="mt-3 space-y-1 break-words rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>
            {t.has(`errors.${error}`)
              ? t(`errors.${error}`)
              : t("errors.registry_sync_failed")}
          </p>
          {failedPath ? (
            <p className="font-mono text-xs">
              {t("syncFailedPath", { path: failedPath })}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SyncSummary({ summary }: { summary: PluginSourceSyncSummary }) {
  const t = useTranslations("console.plugins");
  const groups: {
    label: string;
    items: { id: string; name: string; version?: string }[];
  }[] = [
    { label: t("syncAdded"), items: summary.added },
    { label: t("syncUpdated"), items: summary.updated },
    { label: t("syncRemoved"), items: summary.removed },
  ].filter((group) => group.items.length);
  const result = t("syncResult", { count: summary.resourceCount });
  return (
    <>
      {groups.length ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {[
              result,
              ...groups.map((group) => `${group.label} ${group.items.length}`),
            ].join(" · ")}
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {groups.map((group) => (
              <section key={group.label} className="min-w-0 space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex min-w-0 gap-1.5">
                      <span className="truncate">{item.name || item.id}</span>
                      {item.version ? (
                        <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">
                          v{item.version}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </details>
      ) : (
        <p className="text-muted-foreground">
          {result} · {t("syncNoChanges")}
        </p>
      )}
      {summary.unregistered.length ? (
        <details>
          <summary className="cursor-pointer text-(--color-warning)">
            {t("syncUnregistered", { count: summary.unregistered.length })}
          </summary>
          <p className="mt-2 text-muted-foreground">
            {t("syncUnregisteredHint")}
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs">
            {summary.unregistered.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
