"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { DashboardPanel, DashboardTable } from "./DashboardUI";
import { notify } from "./Toaster";
import { apiRequest } from "@/lib/client/api";

export type UsageTotals = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  failedTurns: number;
};
export type BudgetDTO = {
  monthlyUsd: number | null;
  spentUsd: number;
  percent: number | null;
  status: "none" | "ok" | "warning" | "exceeded";
};
type AgentUsage = {
  monthToDate: UsageTotals;
  budget: BudgetDTO;
  daily: (UsageTotals & { date: string })[];
};
type WorkspaceUsage = {
  agents: (UsageTotals & {
    agentId: string;
    name: string;
    budget: BudgetDTO;
  })[];
};

function BudgetStatus({ budget }: { budget: BudgetDTO }) {
  const t = useTranslations("console.agentUsage");
  return (
    <span
      className={
        budget.status === "exceeded"
          ? "font-medium text-destructive"
          : budget.status === "warning"
            ? "font-medium text-amber-600 dark:text-amber-400"
            : "text-muted-foreground"
      }
    >
      {t(`status.${budget.status}`)}
      {budget.percent !== null ? ` · ${budget.percent.toFixed(1)}%` : ""}
    </span>
  );
}

export function AgentUsagePanel({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const t = useTranslations("console.agentUsage");
  const common = useTranslations("common");
  const [data, setData] = useState<AgentUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monthlyUsd, setMonthlyUsd] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}`;
  const load = useEffectEvent(async (url: string, signal: AbortSignal) => {
    const result = await apiRequest<AgentUsage>(`${url}/usage?days=30`, {
      signal,
      cache: "no-store",
    });
    if (signal.aborted) return;
    if (!result.ok) {
      setError(result.message ?? t("loadFailed"));
      return;
    }
    setData(result.data);
    setMonthlyUsd(result.data.budget.monthlyUsd?.toString() ?? "");
    setError(null);
  });
  useEffect(() => {
    const controller = new AbortController();
    void load(base, controller.signal);
    return () => controller.abort();
  }, [base]);
  return (
    <div className="min-w-0 space-y-6 px-6 py-5">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {common("loading")}
        </p>
      ) : null}
      {data ? (
        <>
          <DashboardPanel title={t("monthToDate")}>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">{t("cost")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  ${data.monthToDate.costUsd.toFixed(6)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("tokens")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {(
                    data.monthToDate.inputTokens +
                    data.monthToDate.outputTokens +
                    data.monthToDate.cacheReadTokens +
                    data.monthToDate.cacheWriteTokens
                  ).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("turns")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {data.monthToDate.turns.toLocaleString()}
                </dd>
              </div>
            </dl>
          </DashboardPanel>
          <form
            className="space-y-3 rounded-xl border border-border p-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (flight.current) return;
              flight.current = true;
              setBusy(true);
              const result = await apiRequest<{ budget: BudgetDTO }>(
                `${base}/budget`,
                {
                  method: "PUT",
                  json: {
                    monthlyUsd:
                      monthlyUsd.trim() === "" ? null : Number(monthlyUsd),
                  },
                },
              );
              flight.current = false;
              setBusy(false);
              if (!result.ok) {
                notify(result.message ?? t("saveFailed"), {
                  severity: "error",
                });
                return;
              }
              setData({ ...data, budget: result.data.budget });
              setMonthlyUsd(result.data.budget.monthlyUsd?.toString() ?? "");
              notify(t("saved"));
            }}
          >
            <label
              htmlFor="agent-monthly-budget"
              className="block text-sm font-medium"
            >
              {t("monthlyBudget")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="agent-monthly-budget"
                type="number"
                min="0"
                step="0.000001"
                placeholder={t("unlimited")}
                value={monthlyUsd}
                disabled={!canManage || busy}
                onChange={setMonthlyUsd}
                className="w-full sm:w-56"
              />
              <Button disabled={!canManage || busy} type="submit">
                {common("save")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("budgetHint")}</p>
            <p role="status" className="text-sm">
              <BudgetStatus budget={data.budget} />
            </p>
          </form>
          <DashboardPanel title={t("last30Days")} padded={false}>
            <DashboardTable
              headers={[
                "date",
                "cost",
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
                "turns",
                "failedTurns",
              ].map((key) => ({ label: t(key) }))}
              rows={data.daily.map((day) => ({
                id: day.date,
                cells: [
                  day.date,
                  `$${day.costUsd.toFixed(6)}`,
                  day.inputTokens.toLocaleString(),
                  day.outputTokens.toLocaleString(),
                  day.cacheReadTokens.toLocaleString(),
                  day.cacheWriteTokens.toLocaleString(),
                  day.turns,
                  day.failedTurns,
                ],
              }))}
            />
          </DashboardPanel>
        </>
      ) : null}
    </div>
  );
}

export function WorkspaceAgentUsage({ slug }: { slug: string }) {
  const t = useTranslations("console.agentUsage");
  const common = useTranslations("common");
  const [data, setData] = useState<WorkspaceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/v1/workspaces/${encodeURIComponent(slug)}/agent-usage?days=30`;
  const load = useEffectEvent(
    async (requestUrl: string, signal: AbortSignal) => {
      const result = await apiRequest<WorkspaceUsage>(requestUrl, {
        signal,
        cache: "no-store",
      });
      if (signal.aborted) return;
      if (!result.ok) {
        setError(result.message ?? t("loadFailed"));
        return;
      }
      setData(result.data);
      setError(null);
    },
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(url, controller.signal);
    return () => controller.abort();
  }, [url]);
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {common("loading")}
      </p>
    );
  return (
    <DashboardPanel title={t("workspaceTitle")} padded={false}>
      <DashboardTable
        headers={[
          "agent",
          "cost",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "turns",
          "monthlyBudget",
          "budgetStatus",
        ].map((key) => ({ label: t(key) }))}
        rows={data.agents.map((agent) => ({
          id: agent.agentId,
          cells: [
            <ButtonLink
              key="agent"
              variant="ghost"
              size="sm"
              href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agent.agentId)}?settings=usage`}
            >
              {agent.name}
            </ButtonLink>,
            `$${agent.costUsd.toFixed(6)}`,
            agent.inputTokens.toLocaleString(),
            agent.outputTokens.toLocaleString(),
            agent.cacheReadTokens.toLocaleString(),
            agent.cacheWriteTokens.toLocaleString(),
            agent.turns,
            agent.budget.monthlyUsd === null
              ? t("unlimited")
              : `$${agent.budget.monthlyUsd}`,
            <BudgetStatus key="budget" budget={agent.budget} />,
          ],
        }))}
      />
      {data.agents.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">{t("noAgents")}</p>
      ) : null}
    </DashboardPanel>
  );
}
