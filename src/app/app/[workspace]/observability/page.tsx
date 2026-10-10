import { FormSelect } from "@/components/ui/FormSelect";

import { Input } from "@/components/motion/input";
import { Button, ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getObservability } from "@/lib/observability/log";
import {
  aggregateLogs,
  authorizeLogs,
  getA2aMetadata,
  listLogEvents,
  logFilterSchema,
  resolveLogFilters,
} from "@/lib/observability/queries";
import type { LogFilters } from "@/lib/observability/queries";
import { LogOutcomeBadge } from "@/components/admin/LogUI";
import { z } from "zod";
import { getPluginTelemetry } from "@/lib/observability/plugin-telemetry";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { TabBar } from "@/components/dashboard/TabBar";
import { ObservabilityLogs } from "@/components/dashboard/ObservabilityLogs";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
  DashboardTable,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";

export const dynamic = "force-dynamic";

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-3xl font-bold tracking-tight text-foreground">
          {value}
        </span>
        {unit ? (
          <span className="text-sm text-muted-foreground">{unit}</span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

export default async function ObservabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    tab?: string;
    deploymentId?: string;
    q?: string;
    cursor?: string;
    until?: string;
    outcome?: string;
    direction?: string;
    agentId?: string;
    taskId?: string;
    requestId?: string;
    contextId?: string;
    rootTaskId?: string;
    parentTaskId?: string;
    range?: string;
  }>;
}) {
  const [t, locale, adminT] = await Promise.all([
    getTranslations("console.observability"),
    getLocale(),
    getTranslations("admin"),
  ]);
  const { workspace: slug } = await params;
  const {
    tab,
    deploymentId,
    q,
    cursor,
    until,
    outcome,
    direction,
    agentId,
    taskId,
    requestId,
    contextId,
    rootTaskId,
    parentTaskId,
    range,
  } = await searchParams;
  const selectedDeploymentId = deploymentId?.trim() || undefined;
  const tabs = [
    { key: "audit", label: t("requestLog") },
    { key: "a2a", label: t("a2aRequests") },
    { key: "usage", label: t("usage") },
    { key: "plugin", label: t("plugin") },
  ];
  const current = tabs.find((item) => item.key === tab)?.key ?? "audit";

  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const base = `/app/${slug}/observability`;
  if (current === "a2a") {
    const hours = range === "1" ? 1 : range === "168" ? 168 : 24;
    const query = {
      tab: "a2a",
      ...(q ? { q } : {}),
      ...(outcome ? { outcome } : {}),
      ...(direction ? { direction } : {}),
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(contextId ? { contextId } : {}),
      ...(rootTaskId ? { rootTaskId } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      range: String(hours),
    };
    if (range && !["1", "24", "168"].includes(range))
      redirect(`${base}?tab=a2a`);
    let filters: LogFilters;
    try {
      const end = until ? new Date(until) : new Date();
      filters = resolveLogFilters({
        ...query,
        since: new Date(end.getTime() - hours * 3_600_000),
        until: end,
        cursor,
        workspaceId: ws.id,
      });
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      redirect(`${base}?tab=a2a`);
    }
    const scope = { userId: user.id, workspaceId: ws.id };
    await authorizeLogs(scope);
    const [events, stats] = await Promise.all([
      listLogEvents(scope, filters),
      aggregateLogs(filters),
    ]);
    const detailQuery = new URLSearchParams({
      ...query,
      ...(cursor ? { cursor } : {}),
      until: events.until,
    });
    const lifecycle = !!(taskId || contextId || rootTaskId || parentTaskId);
    const dateLocale = locale === "zh" ? "zh-CN" : "en-US";
    return (
      <>
        <DashboardHeader title={t("observability")} />
        <DashboardPage>
          <TabBar
            tabs={tabs}
            current={current}
            basePath={base}
            query={q ? { q } : {}}
          />
          <p className="text-sm text-muted-foreground">{t("a2aBodyPolicy")}</p>
          <nav aria-label={t("a2aRequests")} className="flex flex-wrap gap-2">
            {([1, 24, 168] as const).map((value) => (
              <ButtonLink
                key={value}
                href={`${base}?${new URLSearchParams({ ...query, range: String(value) })}`}
                variant={hours === value ? "primary" : "ghost"}
                size="sm"
                aria-current={hours === value ? "page" : undefined}
              >
                {t(`a2aRange_${value}`)}
              </ButtonLink>
            ))}
          </nav>
          <form
            action={base}
            method="get"
            className="flex min-w-0 flex-wrap items-end gap-2"
          >
            <input type="hidden" name="tab" value="a2a" />
            <input type="hidden" name="range" value={hours} />
            <Input
              name="q"
              defaultValue={q}
              maxLength={200}
              aria-label={t("searchLogs")}
              placeholder={t("searchLogs")}
              className="w-full sm:w-48"
            />
            <FormSelect
              name="outcome"
              label={t("a2aResult")}
              defaultValue={outcome ?? ""}
              options={[
                { value: "", label: t("allLogs") },
                ...(
                  [
                    "success",
                    "error",
                    "timeout",
                    "cancelled",
                    "denied",
                  ] as const
                ).map((value) => ({
                  value,
                  label: adminT(`logOutcomes.${value}`),
                })),
              ]}
            />
            <FormSelect
              name="direction"
              label={t("direction")}
              defaultValue={direction ?? ""}
              options={[
                { value: "", label: t("allLogs") },
                ...(["inbound", "outbound", "internal"] as const).map(
                  (value) => ({ value, label: t(`directions.${value}`) }),
                ),
              ]}
            />
            <Input
              name="agentId"
              label={t("agentId")}
              defaultValue={agentId}
              maxLength={200}
              className="min-w-0 sm:w-36"
            />
            <Input
              name="taskId"
              label={t("taskId")}
              defaultValue={taskId}
              maxLength={200}
              className="min-w-0 sm:w-36"
            />
            <Input
              name="requestId"
              label={t("requestId")}
              defaultValue={requestId}
              maxLength={200}
              className="min-w-0 sm:w-36"
            />
            <details
              className="basis-full"
              open={!!(contextId || rootTaskId || parentTaskId)}
            >
              <summary className="cursor-pointer text-sm">
                {t("a2aAdvanced")}
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  name="contextId"
                  label={t("contextId")}
                  defaultValue={contextId}
                  maxLength={200}
                  className="min-w-0 sm:w-48"
                />
                <Input
                  name="rootTaskId"
                  label={t("rootTaskId")}
                  defaultValue={rootTaskId}
                  maxLength={200}
                  className="min-w-0 sm:w-48"
                />
                <Input
                  name="parentTaskId"
                  label={t("parentTaskId")}
                  defaultValue={parentTaskId}
                  maxLength={200}
                  className="min-w-0 sm:w-48"
                />
              </div>
            </details>
            <Button type="submit" variant="secondary" size="sm">
              {t("applyFilter")}
            </Button>
            <ButtonLink href={`${base}?tab=a2a`} variant="ghost" size="sm">
              {t("clearFilter")}
            </ButtonLink>
          </form>
          <form action={base} method="get">
            {Object.entries(query).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <Button type="submit" variant="ghost" size="sm">
              {t("refresh")}
            </Button>
          </form>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={t(lifecycle ? "a2aEventCount" : "a2aRequestCount")}
              value={compact(stats.total)}
              sub={t(`a2aRange_${hours}`)}
            />
            <Stat
              label={t("errors")}
              value={stats.errors}
              sub={t("errorCount", { count: stats.errors })}
            />
            <Stat
              label={
                lifecycle
                  ? `${t("a2aEventDuration")} · ${t("avgLatency")}`
                  : t("avgLatency")
              }
              value={stats.avgMs}
              unit="ms"
              sub={t(lifecycle ? "a2aEventDuration" : "averageResponse")}
            />
            <Stat
              label={
                lifecycle
                  ? `${t("a2aEventDuration")} · ${t("p95Latency")}`
                  : t("p95Latency")
              }
              value={stats.p95Ms}
              unit="ms"
              sub={t(lifecycle ? "a2aEventDuration" : "ninetyFifthPercentile")}
            />
          </div>
          <DashboardPanel
            title={t(lifecycle ? "a2aTrace" : "a2aRequests")}
            padded={false}
          >
            {events.rows.length === 0 ? (
              <DashboardEmptyState
                description={t(
                  lifecycle ||
                    q ||
                    outcome ||
                    direction ||
                    agentId ||
                    taskId ||
                    requestId ||
                    contextId ||
                    rootTaskId ||
                    parentTaskId
                    ? "noMatchingRequests"
                    : "noRequestsYet",
                )}
              />
            ) : (
              <DashboardTable
                minWidth="55rem"
                headers={[
                  { label: t("time") },
                  { label: t("a2aMethod") },
                  { label: t("direction") },
                  { label: t("a2aTarget") },
                  { label: t("taskId") },
                  { label: t("a2aResult") },
                  { label: t("duration") },
                  { label: t("a2aDetails") },
                ]}
                rows={events.rows.map((row) => {
                  const metadata = getA2aMetadata(row.attributes);
                  const href = `${base}/${encodeURIComponent(row.id)}?${detailQuery}`;
                  return {
                    id: row.id,
                    cells: [
                      <time
                        key="time"
                        dateTime={row.createdAt.toISOString()}
                        title={row.createdAt.toISOString()}
                        className="whitespace-nowrap text-xs"
                      >
                        {formatInTimeZone(
                          row.createdAt,
                          timeZone,
                          {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                          dateLocale,
                        )}
                      </time>,
                      <Link
                        key="method"
                        href={href}
                        className="break-all font-medium hover:underline"
                      >
                        {row.rpcMethod ?? row.toolName ?? row.eventName}
                      </Link>,
                      metadata ? t(`directions.${metadata.direction}`) : "—",
                      <span
                        key="target"
                        className="block max-w-48 break-all font-mono text-xs"
                      >
                        {row.agentId ??
                          metadata?.endpointId ??
                          metadata?.remoteAgentId ??
                          t("a2aNoTarget")}
                      </span>,
                      <span
                        key="task"
                        className="block max-w-48 space-y-1 break-all font-mono text-xs"
                      >
                        {metadata?.taskId ? (
                          <Link
                            className="block hover:underline"
                            href={`${base}?${new URLSearchParams({ tab: "a2a", taskId: metadata.taskId, range: String(hours) })}`}
                          >
                            {metadata.taskId}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {metadata?.rootTaskId &&
                        metadata.rootTaskId !== metadata.taskId ? (
                          <Link
                            className="block text-muted-foreground hover:underline"
                            href={`${base}?${new URLSearchParams({ tab: "a2a", rootTaskId: metadata.rootTaskId, range: String(hours) })}`}
                          >
                            {t("rootTaskId")}: {metadata.rootTaskId}
                          </Link>
                        ) : null}
                      </span>,
                      <span key="outcome" className="space-y-1">
                        <LogOutcomeBadge outcome={row.outcome} />
                        {metadata?.taskState &&
                        adminT.has(`logsTaskStates.${metadata.taskState}`) ? (
                          <span className="block text-xs text-muted-foreground">
                            {adminT(`logsTaskStates.${metadata.taskState}`)}
                          </span>
                        ) : null}
                      </span>,
                      row.durationMs == null
                        ? "—"
                        : `${row.eventName === "a2a.task.settled" ? `${t("a2aTaskDuration")}: ` : ""}${row.durationMs} ${t("ms")}`,
                      <Link
                        key="details"
                        href={href}
                        className="hover:underline"
                      >
                        {t("a2aDetails")}
                      </Link>,
                    ],
                  };
                })}
              />
            )}
            {events.nextCursor ? (
              <ButtonLink
                href={`${base}?${new URLSearchParams({ ...query, cursor: events.nextCursor, until: events.until })}`}
                variant="secondary"
                size="sm"
                className="m-4"
              >
                {t("olderLogs")}
                <ChevronRight className="size-4" />
              </ButtonLink>
            ) : null}
          </DashboardPanel>
        </DashboardPage>
      </>
    );
  }
  if (
    !logFilterSchema.safeParse({
      q,
      cursor,
      until,
      since: until
        ? new Date(new Date(until).getTime() - 86_400_000)
        : undefined,
    }).success
  ) {
    redirect(`/app/${slug}/observability`);
  }

  const o = await getObservability(ws.id, timeZone, 24, selectedDeploymentId, {
    userId: user.id,
    q,
    cursor,
    until,
  });
  const pt = current === "plugin" ? await getPluginTelemetry(ws.id) : null;
  const max = Math.max(1, ...o.series.map((s) => s.total));
  const errorRate = o.total ? Math.round((o.errors / o.total) * 1000) / 10 : 0;
  const dateLocale = locale === "zh" ? "zh-CN" : "en-US";
  const filterQuery = {
    ...(selectedDeploymentId ? { deploymentId: selectedDeploymentId } : {}),
    ...(q ? { q } : {}),
  };
  const searchControls = (
    <form
      action={base}
      method="get"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <input type="hidden" name="tab" value={current} />
      <Input
        name="q"
        defaultValue={q}
        maxLength={200}
        aria-label={t("searchLogs")}
        placeholder={t("searchLogs")}
        className="w-full sm:w-64"
      />
      <FormSelect
        id="observability-deployment"
        name="deploymentId"
        defaultValue={selectedDeploymentId ?? ""}
        label={t("filterByServer")}
        options={[
          { value: "", label: t("allServers") },
          ...o.deployments.map((deployment) => ({
            value: deployment.id,
            label: deployment.name,
          })),
        ]}
      />
      <Button type="submit" variant="secondary" size="sm">
        {t("applyFilter")}
      </Button>
      {q || selectedDeploymentId ? (
        <ButtonLink href={`${base}?tab=${current}`} variant="ghost" size="sm">
          {t("clearFilter")}
        </ButtonLink>
      ) : null}
    </form>
  );

  return (
    <>
      <DashboardHeader title={t("observability")} />
      <DashboardPage>
        <TabBar
          tabs={tabs}
          current={current}
          basePath={base}
          query={filterQuery}
        />

        {current === "usage" ? (
          <DashboardToolbar
            className="rounded-lg border border-border bg-muted/20 px-4 py-3"
            actions={searchControls}
          >
            <div>
              <p className="text-sm text-muted-foreground">
                {t(
                  "toolCallsLatencyAndErrorsAcrossEveryServerAggregatedOverTheLast24Hours",
                )}
              </p>
              {o.selectedDeployment ? (
                <p className="mt-1 text-xs font-medium text-foreground">
                  {t("filteredTo", { name: o.selectedDeployment })}
                </p>
              ) : null}
            </div>
          </DashboardToolbar>
        ) : current === "plugin" ? (
          <p className="text-sm text-muted-foreground">
            {t("pluginTelemetryDescription")}
          </p>
        ) : null}

        {current === "usage" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t("totalRequests24h")}
                value={compact(o.total)}
                sub={t("requestsReceived")}
              />
              <Stat
                label={t("errorRate")}
                value={errorRate}
                unit="%"
                sub={t("errorCount", { count: o.errors })}
              />
              <Stat
                label={t("avgLatency")}
                value={o.avgMs}
                unit="ms"
                sub={t("averageResponse")}
              />
              <Stat
                label={t("p95Latency")}
                value={o.p95Ms}
                unit="ms"
                sub={t("ninetyFifthPercentile")}
              />
            </div>

            <DashboardPanel title={t("requestsPerHour")}>
              <div className="mb-4 flex items-center justify-between">
                <div />
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-primary" />
                    {t("requests")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-destructive" />
                    {t("errors")}
                  </span>
                </div>
              </div>
              {o.total === 0 ? (
                <DashboardEmptyState
                  description={t(
                    "noTrafficYetCallADeploymentsGatewayEndpointToSeeActivityHere",
                  )}
                  className="min-h-48"
                />
              ) : (
                <div className="relative flex h-48 items-end gap-1 border-b border-border/70 pt-2">
                  {o.series.map((s) => {
                    const ok = s.total - s.errors;
                    const barHeight = s.total
                      ? Math.max(4, (s.total / max) * 82)
                      : 0;
                    return (
                      <div
                        key={s.timestamp}
                        className="relative h-full flex-1"
                        title={t("chartTooltip", {
                          hour: s.hour,
                          total: s.total,
                          errors: s.errors,
                        })}
                      >
                        <div
                          className="absolute inset-x-0 bottom-5 flex flex-col justify-end"
                          style={{ height: `${barHeight}%` }}
                        >
                          <div
                            className="w-full rounded-t-sm bg-primary"
                            style={{
                              height: `${(ok / Math.max(1, s.total)) * 100}%`,
                            }}
                          />
                          <div
                            className="w-full bg-destructive"
                            style={{
                              height: `${(s.errors / Math.max(1, s.total)) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="absolute inset-x-0 bottom-0 truncate text-center text-[9px] text-muted-foreground">
                          {s.hour}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </DashboardPanel>

            <DashboardPanel
              title={t("requestsByServer")}
              description={t("requestsByServerDescription")}
              padded={false}
            >
              {o.deploymentUsage.length === 0 ? (
                <DashboardEmptyState
                  description={t("noServersYet")}
                  className="min-h-32 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  minWidth="42rem"
                  headers={[
                    { label: t("server") },
                    { label: t("requests"), align: "right" },
                    { label: t("errors"), align: "right" },
                    { label: t("errorRate"), align: "right" },
                    { label: t("avgLatency"), align: "right" },
                  ]}
                  rows={o.deploymentUsage.map((row) => {
                    const rowErrorRate = row.total
                      ? `${Math.round((row.errors / row.total) * 1000) / 10}%`
                      : "—";
                    return {
                      id: row.id ?? "workspace-api",
                      cells: [
                        row.id ? (
                          <Link
                            key="deployment"
                            href={`/app/${slug}/mcp/${row.id}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {row.name}
                          </Link>
                        ) : (
                          <span
                            key="deployment"
                            className="font-medium text-foreground"
                          >
                            {row.name}
                          </span>
                        ),
                        row.total,
                        row.errors,
                        rowErrorRate,
                        <span key="latency">
                          {row.avgMs}
                          {t("ms")}
                        </span>,
                      ],
                    };
                  })}
                />
              )}
            </DashboardPanel>
          </>
        ) : current === "audit" ? (
          <DashboardPanel
            title={t("requestLog")}
            description={t("showingRecentRequests", { count: o.recent.length })}
          >
            <ObservabilityLogs
              searchControls={searchControls}
              logs={o.recent.map((log) => ({
                ...log,
                deploymentHref: log.deploymentId
                  ? `/app/${slug}/mcp/${log.deploymentId}`
                  : null,
                time: formatInTimeZone(
                  log.createdAt,
                  timeZone,
                  {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  },
                  dateLocale,
                ),
              }))}
            />
            {o.nextCursor ? (
              <ButtonLink
                href={`${base}?${new URLSearchParams({ tab: "audit", cursor: o.nextCursor, until: o.until, ...(q ? { q } : {}), ...(selectedDeploymentId ? { deploymentId: selectedDeploymentId } : {}) })}`}
                variant="secondary"
                size="md"
                className="mt-4"
              >
                {t("olderLogs")}
                <ChevronRight className="size-4" />
              </ButtonLink>
            ) : null}
          </DashboardPanel>
        ) : pt ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t("skillCalls24h")}
                value={compact(pt.skill.total)}
                sub={t("acrossInstalledPlugins")}
              />
              <Stat
                label={t("userAgent")}
                value={`${pt.skill.byUser} / ${pt.skill.byAgent}`}
                sub={t("slashVsAutonomous")}
              />
              <Stat
                label={t("skillErrors")}
                value={pt.skill.errors}
                sub={t("failedInvocations")}
              />
              <Stat
                label={t("skillSyncs")}
                value={pt.sync.applied}
                sub={t("failedCount", { count: pt.sync.failures })}
              />
            </div>

            <DashboardPanel title={t("recentSkillInvocations")} padded={false}>
              {pt.skill.recent.length === 0 ? (
                <DashboardEmptyState
                  description={t(
                    "noSkillInvocationsYetInstallAToolkitAsAnAutosyncPluginAndRunOneOfItsSkills",
                  )}
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  headers={[
                    { label: t("skill") },
                    { label: t("source") },
                    { label: t("outcome") },
                    { label: t("time") },
                  ]}
                  rows={pt.skill.recent.map((s) => ({
                    id: s.id,
                    cells: [
                      s.skillSlug,
                      s.source === "user" ? t("user") : t("agent"),
                      <span
                        key="outcome"
                        className={
                          s.outcome === "error"
                            ? "text-destructive dark:text-destructive"
                            : "text-(--color-success) dark:text-(--color-success)"
                        }
                      >
                        {s.outcome === "error" ? t("error") : t("success")}
                        {s.errorClass ? ` · ${s.errorClass}` : ""}
                      </span>,
                      formatInTimeZone(
                        s.createdAt,
                        timeZone,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        },
                        dateLocale,
                      ),
                    ],
                  }))}
                />
              )}
            </DashboardPanel>

            <DashboardPanel title={t("recentSkillSyncs")} padded={false}>
              {pt.sync.recent.length === 0 ? (
                <DashboardEmptyState
                  description={t("noSyncsRecordedYet")}
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  headers={[
                    { label: t("outcome") },
                    { label: t("added") },
                    { label: t("updated") },
                    { label: t("removed") },
                    { label: t("time") },
                  ]}
                  rows={pt.sync.recent.map((s) => ({
                    id: s.id,
                    cells: [
                      <span
                        key="outcome"
                        className={
                          s.outcome === "failure"
                            ? "text-destructive dark:text-destructive"
                            : "text-(--color-success) dark:text-(--color-success)"
                        }
                      >
                        {s.outcome === "failure"
                          ? `${t("failure")}${s.reason ? ` · ${s.reason}` : ""}`
                          : t("applied")}
                      </span>,
                      s.added,
                      s.updated,
                      s.removed,
                      formatInTimeZone(
                        s.createdAt,
                        timeZone,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        },
                        dateLocale,
                      ),
                    ],
                  }))}
                />
              )}
            </DashboardPanel>
          </div>
        ) : null}
      </DashboardPage>
    </>
  );
}
