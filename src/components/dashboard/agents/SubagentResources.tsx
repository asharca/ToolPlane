"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/motion/checkbox";

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
  slug,
  agentId,
  snapshot,
  draft,
  disabled,
  onLoad,
  onChange,
}: {
  slug: string;
  agentId: string;
  snapshot: SubagentResourcesSnapshot | null;
  draft: SubagentDraft | null;
  disabled: boolean;
  onLoad: (snapshot: SubagentResourcesSnapshot) => void;
  onChange: (draft: SubagentDraft) => void;
}) {
  const t = useTranslations("console.agents.subagentResources");
  const id = useId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
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
    setError(false);
    void fetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/subagents?workspace=${encodeURIComponent(slug)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("SUBAGENTS_LOAD_FAILED");
        const data = (await response.json()) as SubagentResourcesSnapshot;
        if (controller.signal.aborted) return;
        onLoad(data);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [agentId, slug, onLoad]);

  if (loading && !snapshot)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("loading")}
      </p>
    );
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadFailed")}
      </p>
    );
  if (!snapshot || !nativePolicy) return null;
  const update = (patch: Partial<SubagentDraft>) =>
    onChange({
      native: false,
      agentIds: [...selectedIds],
      nativePolicy,
      ...patch,
    });

  return (
    <div className="min-w-0 space-y-6">
      <p id={`${id}-help`} className="text-sm leading-6 text-muted-foreground">
        {t("help")}
      </p>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("label")}</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          {t("platformHelp")}
        </p>
        {!snapshot.agents.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <fieldset
            disabled={disabled}
            aria-describedby={`${id}-help`}
            className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background"
          >
            <legend className="sr-only">{t("label")}</legend>
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
        )}
      </section>
      <p className="text-sm text-muted-foreground">{t("platformOnly")}</p>
    </div>
  );
}
