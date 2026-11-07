"use client";

import { type ReactNode, useDeferredValue, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Cable,
  ExternalLink,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { pluginAction } from "@/lib/plugins/actions";
import type { PluginBindingDeployment } from "@/lib/plugins/binding-deployments";
import {
  PluginMcpBindingFields,
  pluginBindingState,
  type PluginBindingDraft,
  type PluginMcpRequirement,
} from "../plugins/PluginForms";
import { notify } from "../Toaster";
import { AgentPluginSyncReview } from "./AgentPluginSyncReview";
import type { AgentPiPackageOption } from "./AgentSettingsForm";
import type { PluginSelectionResult } from "../plugins/usePluginAgentFlow";

export const MAX_AGENT_PLUGINS = 16;

/** A published, compatible plugin that the workspace has not installed yet. */
export type AgentPluginCatalogOption = {
  listingId: string;
  name: string;
  summary: string | null;
  version: string;
  skillCount: number;
  extensionCount: number;
  requirements: PluginMcpRequirement[];
};

type PackageSelection = { marketInstallId: string; releaseId: string };

export function AgentPluginsPanel({
  slug,
  agentId,
  runtimeKind,
  options,
  catalog,
  deployments,
  packages,
  applied,
  canManage,
  locked,
  flowContext,
  flowResult,
  clearFlowResult,
  onAdd,
  onInstalled,
  onChange,
}: {
  slug: string;
  agentId: string;
  runtimeKind: string;
  /** Workspace installs usable by this Agent, plus any it already binds. */
  options: AgentPiPackageOption[];
  catalog: AgentPluginCatalogOption[];
  /** Workspace MCP deployments that market plugin requirements can bind. */
  deployments: PluginBindingDeployment[];
  /** Local draft selection. */
  packages: PackageSelection[];
  /** Selection pinned by the applied revision. */
  applied: PackageSelection[];
  canManage: boolean;
  /** Unsaved edits or a pending request block sync approval. */
  locked: boolean;
  flowContext: string;
  flowResult: PluginSelectionResult | null;
  clearFlowResult: () => void;
  onAdd: (listingId: string) => PluginSelectionResult;
  onInstalled: (listingId: string) => Promise<PluginSelectionResult>;
  onChange: (next: PackageSelection[]) => void;
}) {
  const t = useTranslations("console.agents.pluginPanel");
  const agents = useTranslations("console.agents");
  const flow = useTranslations("console.plugins.flow");
  const pluginErrors = useTranslations("console.plugins.errors");
  const [adding, setAdding] = useState(false);
  // One market plugin at a time expands to bind its MCP requirements in place.
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [bindings, setBindings] = useState<PluginBindingDraft>({});
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const search = useDeferredValue(query.trim().toLowerCase());
  const editable = canManage && runtimeKind === "pi-sdk";
  const full = packages.length >= MAX_AGENT_PLUGINS;
  const pluginHref = (listingId: string, hash = "") =>
    `/app/${encodeURIComponent(slug)}/plugins/${encodeURIComponent(listingId)}?${flowContext}${hash}`;

  // Cross-tab selections and installs report here; the draft row itself shows success.
  useEffect(() => {
    if (!flowResult) return;
    if (flowResult !== "selected")
      notify(flow(flowResult), {
        severity: flowResult === "duplicate" ? "info" : "error",
      });
    clearFlowResult();
  }, [flowResult, clearFlowResult, flow]);

  const selectedFor = (pkg: AgentPiPackageOption) =>
    packages.find((entry) => entry.marketInstallId === pkg.marketInstallId);
  const rows = options.filter(
    (pkg) =>
      selectedFor(pkg) ||
      pkg.enabledReleaseId ||
      applied.some((entry) => entry.marketInstallId === pkg.marketInstallId),
  );
  const installed = options.filter(
    (pkg) =>
      `${pkg.name} ${pkg.summary ?? ""}`.toLowerCase().includes(search) &&
      (pkg.currentAvailable || selectedFor(pkg)),
  );
  const installable = catalog.filter(
    (item) =>
      `${item.name} ${item.summary ?? ""}`.toLowerCase().includes(search) &&
      !options.some((pkg) => pkg.listingId === item.listingId),
  );

  function counts(item: {
    skillCount?: number;
    extensionCount?: number;
    mcpRequirementCount?: number;
  }) {
    return flow("counts", {
      skills: item.skillCount ?? 0,
      extensions: item.extensionCount ?? 0,
      mcp: item.mcpRequirementCount ?? 0,
    });
  }

  function add(listingId: string) {
    const outcome = onAdd(listingId);
    if (outcome !== "selected")
      notify(flow(outcome), {
        severity: outcome === "duplicate" ? "info" : "error",
      });
  }

  async function install(
    item: AgentPluginCatalogOption,
    mcpBindings: Record<string, unknown>,
  ) {
    setInstalling(item.listingId);
    try {
      const form = new FormData();
      form.set("workspace", slug);
      form.set("operation", "add");
      form.set("id", item.listingId);
      form.set("mcpBindings", JSON.stringify(mcpBindings));
      const result = await pluginAction({}, form);
      if (!result.success) {
        notify(
          pluginErrors.has(result.error ?? "")
            ? pluginErrors(result.error ?? "")
            : pluginErrors("operation_failed"),
          { severity: "error" },
        );
        return;
      }
      window.dispatchEvent(new Event("plugins-changed"));
      setConfiguring(null);
      await onInstalled(item.listingId);
    } finally {
      setInstalling(null);
    }
  }

  const addButton = (
    <Button
      type="button"
      size="sm"
      disabled={!editable || full}
      onClick={() => setAdding(true)}
    >
      <Plus className="size-4" />
      {t("add")}
    </Button>
  );

  if (adding)
    return (
      // Search and binding selects must not mark the Agent form dirty.
      <div className="space-y-4" onChange={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAdding(false);
              setConfiguring(null);
            }}
          >
            <ArrowLeft className="size-4" />
            {t("back")}
          </Button>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {t("selectedCount", {
              count: packages.length,
              max: MAX_AGENT_PLUGINS,
            })}
          </span>
        </div>
        <Input
          leftIcon={<Search />}
          type="search"
          value={query}
          placeholder={t("search")}
          aria-label={t("search")}
          className="w-full"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          onChange={(value) => setQuery(value)}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {flow("prerequisites")}
        </p>
        {full ? (
          <p role="status" className="text-sm">
            {flow("limit")}
          </p>
        ) : null}
        {installed.length ? (
          <PickerSection title={t("installed")}>
            {installed.map((pkg) => (
              <PickerRow
                key={pkg.marketInstallId}
                name={pkg.name}
                version={pkg.currentVersion}
                summary={pkg.summary}
                counts={counts(pkg)}
              >
                {selectedFor(pkg) ? (
                  <AnimatedBadge size="sm" status="success">
                    {t("added")}
                  </AnimatedBadge>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!editable || full}
                    onClick={() => add(pkg.listingId)}
                  >
                    {t("addAction")}
                  </Button>
                )}
              </PickerRow>
            ))}
          </PickerSection>
        ) : null}
        {installable.length ? (
          <PickerSection title={t("catalog")}>
            {installable.map((item) => {
              const open = configuring === item.listingId;
              const binding = pluginBindingState(
                item.requirements,
                deployments,
                open ? bindings : {},
              );
              const busy = installing === item.listingId;
              return (
                <PickerRow
                  key={item.listingId}
                  name={item.name}
                  version={item.version}
                  summary={item.summary}
                  counts={counts({
                    ...item,
                    mcpRequirementCount: item.requirements.length,
                  })}
                  expanded={
                    open ? (
                      <div className="space-y-3">
                        <PluginMcpBindingFields
                          requirements={item.requirements}
                          deployments={deployments}
                          bindings={bindings}
                          onChange={setBindings}
                          disabled={busy}
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfiguring(null)}
                          >
                            {t("cancel")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              !editable ||
                              full ||
                              !binding.ready ||
                              installing !== null
                            }
                            onClick={() => void install(item, binding.selected)}
                          >
                            {busy ? t("installing") : t("installAndAdd")}
                          </Button>
                        </div>
                      </div>
                    ) : null
                  }
                >
                  {item.requirements.length ? (
                    open ? null : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!editable || full || installing !== null}
                        onClick={() => {
                          setBindings({});
                          setConfiguring(item.listingId);
                        }}
                      >
                        {t("configure")}
                      </Button>
                    )
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!editable || full || installing !== null}
                      onClick={() => void install(item, {})}
                    >
                      {busy ? t("installing") : t("installAndAdd")}
                    </Button>
                  )}
                </PickerRow>
              );
            })}
          </PickerSection>
        ) : null}
        {!installed.length && !installable.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {search ? t("noMatches") : t("nothing")}
          </p>
        ) : null}
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted-foreground">
        {agents("piPackageSecurity")} {agents("piPackagesNewSession")}
      </p>
      {!canManage ? (
        <p role="status" className="text-sm">
          {flow("unauthorized")}
        </p>
      ) : runtimeKind !== "pi-sdk" ? (
        <p role="status" className="text-sm">
          {flow("incompatible")}
        </p>
      ) : null}

      {rows.length ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("selectedCount", {
                count: packages.length,
                max: MAX_AGENT_PLUGINS,
              })}
            </span>
            {addButton}
          </div>
          <ul className="divide-y divide-border">
            {rows.map((pkg) => {
              const selection = selectedFor(pkg);
              const pinned = applied.find(
                (entry) => entry.marketInstallId === pkg.marketInstallId,
              );
              const restoreId = pkg.enabledReleaseId ?? pkg.currentReleaseId;
              const state = !selection
                ? "removing"
                : selection.releaseId !== pkg.enabledReleaseId
                  ? "unsaved"
                  : selection.releaseId !== pinned?.releaseId
                    ? "unapplied"
                    : "applied";
              const version = !selection
                ? null
                : selection.releaseId === pkg.currentReleaseId
                  ? pkg.currentVersion
                  : selection.releaseId === pkg.enabledReleaseId
                    ? pkg.enabledVersion
                    : null;
              const capabilities = pkg.capabilities
                ? (["extensions", "tools", "commands", "hooks"] as const)
                    .map((kind) => ({
                      kind,
                      values: pkg.capabilities?.[kind] ?? [],
                    }))
                    .filter((entry) => entry.values.length)
                : [];
              return (
                <li
                  key={pkg.marketInstallId}
                  className={`flex items-start gap-3 px-4 py-3 ${state === "removing" ? "bg-muted/30" : ""}`}
                >
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                    <Puzzle className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className={`truncate text-sm font-medium ${state === "removing" ? "text-muted-foreground line-through" : ""}`}
                      >
                        {pkg.name}
                      </span>
                      {version ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          v{version}
                        </span>
                      ) : null}
                      <AnimatedBadge
                        size="sm"
                        showIcon={false}
                        status={
                          state === "applied"
                            ? "success"
                            : state === "unapplied"
                              ? "warning"
                              : state === "unsaved"
                                ? "info"
                                : "neutral"
                        }
                      >
                        {t(`state.${state}`)}
                      </AnimatedBadge>
                      {selection && !pkg.currentAvailable ? (
                        <AnimatedBadge size="sm" status="danger">
                          {t("state.unavailable")}
                        </AnimatedBadge>
                      ) : null}
                    </div>
                    {pkg.summary ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {pkg.summary}
                      </p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {counts(pkg)}
                    </p>
                    {selection &&
                    pkg.enabledReleaseId &&
                    pkg.syncStatus !== "synced" ? (
                      <AgentPluginSyncReview
                        slug={slug}
                        agentId={agentId}
                        installId={pkg.marketInstallId}
                        syncStatus={pkg.syncStatus}
                        syncError={pkg.syncError}
                        enabledVersion={pkg.enabledVersion}
                        targetVersion={pkg.targetVersion}
                        targetReleaseId={pkg.targetReleaseId}
                        capabilityDiff={pkg.capabilityDiff}
                        canApprove={canManage}
                        disabled={locked}
                      />
                    ) : null}
                    {capabilities.length ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          {agents("pluginCapabilities")}
                        </summary>
                        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                          {capabilities.map(({ kind, values }) => (
                            <div key={kind} className="contents">
                              <dt className="text-muted-foreground">
                                {agents(`pluginCapabilityLabels.${kind}`)}
                              </dt>
                              <dd className="break-all font-mono">
                                {values.join(", ")}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {(pkg.mcpRequirementCount ?? 0) > 0 ? (
                      <ButtonLink
                        href={pluginHref(pkg.listingId, "#plugin-install")}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="ghost"
                        size="icon"
                        aria-label={agents("piPackageMcpBindings")}
                        title={agents("piPackageMcpBindings")}
                      >
                        <Cable className="size-4" />
                      </ButtonLink>
                    ) : null}
                    <ButtonLink
                      href={pluginHref(pkg.listingId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="ghost"
                      size="icon"
                      aria-label={t("view", { name: pkg.name })}
                      title={t("view", { name: pkg.name })}
                    >
                      <ExternalLink className="size-4" />
                    </ButtonLink>
                    {selection ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={!canManage}
                        aria-label={t("remove", { name: pkg.name })}
                        title={t("remove", { name: pkg.name })}
                        onClick={() =>
                          onChange(
                            packages.filter(
                              (entry) =>
                                entry.marketInstallId !== pkg.marketInstallId,
                            ),
                          )
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!editable || full || !restoreId}
                        onClick={() =>
                          restoreId &&
                          onChange([
                            ...packages,
                            {
                              marketInstallId: pkg.marketInstallId,
                              releaseId: restoreId,
                            },
                          ])
                        }
                      >
                        <RotateCcw className="size-3.5" />
                        {t("restore")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Puzzle className="size-5 text-muted-foreground" />
          </span>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
          {addButton}
        </div>
      )}
    </div>
  );
}

function PickerSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {children}
      </ul>
    </section>
  );
}

function PickerRow({
  name,
  version,
  summary,
  counts,
  expanded,
  children,
}: {
  name: string;
  version: string | null;
  summary?: string | null;
  counts: string;
  /** Inline configuration shown under the row. */
  expanded?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            {version ? (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                v{version}
              </span>
            ) : null}
          </div>
          {summary ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {summary}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-muted-foreground">{counts}</p>
        </div>
        {children ? <div className="shrink-0">{children}</div> : null}
      </div>
      {expanded}
    </li>
  );
}
