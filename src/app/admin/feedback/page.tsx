/* DashboardTable consumes cell arrays as indexed values. */
import { Flag } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AdminBadge,
  AdminEmptyState,
  AdminPage,
  AdminPageHeader,
  AdminPagination,
  AdminTableLink,
  type AdminBadgeTone,
} from "@/components/admin/AdminUI";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import { FormSelect } from "@/components/ui/FormSelect";
import { Button } from "@/components/motion/button";
import { listAdminFeedback } from "@/lib/admin/feedback";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { adminHref } from "@/lib/admin/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackSource,
  type FeedbackStatus,
} from "@/lib/feedback/types";

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

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string;
    status?: string;
    category?: string;
    page?: string;
  }>;
}) {
  const [t, locale, admin, params] = await Promise.all([
    getTranslations("adminFeedback"),
    getLocale(),
    requireAdmin(),
    searchParams,
  ]);

  const source = (FEEDBACK_SOURCES as readonly string[]).includes(
    params.source ?? "",
  )
    ? (params.source as FeedbackSource)
    : undefined;
  const status = (FEEDBACK_STATUSES as readonly string[]).includes(
    params.status ?? "",
  )
    ? (params.status as FeedbackStatus)
    : undefined;
  const category = (FEEDBACK_CATEGORIES as readonly string[]).includes(
    params.category ?? "",
  )
    ? (params.category as FeedbackCategory)
    : undefined;

  const rawPage = Number(params.page ?? "1");
  const requestedPage = normalizeAdminPage(rawPage);
  const timeZone = resolveUserTimeZone(admin);

  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listAdminFeedback({
    source,
    status,
    category,
    page: requestedPage,
  });

  const hrefForPage = (targetPage: number) =>
    adminHref("/admin/feedback", {
      source,
      status,
      category,
      page: targetPage > 1 ? String(targetPage) : undefined,
    });

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  const hasFilters = Boolean(source || status || category);

  return (
    <AdminPage>
      <AdminPageHeader
        title={t("title")}
        description={t("description")}
        meta={t("itemCount", { count: total.toLocaleString() })}
      />

      <form
        method="GET"
        action="/admin/feedback"
        className="flex flex-wrap items-center gap-2"
      >
        <FormSelect
          name="source"
          defaultValue={source ?? ""}
          className="w-auto"
          label={t("sourceColumn")}
          options={[
            { value: "", label: t("allSources") },
            ...FEEDBACK_SOURCES.map((value) => ({
              value,
              label: t(`sources.${value}`),
            })),
          ]}
        />
        <FormSelect
          name="status"
          defaultValue={status ?? ""}
          className="w-auto"
          label={t("statusColumn")}
          options={[
            { value: "", label: t("allStatuses") },
            ...FEEDBACK_STATUSES.map((value) => ({
              value,
              label: t(`statuses.${value}`),
            })),
          ]}
        />
        <FormSelect
          name="category"
          defaultValue={category ?? ""}
          className="w-auto"
          label={t("categoryColumn")}
          options={[
            { value: "", label: t("allCategories") },
            ...FEEDBACK_CATEGORIES.map((value) => ({
              value,
              label: t(`categories.${value}`),
            })),
          ]}
        />
        <Button type="submit" size="sm" variant="secondary">
          {t("filter")}
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/feedback"
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("clear")}
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Flag}
          title={t("emptyTitle")}
          description={
            hasFilters ? t("emptyFilteredDescription") : t("emptyDescription")
          }
        />
      ) : (
        <DashboardTable
          ariaLabel={t("tableLabel")}
          minWidth="58rem"
          selectable={false}
          adjustableColumns={false}
          headers={[
            { label: t("titleColumn") },
            { label: t("sourceColumn"), width: "4.5rem" },
            { label: t("categoryColumn"), width: "4.5rem" },
            { label: t("statusColumn"), width: "6.5rem" },
            { label: t("occurrencesColumn"), align: "right", width: "5.5rem" },
            { label: t("workspaceColumn"), width: "8rem" },
            { label: t("lastSeenColumn"), width: "10.5rem" },
            {
              label: <span className="sr-only">{t("viewDetails")}</span>,
              width: "3rem",
            },
          ]}
          rows={items.map((item) => {
            const detailHref = adminHref(`/admin/feedback/${item.id}`, {
              returnTo: hrefForPage(currentPage),
            });
            return {
              id: item.id,
              cells: [
                <div key="title" className="min-w-0 space-y-0.5">
                  <Link
                    href={detailHref}
                    className="block truncate font-medium text-foreground hover:underline"
                  >
                    {item.title}
                  </Link>
                  {item.failureCode ? (
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {item.failureCode}
                    </span>
                  ) : null}
                </div>,
                <AdminBadge key="source" tone={sourceTone(item.source)}>
                  {t(`sources.${item.source}`)}
                </AdminBadge>,
                <span key="category" className="text-xs text-muted-foreground">
                  {t(`categories.${item.category}`)}
                </span>,
                <AdminBadge key="status" tone={statusTone(item.status)} dot>
                  {t(`statuses.${item.status}`)}
                </AdminBadge>,
                item.occurrences.toLocaleString(),
                <span key="workspace" className="text-xs text-muted-foreground">
                  {item.workspaceName ?? item.workspaceSlug ?? "—"}
                </span>,
                formatInTimeZone(
                  item.lastSeenAt || item.createdAt,
                  timeZone,
                  {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                  locale,
                ),
                <AdminTableLink
                  key="link"
                  href={detailHref}
                  label={t("viewDetails")}
                />,
              ],
            };
          })}
        />
      )}

      {total > pageSize ? (
        <AdminPagination
          page={currentPage}
          total={total}
          pageSize={pageSize}
          itemLabel={t("paginationItems")}
          pageLabel={t("paginationPage")}
          previousLabel={t("previous")}
          nextLabel={t("next")}
          hrefForPage={hrefForPage}
        />
      ) : null}
    </AdminPage>
  );
}
