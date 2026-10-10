"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";

import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";

import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Activity,
  Braces,
  ChevronDown,
  CircleAlert,
  Clock3,
  HeartPulse,
  List,
  RefreshCw,
  Search,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  inspectMcpLog,
  type McpLogOperation,
} from "@/lib/observability/mcp-log-entry";
import { LogPayload } from "./LogPayload";

export type McpRequestLogView = {
  id: string;
  deploymentId?: string | null;
  deploymentHref?: string | null;
  deploymentName?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  time: string;
  rpcMethod?: string | null;
  toolName?: string | null;
  outcome?: string;
  errorSummary?: string | null;
};

type Filter = "all" | "failed" | "slow";
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const SLOW_REQUEST_MS = 500;

const operationIcons: Record<
  McpLogOperation,
  ComponentType<{ className?: string }>
> = {
  toolCall: Wrench,
  listTools: List,
  initialize: Braces,
  healthCheck: HeartPulse,
  ping: Activity,
  notification: Activity,
  request: Braces,
};

function operationLabel(operation: McpLogOperation, t: Translate): string {
  switch (operation) {
    case "toolCall":
      return t("toolCall");
    case "listTools":
      return t("listTools");
    case "initialize":
      return t("initialize");
    case "healthCheck":
      return t("healthCheck");
    case "ping":
      return t("ping");
    case "notification":
      return t("notification");
    default:
      return t("mcpRequest");
  }
}

