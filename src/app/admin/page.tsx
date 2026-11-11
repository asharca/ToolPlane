/* DashboardTable consumes cell arrays as indexed values. */

import { ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Activity, ArrowUpRight, Network, Server, Users } from "lucide-react";
import { requireAdmin } from "@/lib/auth/admin";
import { getSystemOverview } from "@/lib/admin/overview";
import { getLogHealth } from "@/lib/observability/health";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import {
  AdminBadge,
  AdminMetric,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";
import { LogHealth } from "@/components/admin/LogHealth";
import { LogOutcomeBadge, LogTimestamp } from "@/components/admin/LogUI";
import { DashboardTable } from "@/components/dashboard/DashboardTable";
import { adminHref } from "@/lib/admin/navigation";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = await requireAdmin();
  const [t, ops, locale, overview, health] = await Promise.all([
    getTranslations("admin"),
    getTranslations("adminOps"),
    getLocale(),
    getSystemOverview(admin.id),
    getLogHealth(admin.id),
  ]);
  const timeZone = resolveUserTimeZone(admin);
  const number = (value: number) => value.toLocaleString(locale);
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const deployTotal = Object.values(overview.counts.deployments).reduce(
    (a, b) => a + b,
    0,
  );
  const deploymentLabels: Record<string, string> = {
    running: t("deploymentStatusRunning"),
    provisioning: t("deploymentStatusProvisioning"),
    stopped: t("deploymentStatusStopped"),
    failed: t("deploymentStatusError"),
    error: t("deploymentStatusError"),
  };
  const requestsHref = "/admin/logs?tab=mcp";
  const a2aRequestsHref = "/admin/logs?tab=a2a&direction=inbound";

  return (
    <AdminPage>
      <AdminPageHeader
        title={t("systemOverview")}
        actions={
          <ButtonLink href="/admin/logs" variant="secondary" size="md">
            <Activity className="size-4" aria-hidden="true" />
            {t("overviewViewLogs")}
          </ButtonLink>
        }
      />

      <section className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
        <AdminMetric
          icon={Users}
          label={t("overviewAccess")}
          value={`${number(overview.counts.users)} / ${number(overview.counts.workspaces)}`}
          href="/admin/users"
          note={t("overviewNewUsers", { count: overview.counts.newUsers7d })}
        />
        <AdminMetric
          icon={Activity}
          label={ops("mcpRequests")}
          value={number(overview.requests.total)}
          href={requestsHref}
          note={
            <span
              className={
                overview.requests.errors ? "text-destructive" : undefined
              }
            >
              {t("overviewRequestStats", {
                errorRate: overview.requests.total
                  ? percent.format(
                      overview.requests.errors / overview.requests.total,
                    )
                  : "—",
                p95: overview.requests.total
                  ? number(overview.requests.p95Ms)
                  : "—",
              })}
            </span>
          }
        />
        <AdminMetric
          icon={Network}
          label={t("overviewInboundA2a")}
          value={number(overview.a2aRequests.total)}
          href={a2aRequestsHref}
          note={
            <span
              className={
                overview.a2aRequests.errors ? "text-destructive" : undefined
              }
            >
              {t("overviewRequestStats", {
                errorRate: overview.a2aRequests.total
                  ? percent.format(
                      overview.a2aRequests.errors / overview.a2aRequests.total,
                    )
                  : "—",
                p95: overview.a2aRequests.total
                  ? number(overview.a2aRequests.p95Ms)
                  : "—",
              })}
            </span>
          }
        />
        <AdminMetric
          icon={Server}
          label={t("deployments")}
          value={number(deployTotal)}
          href="#needs-attention"
          note={
            <span
              className={
                overview.attention.abnormalCount
                  ? "text-destructive"
                  : undefined
              }
            >
              {t("overviewDeploymentAnomalies", {
                count: overview.attention.abnormalCount,
              })}
            </span>
          }
        />
      </section>

      <LogHealth health={health} />

      <div id="needs-attention" className="scroll-mt-6">
        <AdminPanel title={ops("needsAttention")} padded={false}>
          <div className="grid min-w-0 gap-6 xl:grid-cols-2">
            <div className="min-w-0">
              <ul className="divide-y divide-border">
                {overview.attention.unavailableWorkspaces ? (
                  <li>
                    <Link
                      href="/admin/workspaces?status=delete_failed"
                      className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
                    >
                      <span>
                        {t("workspaces")} / {ops("delete_failed")}
                      </span>
                      <AdminBadge tone="danger">
                        {number(overview.attention.unavailableWorkspaces)}
                      </AdminBadge>
                    </Link>
                  </li>
                ) : null}
                {overview.attention.abnormalDeployments.map((deployment) => (
                  <li key={deployment.id}>
                    <Link
                      href={adminHref("/admin/logs", {
                        tab: "all",
                        deploymentId: deployment.id,
                        workspaceId: deployment.workspaceId,
                        returnTo: "/admin",
                      })}
                      className="flex min-w-0 items-center justify-between gap-3 py-3 hover:underline"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {deployment.name ?? deployment.id}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {deployment.workspace.name}
                        </span>
                      </span>
                      <AdminBadge tone="danger">
                        {deploymentLabels[deployment.status] ??
                          deployment.status}
                      </AdminBadge>
                    </Link>
                  </li>
                ))}
              </ul>
              {!overview.attention.abnormalCount &&
              !overview.attention.unavailableWorkspaces ? (
                <p className="py-4 text-sm text-muted-foreground">
                  {ops("noPendingWork")}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {t("logsErrors")}
                <span className="font-normal text-muted-foreground">
                  {t("last24Hours")}
                </span>
              </h3>
              {overview.errorGroups.length ? (
                <ul className="mt-2 divide-y divide-border">
                  {overview.errorGroups.map((group) => (
                    <li
                      key={JSON.stringify([
                        group.eventName,
                        group.outcome,
                        group.errorType,
                        group.errorCode,
                      ])}
                    >
                      <Link
                        href={adminHref("/admin/logs", {
                          tab: "all",
                          eventName: group.eventName,
                          outcome: group.outcome,
                          errorType: group.errorType ?? undefined,
                          errorCode: group.errorCode ?? undefined,
                          since: overview.errorGroupsWindow.since.toISOString(),
                          until: overview.errorGroupsWindow.until.toISOString(),
                          returnTo: "/admin",
                        })}
                        className="flex min-w-0 flex-wrap items-center gap-3 py-3 hover:text-destructive"
                      >
                        <span className="min-w-0 flex-1 basis-44">
                          <code className="block break-all text-xs font-medium">
                            {group.errorType ?? group.eventName}
                            {group.errorCode ? ` / ${group.errorCode}` : ""}
                          </code>
                          {group.errorType ? (
                            <code className="mt-1 block break-all text-xs text-muted-foreground">
                              {group.eventName}
                            </code>
                          ) : null}
                        </span>
                        <LogTimestamp date={group.last} compact />
                        <AdminBadge tone="danger">
                          {t("logsOccurrences", { count: group.count })}
                        </AdminBadge>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  {ops("noErrors")}
                </p>
              )}
            </div>
          </div>
        </AdminPanel>
      </div>

      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <AdminPanel title={t("logsRecentRequests")} padded={false}>
          {overview.recentRequests.length ? (
            <DashboardTable
              ariaLabel={t("logsRecentRequests")}
              minWidth="40rem"
              selectable={false}
              headers={[
                { label: t("logsTime") },
                { label: t("logsOperation") },
                { label: t("logsUserClient") },
                { label: t("logsResult") },
                { label: t("logsDuration"), align: "right" },
              ]}
              rows={overview.recentRequests.map((event) => ({
                id: event.id,
                cells: [
                  <LogTimestamp key="time" date={event.createdAt} />,
                  <Link
                    key="operation"
                    href={adminHref(`/admin/logs/${event.id}`, {
                      returnTo: "/admin",
                    })}
                    className="block min-w-0 max-w-56 hover:underline"
                  >
                    <span className="block text-xs text-muted-foreground">
                      {event.domain === "a2a" ? "A2A" : "MCP"}
                    </span>
                    <span className="block truncate font-medium">
                      {event.toolName ?? event.rpcMethod ?? event.eventName}
                    </span>
                  </Link>,
                  <span key="caller" className="block max-w-48 truncate">
                    {event.actorName ??
                      event.actorId ??
                      event.clientId ??
                      t("logsUnknownCaller")}
                  </span>,
                  <LogOutcomeBadge key="outcome" outcome={event.outcome} />,
                  <span
                    key="duration"
                    className="whitespace-nowrap tabular-nums"
                  >
                    {event.durationMs === null
                      ? "—"
                      : `${number(event.durationMs)} ms`}
                  </span>,
                ],
              }))}
            />
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              {t("noRequestData")}
            </p>
          )}
        </AdminPanel>

        <AdminPanel
          title={t("recentSignups")}
          actions={
            <ButtonLink href="/admin/users" variant="ghost" size="sm">
              {t("overviewAllUsers")}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </ButtonLink>
          }
          padded={false}
        >
          {overview.recentUsers.length ? (
            <ul className="divide-y divide-border">
              {overview.recentUsers.map((user) => (
                <li key={user.id}>
                  <Link
                    href={`/admin/users/${user.id}`}
                    className="flex min-h-12 items-center justify-between gap-3 py-3 hover:underline"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {user.name ?? user.email}
                      </span>
                      {user.name ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {user.role === "admin" ? (
                        <AdminBadge tone="info">{t("admin")}</AdminBadge>
                      ) : null}
                      {user.status === "suspended" ? (
                        <AdminBadge tone="warning">{t("suspended")}</AdminBadge>
                      ) : null}
                      <time
                        dateTime={user.createdAt.toISOString()}
                        className="hidden text-xs text-muted-foreground sm:block"
                      >
                        {formatInTimeZone(
                          user.createdAt,
                          timeZone,
                          { month: "short", day: "numeric" },
                          locale,
                        )}
                      </time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              {t("noRecentSignups")}
            </p>
          )}
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
