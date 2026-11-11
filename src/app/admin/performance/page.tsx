/* DashboardTable consumes cell arrays as indexed values. */

import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Gauge, Search } from "lucide-react";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { adminHref } from "@/lib/admin/navigation";
import {
  getPerformanceBreakdown,
  performanceDimensions,
} from "@/lib/observability/performance";
import {
  AdminEmptyState,
  AdminPage,
  AdminPageHeader,
} from "@/components/admin/AdminUI";
import { LogTimestamp } from "@/components/admin/LogUI";
import { DashboardTable } from "@/components/dashboard/DashboardTable";
import { Button, ButtonLink } from "@/components/motion/button";
import { FormSelect } from "@/components/ui/FormSelect";

export const dynamic = "force-dynamic";

const ranges = [
  { value: "1h", hours: 1 },
  { value: "24h", hours: 24 },
  { value: "7d", hours: 168 },
] as const;
const sorts = ["p95", "count", "errors"] as const;

export default async function AdminPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireAdmin();
  const [t, locale, raw] = await Promise.all([
    getTranslations("admin"),
    getLocale(),
    searchParams,
  ]);
  const dimension =
    performanceDimensions.find((value) => value === raw.dimension) ?? "route";
  const range = ranges.find(({ value }) => value === raw.range) ?? ranges[1];
  const sort = sorts.find((value) => value === raw.sort) ?? "p95";
  const workspaceId =
    typeof raw.workspaceId === "string"
      ? raw.workspaceId.trim() || undefined
      : undefined;
  if (workspaceId && workspaceId.length > 200) {
    return (
      <AdminPage>
        <AdminPageHeader title={t("adminNavPerformance")} />
        <p role="alert" className="text-sm text-destructive">
          {t("performanceInvalidFilter")}
        </p>
        <ButtonLink href="/admin/performance" variant="secondary">
          {t("logsReset")}
        </ButtonLink>
      </AdminPage>
    );
  }
  const until = new Date();
  const since = new Date(until.getTime() - range.hours * 3_600_000);
  const [workspaces, rows] = await Promise.all([
    db.workspace.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    getPerformanceBreakdown(
      { adminId: admin.id },
      { dimension, since, until, workspaceId, sort },
    ),
  ]);
  const query = new URLSearchParams({ dimension, range: range.value, sort });
  if (workspaceId) query.set("workspaceId", workspaceId);
  const returnTo = `/admin/performance?${query}`;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  });

  return (
    <AdminPage>
      <AdminPageHeader title={t("adminNavPerformance")} />
      <nav
        aria-label={t("performanceDimensions")}
        className="flex flex-wrap gap-1"
      >
        {performanceDimensions.map((value) => {
          const tabQuery = new URLSearchParams(query);
          tabQuery.set("dimension", value);
          return (
            <ButtonLink
              key={value}
              href={`/admin/performance?${tabQuery}`}
              variant={dimension === value ? "primary" : "ghost"}
              aria-current={dimension === value ? "page" : undefined}
            >
              {t(`performanceDimension_${value}`)}
            </ButtonLink>
          );
        })}
      </nav>
      <form
        action="/admin/performance"
        method="get"
        key={query.toString()}
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="dimension" value={dimension} />
        <div className="grid min-w-36 gap-1.5">
          <span className="text-xs font-medium">{t("logsTimeRange")}</span>
          <FormSelect
            name="range"
            label={t("logsTimeRange")}
            defaultValue={range.value}
            options={ranges.map((item) => ({
              value: item.value,
              label: t(`logsRange_${item.hours}`),
            }))}
          />
        </div>
        <div className="grid min-w-0 basis-full gap-1.5 sm:min-w-52 sm:basis-auto">
          <span className="text-xs font-medium">{t("workspaceColumn")}</span>
          <FormSelect
            name="workspaceId"
            label={t("workspaceColumn")}
            defaultValue={workspaceId ?? ""}
            className="sm:max-w-80"
            options={[
              { value: "", label: t("logsAll") },
              ...workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              })),
              ...(workspaceId &&
              !workspaces.some((workspace) => workspace.id === workspaceId)
                ? [{ value: workspaceId, label: workspaceId }]
                : []),
            ]}
          />
        </div>
        <div className="grid min-w-36 gap-1.5">
          <span className="text-xs font-medium">{t("performanceSort")}</span>
          <FormSelect
            name="sort"
            label={t("performanceSort")}
            defaultValue={sort}
            options={sorts.map((value) => ({
              value,
              label: t(`performanceSort_${value}`),
            }))}
          />
        </div>
        <Button type="submit" variant="secondary">
          <Search className="size-4" aria-hidden="true" />
          {t("logsApplyFilters")}
        </Button>
      </form>
      {rows.length ? (
        <DashboardTable
          ariaLabel={t("adminNavPerformance")}
          minWidth="62rem"
          selectable={false}
          headers={[
            { label: t(`performanceDimension_${dimension}`), width: "30%" },
            { label: t("performanceCount"), align: "right" },
            { label: t("logsErrorRate"), align: "right" },
            { label: t("performanceP50"), align: "right" },
            { label: t("performanceP95"), align: "right" },
            { label: t("performanceP99"), align: "right" },
            { label: t("performanceMax"), align: "right" },
            { label: t("performanceLastSeen") },
          ]}
          rows={rows.map((row) => ({
            id: new URLSearchParams(row.logsQuery).toString(),
            cells: [
              <Link
                key="key"
                href={adminHref("/admin/logs", { ...row.logsQuery, returnTo })}
                className="block min-w-0 max-w-md hover:underline"
              >
                <code className="block break-all text-xs font-medium">
                  {row.key}
                </code>
                {row.secondary ? (
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {row.secondary}
                  </span>
                ) : null}
              </Link>,
              row.count.toLocaleString(locale),
              <span
                key="errors"
                className={`tabular-nums ${row.errors ? "font-medium text-destructive" : ""}`}
              >
                {row.count ? percent.format(row.errors / row.count) : "—"}
              </span>,
              ...(
                [
                  ["p50", row.p50Ms],
                  ["p95", row.p95Ms],
                  ["p99", row.p99Ms],
                  ["max", row.maxMs],
                ] as const
              ).map(([name, duration]) => (
                <span key={name} className="whitespace-nowrap tabular-nums">
                  {duration === null ? "—" : number.format(duration)}
                </span>
              )),
              <LogTimestamp key="last" date={row.lastAt} />,
            ],
          }))}
        />
      ) : (
        <AdminEmptyState
          icon={Gauge}
          title={t("performanceEmpty")}
          description={t("performanceEmptyHint")}
        />
      )}
    </AdminPage>
  );
}
