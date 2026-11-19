"use client";

import {
  DisplayError,
  displayErrorText,
} from "@/components/dashboard/display-error";
import { apiRequest } from "@/lib/client/api";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, Plus, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Checkbox } from "@/components/motion/checkbox";
import { DashboardEmptyState } from "../DashboardUI";
import { SettingsSection } from "./SettingsSection";

export type PlatformSubagentOption = {
  id: string;
  name: string;
  description?: string | null;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
};

export type SubagentDraft = {
  native: boolean;
  agentIds: string[];
  nativePolicy: { maxConcurrency: number; maxDepth: number };
};

export type SubagentResourcesSnapshot = {
  native: boolean;
  nativePolicy: SubagentDraft["nativePolicy"];
  agents: PlatformSubagentOption[];
};

export function SubagentResources({
  title,
  slug,
  agentId,
  snapshot,
  draft,
  disabled,
  onLoad,
  onChange,
}: {
  title: string;
  slug: string;
  agentId: string;
  snapshot: SubagentResourcesSnapshot | null;
  draft: SubagentDraft | null;
  disabled: boolean;
  onLoad: (snapshot: SubagentResourcesSnapshot) => void;
  onChange: (draft: SubagentDraft) => void;
}) {
  const t = useTranslations("console.agents.subagentResources");
  const agents = useTranslations("console.agents");
  const id = useId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadFailed = t("loadFailed");
  const [adding, setAdding] = useState(false);
  const nativePolicy = draft?.nativePolicy ?? snapshot?.nativePolicy;
  const selectedIds = useMemo(
    () =>
      new Set(
        draft?.agentIds ??
          snapshot?.agents
            .filter((agent) => agent.checked)
            .map((agent) => agent.id) ??
          [],
      ),
    [snapshot, draft],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void apiRequest<SubagentResourcesSnapshot>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/subagents?workspace=${encodeURIComponent(slug)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((response) => {
        if (!response.ok)
          throw new DisplayError(response.message ?? loadFailed);
        const data = response.data;
        if (controller.signal.aborted) return;
        onLoad(data);
        setLoading(false);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(displayErrorText(cause, loadFailed));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [agentId, slug, onLoad, loadFailed]);

  const update = (patch: Partial<SubagentDraft>) =>
    nativePolicy &&
    onChange({
      native: false,
      agentIds: [...selectedIds],
      nativePolicy,
      ...patch,
    });
  const remove = (targetId: string) =>
    update({ agentIds: [...selectedIds].filter((id) => id !== targetId) });

  return (
    <SettingsSection
      id="subAgents"
      title={title}
      action={
        adding ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setAdding(false)}
          >
            {agents("resourceList.done")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || !snapshot?.agents.length}
            onClick={() => setAdding(true)}
          >
            <Plus className="size-4" aria-hidden />
            {agents("resourceList.add")}
          </Button>
        )
      }
    >
      {loading && !snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !snapshot || !nativePolicy ? null : adding ? (
        <fieldset
          disabled={disabled}
          className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background"
        >
          <legend className="sr-only">{title}</legend>
          {snapshot.agents.map((agent, index) => {
            const checked = selectedIds.has(agent.id);
            const detailsId = `${id}-details-${index}`;
            return (
              <div
                key={agent.id}
                className={`space-y-1 border-b border-border/60 px-4 py-3 last:border-b-0 ${checked ? "bg-muted/40" : ""}`}
              >
                <Checkbox
                  checked={checked}
                  label={agent.name}
                  aria-label={t("select", { name: agent.name })}
                  aria-describedby={
                    agent.description || agent.reason ? detailsId : undefined
                  }
                  disabled={disabled || Boolean(agent.disabled && !checked)}
                  onCheckedChange={(nextChecked) => {
                    const next = new Set(selectedIds);
                    if (nextChecked) next.add(agent.id);
                    else next.delete(agent.id);
                    update({ agentIds: [...next] });
                  }}
                />
                <div
                  id={detailsId}
                  className="space-y-1 pl-8 text-xs text-muted-foreground"
                >
                  {agent.description ? <p>{agent.description}</p> : null}
                  {agent.reason ? (
                    <p>
                      {t.has(`reasons.${agent.reason}`)
                        ? t(`reasons.${agent.reason}`)
                        : t("unavailable")}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>
      ) : selectedIds.size ? (
        <ul className="m-0 list-none divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 p-0">
          {snapshot.agents
            .filter((agent) => selectedIds.has(agent.id))
            .map((agent) => (
              <li
                key={agent.id}
                className="flex min-w-0 items-center gap-3 px-4 py-2.5"
              >
                <Bot
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {agent.name}
                  </span>
                  {agent.reason ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.has(`reasons.${agent.reason}`)
                        ? t(`reasons.${agent.reason}`)
                        : t("unavailable")}
                    </span>
                  ) : agent.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {agent.description}
                    </span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={agents("resourceList.remove", {
                    name: agent.name,
                  })}
                  title={agents("resourceList.remove", { name: agent.name })}
                  onClick={() => remove(agent.id)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
        </ul>
      ) : (
        <DashboardEmptyState
          icon={Bot}
          title={agents("resourceList.empty.subAgents.title")}
          description={agents("resourceList.empty.subAgents.description")}
          className="rounded-xl bg-muted/30"
        />
      )}
    </SettingsSection>
  );
}
