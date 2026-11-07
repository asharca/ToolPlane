import { FormSelect } from "@/components/ui/FormSelect";

import { Input } from "@/components/motion/input";
import { Button, ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getObservability } from "@/lib/observability/log";
import { db } from "@/lib/db";
import { LogExplorer } from "@/components/observability/LogExplorer";
import { logFilterSchema } from "@/lib/observability/queries";
import { getPluginTelemetry } from "@/lib/observability/plugin-telemetry";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { TabBar } from "@/components/dashboard/TabBar";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
  DashboardTable,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { WorkspaceAgentUsage } from "@/components/dashboard/AgentUsagePanel";
import { ChannelObservability } from "@/components/observability/ChannelObservability";

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
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [t, locale, viewerT] = await Promise.all([
    getTranslations("console.observability"),
    getLocale(),
    getTranslations("console.observability.viewer"),
  ]);
  const { workspace: slug } = await params;
  const query = await searchParams;
  const { tab, deploymentId, q, cursor, until } = query;
  const selectedDeploymentId = deploymentId?.trim() || undefined;
  const tabs = [
    { key: "runs", label: viewerT("runs") },
    { key: "tools", label: viewerT("tools") },
    { key: "mcp", label: viewerT("mcp") },
    { key: "a2a", label: viewerT("a2a") },
    { key: "channels", label: t("channels.title") },
    { key: "internal", label: viewerT("internal") },
    { key: "usage", label: t("usage") },
    { key: "plugin", label: t("plugin") },
    { key: "agent-usage", label: t("agentUsage") },
  ];
  const current = tabs.find((item) => item.key === tab)?.key ?? "runs";

  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const base = `/app/${slug}/observability`;
  if (current === "channels") {
    return (
      <>
        <DashboardHeader title={t("observability")} />
        <DashboardPage>
          <TabBar tabs={tabs} current={current} basePath={base} />
          <ChannelObservability
            key={`${ws.id}:${query.agentId ?? ""}:${query.channelId ?? ""}`}
            slug={slug}
            agentId={query.agentId}
            channelId={query.channelId}
          />
        </DashboardPage>
      </>
    );
  }
  if (
    current === "runs" ||
    current === "mcp" ||
    current === "internal" ||
    current === "tools" ||
    current === "a2a"
  ) {
    const [deployments, agents] = await Promise.all([
      db.deployment.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, name: true, server: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
      db.agent.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
    return (
      <>
        <DashboardHeader title={t("observability")} />
        <DashboardPage>
          <TabBar tabs={tabs} current={current} basePath={base} />
          <LogExplorer
            key={`${ws.id}:${current}`}
            kind={current === "a2a" || current === "runs" ? current : "mcp"}
            source={
              current === "internal" || current === "tools"
                ? current
                : undefined
            }
            workspaceSlug={slug}
            params={query}
            deployments={deployments.map((item) => ({
              id: item.id,
              name: item.name || item.server?.name || item.id.slice(0, 8),
            }))}
            agents={agents}
          />
        </DashboardPage>
      </>
    );
  }
  if (current === "agent-usage") {
    return (
      <>
        <DashboardHeader title={t("observability")} />
        <DashboardPage>
          <TabBar tabs={tabs} current={current} basePath={base} />
          <WorkspaceAgentUsage key={`${ws.id}:agent-usage`} slug={slug} />
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
    redirect(`${base}?tab=${current}`);
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
                    <span className="size-2.5 rounded-full bg-primary" />
                    {t("requests")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-destructive" />
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
