import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { LogTimestamp } from "@/components/admin/LogUI";
import { DashboardTable } from "@/components/dashboard/DashboardTable";
import type { LogHealthSnapshot } from "@/lib/observability/health";

export async function LogHealth({ health }: { health: LogHealthSnapshot }) {
  const t = await getTranslations("admin");
  const number = (value: number) => value.toLocaleString();
  const writerAlert =
    health.writer.failures ||
    health.writer.dropped ||
    health.writer.stderrDropped;

  return (
    <AdminPanel
      title={t("logsHealthTitle")}
      description={t("logsHealthScope")}
      padded={false}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <LogTimestamp date={health.until} compact />
          <AdminBadge
            tone={health.state === "attention" ? "warning" : "neutral"}
          >
            {t(`logsHealth_${health.state}`)}
          </AdminBadge>
        </div>
      }
    >
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        <DashboardTable
          ariaLabel={t("logsHealthTitle")}
          minWidth="34rem"
          selectable={false}
          headers={[
            { label: t("logFields.domain") },
            { label: t("logsTotal"), align: "right" },
            { label: t("logsFailures"), align: "right" },
            { label: t("logOutcomes.denied"), align: "right" },
            { label: t("logsHealthLast") },
          ]}
          rows={[
            "http",
            "mcp",
            "a2a",
            "agent",
            "runtime",
            "channel",
            "system",
          ].map((domain) => {
            const row = health.domains.find((item) => item.domain === domain);
            return {
              id: domain,
              cells: [
                <Link
                  key="domain"
                  href={`/admin/logs?${new URLSearchParams({
                    tab: "all",
                    domain,
                    since: health.since.toISOString(),
                    until: health.until.toISOString(),
                    returnTo: "/admin",
                  })}`}
                  className="font-medium hover:underline"
                >
                  {t(`logDomains.${domain}`)}
                </Link>,
                number(row?.total ?? 0),
                <span
                  key="errors"
                  className={row?.errors ? "text-destructive" : undefined}
                >
                  {number(row?.errors ?? 0)}
                </span>,
                number(row?.denied ?? 0),
                row ? <LogTimestamp key="last" date={row.last} compact /> : "—",
              ],
            };
          })}
        />
        <div className="min-w-0 space-y-5">
          <Link
            href="#needs-attention"
            className="flex items-center justify-between gap-3 border-b border-border pb-4 text-sm hover:underline"
          >
            {t("logsHealthDeployments")}
            <AdminBadge tone={health.abnormal.length ? "danger" : "neutral"}>
              {number(health.abnormal.length)} /{" "}
              {number(health.deploymentCount)}
            </AdminBadge>
          </Link>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t("logsWriterTitle")}</h3>
            <dl className="space-y-2 text-sm tabular-nums">
              {(
                [
                  ["logsWriterPending", health.writer.pending],
                  ["logsWriterFailures", health.writer.failures],
                  ["logsWriterDropped", health.writer.dropped],
                  ["logsWriterStderrDropped", health.writer.stderrDropped],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="text-muted-foreground">{t(label)}</dt>
                  <dd
                    className={
                      label !== "logsWriterPending" && value
                        ? "font-medium text-destructive"
                        : "font-medium"
                    }
                  >
                    {number(value)}
                  </dd>
                </div>
              ))}
              <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
                <dt className="text-muted-foreground">
                  {t("logsWriterLastSuccess")}
                </dt>
                <dd>
                  {health.writer.lastSuccess ? (
                    <LogTimestamp date={new Date(health.writer.lastSuccess)} />
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>
            <p
              className={`text-xs ${writerAlert ? "text-destructive" : "text-muted-foreground"}`}
            >
              {t("logsWriterScope")}
            </p>
          </div>
        </div>
      </div>
    </AdminPanel>
  );
}
