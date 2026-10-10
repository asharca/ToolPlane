"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { DashboardTable } from "@/components/dashboard/DashboardTable";
import {
  checkPiRuntimesAction,
  updatePiRuntimesAction,
} from "@/lib/agents/actions";
import type { PiRuntimeManagementState } from "@/lib/agents/actions";

export function PiRuntimeManagement({ slug }: { slug: string }) {
  const t = useTranslations("console.agents");
  const [state, setState] = useState<PiRuntimeManagementState | null>(null);
  const [version, setVersion] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lastUpdate, setLastUpdate] = useState<PiRuntimeManagementState | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const [operation, setOperation] = useState<"check" | "update">("check");

  useEffect(() => {
    let active = true;
    checkPiRuntimesAction(slug).then(
      (result) => {
        if (active) {
          setState(result);
          setSelectedIds(new Set());
          setLastUpdate(null);
        }
      },
      () => {
        if (active) setState({ error: t("piManagementFailed") });
      },
    );
    return () => {
      active = false;
    };
  }, [slug, t]);

  function run(target?: string) {
    if (target && !selectedAgents.length) return;
    setLastUpdate(null);
    setOperation(target ? "update" : "check");
    startTransition(async () => {
      try {
        const result = target
          ? await updatePiRuntimesAction(
              slug,
              target,
              selectedAgents.map((agent) => agent.agentId),
            )
          : await checkPiRuntimesAction(slug);
        const updated = new Map(
          result.agents?.map((agent) => [agent.agentId, agent]),
        );
        setState((previous) =>
          target
            ? {
                ...previous,
                ...result,
                agents:
                  previous?.agents?.map(
                    (agent) => updated.get(agent.agentId) ?? agent,
                  ) ?? result.agents,
                error: result.error,
                warning: result.warning,
                finishedAt: result.finishedAt,
              }
            : result,
        );
        if (target) setLastUpdate(result);
      } catch {
        setState((previous) => ({
          ...previous,
          finishedAt: undefined,
          error: t("piManagementFailed"),
        }));
      }
    });
  }

  const agents = state?.agents ?? [];
  const selectedAgents = agents.filter((agent) =>
    selectedIds.has(agent.agentId),
  );
  const batchAgents = lastUpdate?.agents ?? [];
  const busy = pending || state === null;
  const current =
    selectedAgents.length > 0 &&
    Boolean(state?.latestVersion) &&
    selectedAgents.every(
      (agent) =>
        agent.installed &&
        agent.version === state?.latestVersion &&
        agent.status !== "error",
    );
  const statusLabels = {
    ready: t("piReady"),
    updated: t("piAgentUpdated"),
    unchanged: t("piAgentUnchanged"),
    error: t("piAgentFailed"),
  };

  return (
    <section
      aria-label={t("agentManagement")}
      aria-busy={busy}
      className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t("piRuntimeVersion")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("piRuntimeUpgradeHelp")}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
        <dt className="text-muted-foreground">{t("piAgentCount")}</dt>
        <dd>{agents.length}</dd>
        <dt className="text-muted-foreground">{t("piLatestVersion")}</dt>
        <dd>
          <code>{state?.latestVersion ?? "—"}</code>
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => run()}
          aria-busy={busy && operation === "check"}
        >
          {busy && operation === "check" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {t("piCheckUpdates")}
        </Button>
      </div>
      <div aria-live="polite" className="space-y-2 text-xs leading-5">
        {state?.error ? (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        ) : null}
        {state?.warning ? (
          <p className="text-muted-foreground">{state.warning}</p>
        ) : null}
        {lastUpdate?.finishedAt && !state?.error && !pending ? (
          <p role="status">
            {t("piBatchSummary", {
              version: lastUpdate.targetVersion ?? "",
              updated: batchAgents.filter((agent) => agent.status === "updated")
                .length,
              unchanged: batchAgents.filter(
                (agent) => agent.status === "unchanged",
              ).length,
              failed: batchAgents.filter((agent) => agent.status === "error")
                .length,
            })}
          </p>
        ) : null}
      </div>
      {agents.length ? (
        <DashboardTable
          ariaLabel={t("agentManagement")}
          minWidth="36rem"
          selectedRowIds={[...selectedIds]}
          onSelectionChange={(ids) => {
            if (!busy) setSelectedIds(new Set(ids));
          }}
          selectionActions={() => (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy || current}
                onClick={() => run("latest")}
                aria-busy={pending && operation === "update"}
              >
                {pending && operation === "update" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {pending && operation === "update"
                  ? t("piUpdating")
                  : current
                    ? t("piUpToDate")
                    : t("piUpdateLatest")}
              </Button>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && selectedAgents.length && version.trim())
                    run(version.trim());
                }}
              >
                <Input
                  aria-label={t("piTargetVersion")}
                  value={version}
                  onChange={setVersion}
                  maxLength={80}
                  placeholder="0.80.3"
                  disabled={busy}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !version.trim()}
                >
                  {t("piInstallVersion")}
                </Button>
              </form>
            </>
          )}
          headers={[
            { label: t("piAgentName") },
            { label: t("piCurrentVersion") },
            { label: t("piAgentResult") },
          ]}
          rows={agents.map((agent) => ({
            id: agent.agentId,
            cells: [
              <span key="name" title={agent.name}>
                {agent.name}
              </span>,
              <div key="version">
                <code>{agent.version ?? "—"}</code>
                {agent.version && !agent.installed ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("piNotInstalled")}
                  </p>
                ) : null}
              </div>,
              <div key="status">
                <span
                  className={agent.status === "error" ? "text-destructive" : ""}
                >
                  {statusLabels[agent.status]}
                </span>
                {agent.error ? (
                  <p
                    title={agent.error}
                    className="mt-1 text-xs text-destructive"
                  >
                    {agent.error}
                  </p>
                ) : null}
              </div>,
            ],
          }))}
        />
      ) : state && !state.error ? (
        <p className="text-sm text-muted-foreground">{t("piNoAgents")}</p>
      ) : null}
    </section>
  );
}
