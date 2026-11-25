"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ExternalLink, X } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { FormSelect } from "@/components/ui/FormSelect";
import { ENTRY_KINDS } from "@/lib/agents/entry-kinds";
import { apiRequest } from "@/lib/client/api";
import type {
  A2ATaskDetail as A2ATaskDetailView,
  A2ATaskSummary,
  AgentRunDetail as AgentRunDetailView,
  AgentRunSummary,
  McpCallDetail as McpCallDetailView,
  McpCallSummary,
  NamedEntity,
  TimeFilter,
  ViewPage,
} from "@/lib/observability/views/types";
import { A2ATaskDetail } from "./A2ATaskDetail";
import { A2ATaskTable } from "./A2ATaskTable";
import { AgentRunDetail } from "./AgentRunDetail";
import { AgentRunTable } from "./AgentRunTable";
import { McpCallDetail } from "./McpCallDetail";
import { McpCallTable } from "./McpCallTable";
import { EmptyState } from "./LogPrimitives";
import { TimeRangePicker } from "./TimeRangePicker";
import { LiveToggle } from "./LiveToggle";

type LogItem = McpCallSummary | A2ATaskSummary | AgentRunSummary;
type LogDetail = McpCallDetailView | A2ATaskDetailView | AgentRunDetailView;
const commonKeys = ["range", "since", "until", "q"];

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
  kind: "mcp" | "a2a" | "runs";
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
  const common = useTranslations("common");
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fieldId = useId();
  const [page, setPage] = useState<ViewPage<LogItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [liveAfter, setLiveAfter] = useState("");
  const [slowChecked, setSlowChecked] = useState(params.slow === "true");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspectDetail, setInspectDetail] = useState<LogDetail | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
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
      : [
          ...commonKeys,
          "agentId",
          kind === "runs" ? "entryKind" : "direction",
          "state",
        ];
  const query = new URLSearchParams();
  for (const key of keys) if (params[key]) query.set(key, params[key]);
  if (admin && params.workspaceId) query.set("workspaceId", params.workspaceId);
  if (!query.has("range")) query.set("range", "24h");
  if (deploymentId) query.set("deploymentId", deploymentId);
  if (source) query.set("source", source);
  const tab = kind === "mcp" ? (source ?? "mcp") : kind;
  const filterString = query.toString();
  if (params.cursor) query.set("cursor", params.cursor);
  const queryString = query.toString();
  const apiBase = admin
    ? "/api/v1/admin/logs"
    : `/api/v1/workspaces/${encodeURIComponent(workspaceSlug ?? "")}/logs`;
  const base = admin
    ? "/admin/logs"
    : `/app/${encodeURIComponent(workspaceSlug ?? "")}/observability`;
  const path =
    kind === "mcp" ? "mcp-calls" : kind === "runs" ? "agent-runs" : "a2a-tasks";
  const requestUrl = `${apiBase}/${path}?${queryString}`;
  const streamUrl = `${apiBase}/stream?kind=${kind}&${filterString}&after=${encodeURIComponent(liveAfter)}`;
  const filter = useMemo(
    () => Object.fromEntries(new URLSearchParams(filterString)) as TimeFilter,
    [filterString],
  );

  useEffect(() => {
    setSlowChecked(params.slow === "true");
  }, [params.slow]);

  useEffect(() => {
    if (!inspectId) {
      setInspectDetail(null);
      setInspectError(null);
      return;
    }
    const controller = new AbortController();
    setInspectLoading(true);
    setInspectError(null);
    setInspectDetail(null);
    void apiRequest<LogDetail>(
      `${apiBase}/${path}/${encodeURIComponent(inspectId)}`,
      {
        signal: controller.signal,
        cache: "no-store",
      },
    ).then((res) => {
      if (controller.signal.aborted) return;
      if (res.ok) setInspectDetail(res.data);
      else setInspectError(res.message ?? t("loadError"));
      setInspectLoading(false);
    });
    return () => controller.abort();
  }, [apiBase, inspectId, path, t]);

  function applyFormFilters(form: HTMLFormElement | null) {
    if (!form) return;
    const data = new FormData(form);
    const nextParams = new URLSearchParams();
    for (const [key, val] of data.entries()) {
      const str = String(val).trim();
      if (str) nextParams.set(key, str);
    }
    router.replace(`${base}?${nextParams.toString()}`, { scroll: false });
  }

  useEffect(() => {
    void retry;
    const controller = new AbortController();
    setLiveAfter(new Date().toISOString());
    setLoading(true);
    setError(null);
    setPage(null);
    async function load() {
      const result = await apiRequest<ViewPage<LogItem>>(requestUrl, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (controller.signal.aborted) return;
      if (result.ok) setPage(result.data);
      else setError(result.message ?? t("loadError"));
      setLoading(false);
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
  const returnToHref = `${base}?tab=${tab}&${queryString}`;
  const detailSubpath =
    kind === "mcp" ? "mcp" : kind === "runs" ? "runs" : "a2a";
  const inspectFullHref = inspectId
    ? `${base}/${detailSubpath}/${encodeURIComponent(inspectId)}?returnTo=${encodeURIComponent(returnToHref)}`
    : null;
  return (
    <div className="min-w-0 space-y-4">
      <form
        ref={formRef}
        key={filterString}
        action={base}
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          applyFormFilters(event.currentTarget);
        }}
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
            <div className="flex h-10 items-center pb-0.5">
              <FormCheckbox
                name="slow"
                value="true"
                checked={slowChecked}
                onCheckedChange={(checked) => {
                  setSlowChecked(checked);
                  window.setTimeout(() => applyFormFilters(formRef.current), 0);
                }}
                label={t("slow")}
              />
            </div>
            {slowChecked ? (
              <label
                htmlFor={`${fieldId}-slow-ms`}
                className="grid gap-1 text-xs text-muted-foreground"
              >
                {t("slowThreshold")}
                <Input
                  id={`${fieldId}-slow-ms`}
                  type="number"
                  name="slowMs"
                  min={1}
                  defaultValue={params.slowMs ?? "2000"}
                  className="w-24"
                />
              </label>
            ) : null}
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
            {kind === "runs" ? (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <label htmlFor={`${fieldId}-entry-kind`}>
                  {t("entryKind")}
                </label>
                <FormSelect
                  id={`${fieldId}-entry-kind`}
                  name="entryKind"
                  label={t("entryKind")}
                  defaultValue={params.entryKind ?? ""}
                  className="w-40"
                  options={[
                    { value: "", label: t("all") },
                    ...ENTRY_KINDS.map((value) => ({
                      value,
                      label: t(`entryKinds.${value}`),
                    })),
                  ]}
                />
              </div>
            ) : (
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
            )}
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
        {page && !params.cursor && (
          <LiveToggle<LogItem>
            key={streamUrl}
            url={streamUrl}
            onItems={mergeItems}
          />
        )}
      </div>
      {loading ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
        >
          <Loader variant="spinner" size={16} />
          <span>{t("loading")}</span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 p-4"
        >
          <p className="text-sm text-destructive">{error}</p>
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
              runDetailBase={`${base}/runs`}
              a2aDetailBase={`${base}/a2a`}
              showWorkspace={admin}
              returnTo={returnToHref}
              onInspect={setInspectId}
            />
          ) : kind === "runs" ? (
            <AgentRunTable
              items={page.items as AgentRunSummary[]}
              detailBase={`${base}/runs`}
              showWorkspace={admin}
              returnTo={returnToHref}
              onInspect={setInspectId}
            />
          ) : (
            <A2ATaskTable
              items={page.items as A2ATaskSummary[]}
              detailBase={`${base}/a2a`}
              runDetailBase={`${base}/runs`}
              showWorkspace={admin}
              returnTo={returnToHref}
              onInspect={setInspectId}
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
      <Drawer
        open={inspectId !== null}
        onOpenChange={(open) => {
          if (!open) setInspectId(null);
        }}
        side="right"
        ariaLabel={common("preview")}
        closeLabel={common("close")}
        className="w-full max-w-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {inspectId}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {inspectFullHref ? (
              <ButtonLink href={inspectFullHref} variant="secondary" size="sm">
                <ExternalLink className="size-3.5" />
                {common("viewAll")}
              </ButtonLink>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={common("close")}
              onClick={() => setInspectId(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
          {inspectLoading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
            >
              <Loader variant="spinner" size={16} />
              <span>{t("loading")}</span>
            </div>
          ) : inspectError ? (
            <p role="alert" className="text-sm text-destructive">
              {inspectError}
            </p>
          ) : inspectDetail ? (
            kind === "mcp" ? (
              <McpCallDetail detail={inspectDetail as McpCallDetailView} />
            ) : kind === "runs" ? (
              <AgentRunDetail
                detail={inspectDetail as AgentRunDetailView}
                base={base}
                workspaceSlug={workspaceSlug}
              />
            ) : (
              <A2ATaskDetail detail={inspectDetail as A2ATaskDetailView} />
            )
          ) : null}
        </div>
      </Drawer>
    </div>
  );
}