export function McpRequestLogs({
  logs,
  showServer = false,
  refreshIntervalMs = 0,
  searchControls,
}: {
  logs: McpRequestLogView[];
  showServer?: boolean;
  refreshIntervalMs?: number;
  searchControls?: ReactNode;
}) {
  const t = useTranslations("console.observability") as Translate;
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [isRefreshing, startRefresh] = useTransition();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const rows = useMemo(
    () =>
      logs.map((log) => ({
        log,
        inspection: inspectMcpLog(log),
      })),
    [logs],
  );
  const failed = rows.filter(
    (row) => row.inspection.outcome === "error",
  ).length;
  const slow = rows.filter(
    (row) => row.log.durationMs >= SLOW_REQUEST_MS,
  ).length;
  const average = rows.length
    ? Math.round(
        rows.reduce((total, row) => total + row.log.durationMs, 0) /
          rows.length,
      )
    : 0;
  const normalizedQuery = searchControls ? "" : query.trim().toLowerCase();
  const filtered = rows.filter(({ log, inspection }) => {
    if (filter === "failed" && inspection.outcome !== "error") return false;
    if (filter === "slow" && log.durationMs < SLOW_REQUEST_MS) return false;
    if (!normalizedQuery) return true;
    return [
      inspection.operation,
      inspection.rpcMethod,
      inspection.toolName,
      log.deploymentName,
      log.method,
      log.path,
      inspection.errorSummary,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
  const filtersActive = filter !== "all" || Boolean(normalizedQuery);

  function refresh() {
    startRefresh(() => router.refresh());
  }

  useEffect(() => {
    if (refreshIntervalMs <= 0 || !autoRefresh) return;
    const timer = window.setInterval(() => {
      startRefresh(() => router.refresh());
    }, refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshIntervalMs, autoRefresh, router]);

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setFilter("all");
  }

  return (
    <section className="space-y-4" aria-label={t("requestLog")}>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span>{t("loadedRequests", { count: logs.length })}</span>
        <span>
          {t("failedRequests")}:{" "}
          <strong className={failed ? "text-destructive" : undefined}>
            {failed}
          </strong>
        </span>
        <span>
          {t("avgLatency")}: {average}
          {t("ms")}
        </span>
        <span>
          {t("slowRequests", { threshold: SLOW_REQUEST_MS })}: {slow}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3">
        <div className={searchControls ? "min-w-0" : "w-full sm:max-w-sm"}>
          {searchControls ?? (
            <Input
              value={query}
              onChange={setQuery}
              placeholder={t("searchLogs")}
              aria-label={t("searchLogs")}
              leftIcon={<Search className="size-4" />}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {searchControls ? (
            <span className="text-xs text-muted-foreground">
              {t("currentPage")}
            </span>
          ) : null}
          <fieldset
            className="m-0 flex min-w-0 flex-wrap gap-1 rounded-md border border-border bg-background p-0.5"
            aria-label={t("filterLogs")}
          >
            {(
              [
                ["all", t("allLogs"), logs.length],
                ["failed", t("failedRequests"), failed],
                [
                  "slow",
                  t("slowRequests", { threshold: SLOW_REQUEST_MS }),
                  slow,
                ],
              ] as const
            ).map(([value, label, count]) => (
              <Button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                variant={filter === value ? "primary" : "ghost"}
                size="sm"
              >
                {label} <span className="tabular-nums">{count}</span>
              </Button>
            ))}
          </fieldset>
          <Button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            variant="secondary"
            size="sm"
          >
            <RefreshCw
              className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
            />
            {t("refresh")}
          </Button>
          {refreshIntervalMs > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={autoRefresh}
              onClick={() => setAutoRefresh((value) => !value)}
            >
              {t(autoRefresh ? "pauseAutoRefresh" : "resumeAutoRefresh")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t("showingFilteredRequests", {
            shown: filtered.length,
            total: logs.length,
          })}
        </span>
        {refreshIntervalMs > 0 && autoRefresh ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-(--color-success)" />
            {t("autoRefreshing")}
          </span>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center min-h-44">
          <Search className="mb-3 size-7 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t(logs.length ? "noMatchingRequests" : "noRequestsYet")}
          </p>
          {filtersActive ? (
            <Button
              type="button"
              onClick={clearFilters}
              variant="secondary"
              size="sm"
              className="mt-4"
            >
              <X className="size-3.5" />
              {t("clearLogFilters")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="max-h-[42rem] overflow-auto rounded-lg border border-border bg-card">
          <div className="divide-y divide-border">
            {filtered.map(({ log, inspection }) => {
              const expanded = open.has(log.id);
              const hasDetails = Boolean(
                log.path || log.requestBody || log.responseBody,
              );
              const Icon = operationIcons[inspection.operation];
              const detailsId = `mcp-log-details-${log.id}`;
              const isError = inspection.outcome === "error";
              const readableOperation = operationLabel(inspection.operation, t);
              const rowLabel = [
                readableOperation,
                inspection.toolName,
                isError ? t("error") : t("success"),
                log.time,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <article
                  key={log.id}
                  className={isError ? "bg-destructive/[0.025]" : undefined}
                >
                  <Button
                    type="button"
                    onClick={() => hasDetails && toggle(log.id)}
                    aria-expanded={hasDetails ? expanded : undefined}
                    aria-controls={hasDetails ? detailsId : undefined}
                    aria-label={rowLabel}
                    variant="ghost"
                    size="md"
                    className="group flex h-auto w-full flex-wrap items-start justify-start whitespace-normal py-3 text-left"
                  >
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                        isError
                          ? "bg-destructive/10 text-destructive"
                          : inspection.operation === "toolCall"
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-foreground">
                          {readableOperation}
                        </span>
                        {inspection.toolName ? (
                          <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                            {inspection.toolName}
                          </code>
                        ) : null}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">{log.method}</span>
                        {inspection.rpcMethod &&
                        inspection.operation !== "toolCall" ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {inspection.rpcMethod}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 pt-0.5">
                      <AnimatedBadge
                        status={isError ? "danger" : "success"}
                        size="sm"
                        showIcon={false}
                      >
                        {isError ? t("error") : t("success")}
                      </AnimatedBadge>
                      <span
                        className={`inline-flex items-center gap-1 text-xs tabular-nums ${
                          log.durationMs >= SLOW_REQUEST_MS
                            ? "text-(--color-warning) dark:text-(--color-warning)"
                            : "text-muted-foreground"
                        }`}
                      >
                        <Clock3 className="size-3.5" />
                        {log.durationMs}
                        {t("ms")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {log.time}
                      </span>
                      {hasDetails ? (
                        <ChevronDown
                          className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      ) : null}
                    </span>
                  </Button>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 pl-[3.75rem] text-xs text-muted-foreground">
                    {log.statusCode > 0 ? (
                      <span>{t("httpStatus", { status: log.statusCode })}</span>
                    ) : null}
                    {showServer && log.deploymentName ? (
                      <>
                        <span aria-hidden="true">·</span>
                        {log.deploymentHref ? (
                          <Link
                            href={log.deploymentHref}
                            className="font-medium text-foreground hover:underline"
                          >
                            {log.deploymentName}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">
                            {log.deploymentName}
                          </span>
                        )}
                      </>
                    ) : null}
                  </div>

                  {isError && inspection.errorSummary ? (
                    <p className="mx-4 mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-destructive">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>{inspection.errorSummary}</span>
                    </p>
                  ) : null}

                  {expanded && hasDetails ? (
                    <div
                      id={detailsId}
                      className="border-t border-border bg-muted/[0.18] px-4 py-4"
                    >
                      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {log.path ? (
                          <span>
                            <span className="font-medium text-foreground">
                              {t("rawEndpoint")}:
                            </span>{" "}
                            <code className="break-all font-mono">
                              {log.path}
                            </code>
                          </span>
                        ) : null}
                        {log.statusCode > 0 ? (
                          <span>
                            <span className="font-medium text-foreground">
                              {t("status")}:
                            </span>{" "}
                            {t("httpStatus", { status: log.statusCode })}
                          </span>
                        ) : null}
                        <span>
                          <span className="font-medium text-foreground">
                            {t("duration")}:
                          </span>{" "}
                          {log.durationMs}
                          {t("ms")}
                        </span>
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        <LogPayload
                          label={t("request")}
                          value={log.requestBody}
                          copyLabel={t("copyPayload", { label: t("request") })}
                          unavailableText={t("payloadUnavailable")}
                        />
                        <LogPayload
                          label={t("response")}
                          value={log.responseBody}
                          copyLabel={t("copyPayload", { label: t("response") })}
                          unavailableText={t("payloadUnavailable")}
                        />
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
