"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import type {
  A2ATaskSummary,
  McpCallSummary,
  NamedEntity,
  TimeFilter,
  ViewPage,
} from "@/lib/observability/views/types";
import { A2ATaskTable } from "./A2ATaskTable";
import { McpCallTable } from "./McpCallTable";
import { EmptyState } from "./LogPrimitives";
import { TimeRangePicker } from "./TimeRangePicker";
import { LiveToggle } from "./LiveToggle";

type LogItem = McpCallSummary | A2ATaskSummary;
const commonKeys = ["range", "since", "until", "q"];
const fieldClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm";

/** Fetches only metadata. Bodies are fetched by the authorized detail pages. */
export function LogExplorer({
  kind,
  source,
  workspaceSlug,
  admin = false,
  workspaces = [],
  params = {},
  deploymentId,
  deployments = [],
  agents = [],
}: {
  kind: "mcp" | "a2a";
  /** `internal`: platform plumbing over MCP; `tools`: Agent tool calls (bash, read, MCP…). */
  source?: "internal" | "tools";
  workspaceSlug?: string;
  admin?: boolean;
  workspaces?: NamedEntity[];
  params?: Record<string, string | undefined>;
  deploymentId?: string;
  deployments?: NamedEntity[];
  agents?: NamedEntity[];
}) {
  const t = useTranslations("console.observability.viewer");
  const fieldId = useId();
  const [page, setPage] = useState<ViewPage<LogItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [liveAfter, setLiveAfter] = useState("");
  const keys =
    kind === "mcp"
      ? [
          ...commonKeys,
          "deploymentId",
          "tool",
          "method",
          "callerKind",
          "outcome",
          "slow",
          "slowMs",
        ]
      : [...commonKeys, "agentId", "direction", "state"];
  const query = new URLSearchParams();
  for (const key of keys) if (params[key]) query.set(key, params[key]);
  if (admin && params.workspaceId) query.set("workspaceId", params.workspaceId);
  if (!query.has("range")) query.set("range", "24h");
  if (deploymentId) query.set("deploymentId", deploymentId);
  if (source) query.set("source", source);
  const tab = kind === "a2a" ? "a2a" : (source ?? "mcp");
  const filterString = query.toString();
  if (params.cursor) query.set("cursor", params.cursor);
  const queryString = query.toString();
  const apiBase = admin
    ? "/api/v1/admin/logs"
    : `/api/v1/workspaces/${encodeURIComponent(workspaceSlug ?? "")}/logs`;
  const base = admin
    ? "/admin/logs"
    : `/app/${encodeURIComponent(workspaceSlug ?? "")}/observability`;
  const path = kind === "mcp" ? "mcp-calls" : "a2a-tasks";
  const requestUrl = `${apiBase}/${path}?${queryString}`;
  const streamUrl = `${apiBase}/stream?kind=${kind}&${filterString}&after=${encodeURIComponent(liveAfter)}`;
  const filter = useMemo(
    () => Object.fromEntries(new URLSearchParams(filterString)) as TimeFilter,
    [filterString],
  );

  useEffect(() => {
    void retry;
    const controller = new AbortController();
    setLiveAfter(new Date().toISOString());
    setLoading(true);
    setError(null);
    setPage(null);
    async function load() {
      try {
        const response = await fetch(requestUrl, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(payload?.error ?? `${response.status}`);
        }
        const result = (await response.json()) as ViewPage<LogItem>;
        if (!controller.signal.aborted) setPage(result);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("loadError"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [requestUrl, retry, t]);

  function mergeItems(incoming: LogItem[]) {
    setPage((current) => {
      if (!current || !incoming.length) return current;
      const merged = new Map(
        current.items.map((item) => [
          "id" in item ? item.id : item.taskId,
          item,
        ]),
      );
      for (const item of incoming)
        merged.set("id" in item ? item.id : item.taskId, item);
      const items = Array.from(merged.values()).sort((a, b) => {
        const aTime = "createdAt" in a ? a.createdAt : a.startedAt;
        const bTime = "createdAt" in b ? b.createdAt : b.startedAt;
        return (
          bTime.localeCompare(aTime) ||
          ("id" in b ? b.id : b.taskId).localeCompare(
            "id" in a ? a.id : a.taskId,
          )
        );
      });
      return { ...current, items };
    });
  }

  const nextQuery = new URLSearchParams(filterString);
  nextQuery.set("tab", tab);
  if (page?.nextCursor) nextQuery.set("cursor", page.nextCursor);
  return (
    <div className="min-w-0 space-y-4">
      <form
        key={filterString}
        action={base}
        method="get"
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="tab" value={tab} />
        <TimeRangePicker key={filterString} filter={filter} />
        {admin && (
          <div className="grid gap-1 text-xs text-muted-foreground">
            <label htmlFor={`${fieldId}-workspace`}>{t("workspace")}</label>
            <FormSelect
              id={`${fieldId}-workspace`}
              name="workspaceId"
              label={t("workspace")}
              defaultValue={params.workspaceId ?? ""}
              className="w-44"
              options={[
                { value: "", label: t("all") },
                ...workspaces.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
                ...(params.workspaceId &&
                !workspaces.some((item) => item.id === params.workspaceId)
                  ? [{ value: params.workspaceId, label: params.workspaceId }]
                  : []),
              ]}
            />
          </div>
        )}
        <label
          htmlFor={`${fieldId}-q`}
          className="grid gap-1 text-xs text-muted-foreground"
        >
          {t("search")}
          <Input
            id={`${fieldId}-q`}
            name="q"
            defaultValue={params.q}
            maxLength={200}
            placeholder={t("searchPlaceholder")}
            className="w-full sm:w-56"
          />
        </label>
        {kind === "mcp" ? (
          <>
            {deploymentId ? (
              <input type="hidden" name="deploymentId" value={deploymentId} />
            ) : (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <label htmlFor={`${fieldId}-deployment`}>{t("server")}</label>
                <FormSelect
                  id={`${fieldId}-deployment`}
                  name="deploymentId"
                  label={t("server")}
                  defaultValue={params.deploymentId ?? ""}
                  className="w-44"
                  options={[
                    { value: "", label: t("all") },
                    ...deployments.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                    ...(params.deploymentId &&
                    !deployments.some((item) => item.id === params.deploymentId)
                      ? [
                          {
                            value: params.deploymentId,
                            label: params.deploymentId,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            )}
            <label
              htmlFor={`${fieldId}-tool`}
              className="grid gap-1 text-xs text-muted-foreground"
            >
              {t("tool")}
              <Input
                id={`${fieldId}-tool`}
                name="tool"
                defaultValue={params.tool}
                className="w-40"
              />
            </label>
            <label
              htmlFor={`${fieldId}-method`}
              className="grid gap-1 text-xs text-muted-foreground"
            >
              {t("method")}
              <Input
                id={`${fieldId}-method`}
                name="method"
                defaultValue={params.method}
                className="w-40"
              />
            </label>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <label htmlFor={`${fieldId}-caller`}>{t("caller")}</label>
              <FormSelect
                id={`${fieldId}-caller`}
                name="callerKind"
                label={t("caller")}
                defaultValue={params.callerKind ?? ""}
                className="w-36"
                options={[
                  { value: "", label: t("all") },
                  ...["user", "agent", "token"].map((value) => ({
                    value,
                    label: t(`parties.${value}`),
                  })),
                ]}
              />
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <label htmlFor={`${fieldId}-outcome`}>{t("status")}</label>
              <FormSelect
                id={`${fieldId}-outcome`}
                name="outcome"
                label={t("status")}
                defaultValue={params.outcome ?? ""}
                className="w-36"
                options={[
                  { value: "", label: t("all") },
                  ...["success", "error"].map((value) => ({
                    value,
                    label: t(`states.${value}`),
                  })),
                ]}
              />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="slow"
                value="true"
                defaultChecked={params.slow === "true"}
              />
              {t("slow")}
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("slowThreshold")}
              <input
                type="number"
                name="slowMs"
                min="1"
                defaultValue={params.slowMs ?? "2000"}
                className={`${fieldClass} w-24`}
              />
            </label>
          </>
        ) : (
          <>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <label htmlFor={`${fieldId}-agent`}>{t("agent")}</label>
              <FormSelect
                id={`${fieldId}-agent`}
                name="agentId"
                label={t("agent")}
                defaultValue={params.agentId ?? ""}
                className="w-44"
                options={[
                  { value: "", label: t("all") },
                  ...agents.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                  ...(params.agentId &&
                  !agents.some((item) => item.id === params.agentId)
                    ? [{ value: params.agentId, label: params.agentId }]
                    : []),
                ]}
              />
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <label htmlFor={`${fieldId}-direction`}>{t("direction")}</label>
              <FormSelect
                id={`${fieldId}-direction`}
                name="direction"
                label={t("direction")}
                defaultValue={params.direction ?? ""}
                className="w-36"
                options={[
                  { value: "", label: t("all") },
                  ...["inbound", "outbound", "internal"].map((value) => ({
                    value,
                    label: t(`directions.${value}`),
                  })),
                ]}
              />
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <label htmlFor={`${fieldId}-state`}>{t("status")}</label>
              <FormSelect
                id={`${fieldId}-state`}
                name="state"
                label={t("status")}
                defaultValue={params.state ?? ""}
                className="w-40"
                options={[
                  { value: "", label: t("all") },
                  ...[
                    "submitted",
                    "working",
                    "input-required",
                    "auth-required",
                    "completed",
                    "failed",
                    "canceled",
                    "rejected",
                    "unknown",
                  ].map((value) => ({
                    value,
                    label: t(`states.${value}`),
                  })),
                ]}
              />
            </div>
          </>
        )}
        <Button type="submit" variant="secondary" size="sm">
          {t("apply")}
        </Button>
        <ButtonLink
          href={`${base}?tab=${tab}${deploymentId ? `&deploymentId=${encodeURIComponent(deploymentId)}` : ""}`}
          variant="ghost"
          size="sm"
        >
          {t("reset")}
        </ButtonLink>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t(tab)}</h2>
        {page && !params.cursor && (
          <LiveToggle<LogItem>
            key={streamUrl}
            url={streamUrl}
            onItems={mergeItems}
          />
        )}
      </div>
      {loading ? (
        <p
          role="status"
          className="p-8 text-center text-sm text-muted-foreground"
        >
          {t("loading")}
        </p>
      ) : error ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 p-4"
        >
          <p className="text-sm text-destructive">
            {t("loadError")}: {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("retry")}
          </Button>
        </div>
      ) : page ? (
        <>
          {kind === "mcp" ? (
            <McpCallTable
              items={page.items as McpCallSummary[]}
              detailBase={`${base}/mcp`}
              showWorkspace={admin}
              returnTo={admin ? `${base}?tab=${tab}&${queryString}` : undefined}
            />
          ) : (
            <A2ATaskTable
              items={page.items as A2ATaskSummary[]}
              detailBase={`${base}/a2a`}
              showWorkspace={admin}
              returnTo={admin ? `${base}?tab=${tab}&${queryString}` : undefined}
            />
          )}
          <div className="flex items-center gap-3">
            {params.cursor && (
              <ButtonLink
                href={`${base}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(filterString)), tab })}`}
                variant="ghost"
                size="sm"
              >
                {t("latest")}
              </ButtonLink>
            )}
            {page.nextCursor && (
              <ButtonLink
                href={`${base}?${nextQuery}`}
                variant="secondary"
                size="sm"
              >
                {t("older")}
              </ButtonLink>
            )}
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
