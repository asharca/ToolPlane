import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
  type AdminBadgeTone,
} from "@/components/admin/AdminUI";
import { AdminFeedbackStatusForm } from "@/components/admin/AdminFeedbackStatusForm";
import { getAdminFeedbackDetail } from "@/lib/admin/feedback";
import { requireAdmin } from "@/lib/auth/admin";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import type { FeedbackSource, FeedbackStatus } from "@/lib/feedback/types";

export const dynamic = "force-dynamic";

function sourceTone(source: FeedbackSource): AdminBadgeTone {
  switch (source) {
    case "system":
      return "warning";
    case "model":
      return "info";
    case "user":
      return "neutral";
  }
}

function statusTone(status: FeedbackStatus): AdminBadgeTone {
  switch (status) {
    case "open":
      return "warning";
    case "acknowledged":
      return "info";
    case "resolved":
      return "success";
    case "dismissed":
      return "neutral";
  }
}

export default async function AdminFeedbackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [{ id }, query, t, locale, admin] = await Promise.all([
    params,
    searchParams,
    getTranslations("adminFeedback"),
    getLocale(),
    requireAdmin(),
  ]);

  const item = await getAdminFeedbackDetail(id);
  if (!item) notFound();

  const timeZone = resolveUserTimeZone(admin);
  const backHref = query.returnTo?.startsWith("/admin/feedback")
    ? query.returnTo
    : "/admin/feedback";

  const formatDate = (value: string | null) =>
    value
      ? formatInTimeZone(
          value,
          timeZone,
          {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          },
          locale,
        )
      : "—";

  const metadataRows: Array<{
    label: string;
    value: string | null;
    mono?: boolean;
  }> = [
    { label: t("platformVersion"), value: item.platformVersion, mono: true },
    { label: t("failureCode"), value: item.failureCode, mono: true },
    { label: t("failureReason"), value: item.failureReason },
    { label: t("executionStage"), value: item.executionStage, mono: true },
    {
      label: t("occurrencesColumn"),
      value: item.occurrences.toLocaleString(),
    },
    { label: t("firstSeenAt"), value: formatDate(item.firstSeenAt) },
    { label: t("lastSeenAt"), value: formatDate(item.lastSeenAt) },
    {
      label: t("workspaceColumn"),
      value: item.workspaceName
        ? `${item.workspaceName}${item.workspaceSlug ? ` (${item.workspaceSlug})` : ""}`
        : item.workspaceSlug,
    },
    { label: t("agentLabel"), value: item.agentName ?? item.agentId },
    { label: t("submittedBy"), value: item.submittedByEmail },
    { label: t("approvedBy"), value: item.approvedByEmail },
  ];

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={item.title}
        backHref={backHref}
        backLabel={t("backToList")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <AdminBadge tone={sourceTone(item.source)}>
              {t(`sources.${item.source}`)}
            </AdminBadge>
            <AdminBadge tone="neutral">
              {t(`categories.${item.category}`)}
            </AdminBadge>
            <AdminBadge tone={statusTone(item.status)} dot>
              {t(`statuses.${item.status}`)}
            </AdminBadge>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {item.body ? (
            <AdminPanel title={t("bodyPanelTitle")}>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                {item.body}
              </p>
            </AdminPanel>
          ) : null}

          {item.screenshotDataUrl ? (
            <AdminPanel
              title={t("screenshotPanelTitle")}
              description={t("screenshotPanelDescription")}
            >
              {/* biome-ignore lint/performance/noImgElement: Inline base64 data URL screenshot cannot use next/image optimizer. */}
              <img
                src={item.screenshotDataUrl}
                alt={t("screenshotAlt")}
                className="max-h-96 w-auto rounded-lg border border-border object-contain"
              />
            </AdminPanel>
          ) : null}

          {item.diagnosticLogs && item.diagnosticLogs.length > 0 ? (
            <AdminPanel
              title={t("diagnosticLogsPanelTitle")}
              description={t("diagnosticLogsPanelDescription")}
            >
              <ul className="space-y-2.5 text-xs">
                {item.diagnosticLogs.map((entry, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: Diagnostic logs are an immutable ordered list.
                    key={index}
                    className="rounded-xl border border-border/80 bg-muted/30 p-3"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-muted-foreground">
                      <AdminBadge
                        tone={
                          entry.level === "error"
                            ? "danger"
                            : entry.level === "warn"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {entry.level.toUpperCase()}
                      </AdminBadge>
                      <span className="font-mono font-medium text-foreground">
                        {entry.source}
                      </span>
                      {entry.code ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                          {entry.code}
                        </span>
                      ) : null}
                      {entry.stage ? (
                        <span className="font-mono text-[11px]">
                          {t("executionStageLabel", { stage: entry.stage })}
                        </span>
                      ) : null}
                      {entry.occurredAt ? (
                        <span className="ml-auto">
                          {formatDate(entry.occurredAt)}
                        </span>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words font-mono text-foreground">
                      {entry.message}
                    </p>
                  </li>
                ))}
              </ul>
            </AdminPanel>
          ) : null}

          <AdminPanel title={t("metadataPanelTitle")}>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {metadataRows.map((row) => (
                <div key={row.label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{row.label}</dt>
                  <dd
                    className={`mt-0.5 break-words text-foreground ${row.mono ? "font-mono text-xs" : ""}`}
                  >
                    {row.value || "—"}
                  </dd>
                </div>
              ))}
            </dl>

            {item.taskId ? (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4 text-xs">
                <Link
                  href={`/admin/logs/a2a/${encodeURIComponent(item.taskId)}`}
                  className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t("viewA2aLog")}
                </Link>
                <Link
                  href={`/admin/logs/runs/${encodeURIComponent(item.taskId)}`}
                  className="rounded-lg border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t("viewRunLog")}
                </Link>
              </div>
            ) : null}
          </AdminPanel>

          {item.conversationSnippet && item.conversationSnippet.length > 0 ? (
            <AdminPanel
              title={t("snippetPanelTitle")}
              description={t("snippetPanelDescription")}
            >
              <ol className="space-y-3">
                {item.conversationSnippet.map((entry, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: Redacted transcript snippet is an immutable ordered list.
                    key={index}
                    className="rounded-xl border border-border/80 bg-muted/30 p-3 text-xs"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-muted-foreground">
                      <span className="font-semibold uppercase tracking-wide">
                        {entry.role}
                      </span>
                      {entry.createdAt ? (
                        <span>{formatDate(entry.createdAt)}</span>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-foreground">
                      {entry.text}
                    </p>
                  </li>
                ))}
              </ol>
            </AdminPanel>
          ) : null}

          {item.occurrenceRecords.length > 0 ? (
            <AdminPanel title={t("occurrencesPanelTitle")}>
              <ul className="divide-y divide-border text-xs">
                {item.occurrenceRecords.map((occ) => (
                  <li
                    key={occ.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <span className="font-mono text-foreground">
                        {occ.sourceKind}: {occ.sourceId}
                      </span>
                      <div className="text-muted-foreground">
                        {formatDate(occ.createdAt)}
                      </div>
                    </div>
                    {occ.sourceKind === "a2a_task" ? (
                      <Link
                        href={`/admin/logs/a2a/${encodeURIComponent(occ.sourceId)}`}
                        className="rounded-lg border border-border px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        {t("viewA2aLog")}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AdminPanel>
          ) : null}
        </div>

        <div className="space-y-6">
          <AdminPanel title={t("triagePanelTitle")}>
            <AdminFeedbackStatusForm
              id={item.id}
              initialStatus={item.status}
              initialAdminNote={item.adminNote ?? ""}
            />
          </AdminPanel>
        </div>
      </div>
    </AdminPage>
  );
}
