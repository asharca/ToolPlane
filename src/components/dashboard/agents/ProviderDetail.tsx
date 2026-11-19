"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Boxes,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { DashboardEmptyState } from "@/components/dashboard/DashboardUI";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Tooltip } from "@/components/motion/tooltip";
import { deleteProviderAction, type ActionState } from "@/lib/agents/actions";
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_PRIMARY_TYPES,
  defaultProviderModel,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
} from "@/lib/agents/model-catalog";
import {
  EditProviderDialog,
  providerEndpoint,
  providerFormatLabel,
  type ProviderPreset,
} from "./ProviderDialogs";
import { AddModelDialog, ModelTypeIcon } from "./ProviderModelForm";
import { MODEL_ROW_GRID, ModelTestRow } from "./ProviderModelRows";
import type { ProviderModelRow, ProviderRow } from "./ProvidersPanel";

const MODEL_TYPE_ORDER: ModelPrimaryType[] = [
  "text",
  "image",
  "embedding",
  "rerank",
];

export function endpointHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function ProviderMonogram({
  name,
  large = false,
}: {
  name: string;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-semibold text-muted-foreground ${large ? "size-10 text-sm" : "size-8 text-xs"}`}
    >
      {name.trim().charAt(0).toUpperCase() || "P"}
    </span>
  );
}

export function ProviderDetail({
  slug,
  provider,
  piProviderPresets,
  refreshState,
  refreshing,
  onRefresh,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
  refreshState: ActionState;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("console.agents");
  const locale = useLocale();
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const prices = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 8,
      }),
    [locale],
  );
  const common = useTranslations("common");
  const [modelQuery, setModelQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | ModelPrimaryType>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const endpoint = providerEndpoint(
    provider,
    piProviderPresets,
    t("builtInConnection"),
  );
  const modelRecords = useMemo<ProviderModelRow[]>(() => {
    return provider.models.map((modelId) => {
      const defaults = defaultProviderModel(modelId);
      const stored = provider.modelRecords?.find(
        (record) => record.modelId === modelId,
      );
      if (!stored) return { ...defaults, source: "remote" };
      return {
        ...stored,
        primaryType: MODEL_PRIMARY_TYPES.includes(
          stored.primaryType as ModelPrimaryType,
        )
          ? (stored.primaryType as ModelPrimaryType)
          : defaults.primaryType,
        capabilities: stored.capabilities.filter(
          (value): value is ModelCapability =>
            MODEL_CAPABILITIES.includes(value as ModelCapability),
        ),
        inputModalities: stored.inputModalities.filter(
          (value): value is ModelInputModality =>
            MODEL_INPUT_MODALITIES.includes(value as ModelInputModality),
        ),
      };
    });
  }, [provider.modelRecords, provider.models]);
  const searchedModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return query
      ? modelRecords.filter((model) =>
          [
            model.modelId,
            model.name,
            model.group,
            ...model.capabilities,
            ...model.inputModalities,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
        )
      : modelRecords;
  }, [modelQuery, modelRecords]);
  // Offer a type tab only for types this provider actually has, so a
  // text-only provider is not shown three permanently empty filters.
  const filterTypes = useMemo(
    () =>
      MODEL_TYPE_ORDER.filter(
        (type) =>
          type === typeFilter ||
          modelRecords.some((model) => model.primaryType === type),
      ),
    [modelRecords, typeFilter],
  );
  const visibleModels = useMemo(
    () =>
      typeFilter === "all"
        ? searchedModels
        : searchedModels.filter((model) => model.primaryType === typeFilter),
    [searchedModels, typeFilter],
  );
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ProviderModelRow[]>();
    for (const model of visibleModels) {
      const group = model.group.trim();
      groups.set(group, [...(groups.get(group) ?? []), model]);
    }
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [visibleModels]);
  const showGroupHeaders = modelGroups.some(([group]) => group !== "");
  const allGroupsExpanded = modelGroups.every(
    ([group]) => !collapsedGroups.has(group),
  );
  const searching = Boolean(modelQuery.trim());
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  };
  const hasPrices = visibleModels.some((model) => model.cost);
  const refreshMessage = refreshing
    ? t("modelsFetching")
    : refreshState.savedAt
      ? t("modelsFetchComplete")
      : null;

  return (
    <section
      aria-label={provider.name}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-2">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <ProviderMonogram name={provider.name} large />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {provider.name}
              </h2>
              <span className="shrink-0 rounded-lg bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {providerFormatLabel(provider.format, piProviderPresets)}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {endpoint}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refreshing}
            aria-busy={refreshing || undefined}
            onClick={onRefresh}
            className="mr-1"
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("refreshModels")}
          </Button>
          <EditProviderDialog
            slug={slug}
            provider={provider}
            piProviderPresets={piProviderPresets}
          />
          <form action={deleteProviderAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={provider.id} />
            <ConfirmSubmitButton
              triggerLabel={<Trash2 className="size-4" />}
              triggerAriaLabel={common("remove")}
              confirmLabel={common("confirm")}
              cancelLabel={common("cancel")}
              prompt={t("removeProviderPrompt", { name: provider.name })}
              pendingLabel={t("removingProvider")}
              className="items-center justify-end"
              triggerVariant="ghost"
              triggerSize="icon"
              triggerTooltip={false}
              promptClassName="max-w-sm text-xs text-muted-foreground"
            />
          </form>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-border px-4 py-2.5">
        {filterTypes.length > 1 ? (
          <Tabs
            variant="segment"
            value={typeFilter}
            onValueChange={(value) =>
              setTypeFilter(value as "all" | ModelPrimaryType)
            }
            className="min-w-0"
          >
            <TabsList aria-label={t("filterModels")} className="bg-muted/50">
              <TabsTrigger value="all" className="gap-1.5 px-2.5 py-1 text-xs">
                {t("allModels")}
                <span className="tabular-nums opacity-60">
                  {searchedModels.length}
                </span>
              </TabsTrigger>
              {filterTypes.map((type) => (
                <TabsTrigger
                  key={type}
                  value={type}
                  className="gap-1.5 px-2.5 py-1 text-xs"
                >
                  <ModelTypeIcon type={type} />
                  {typeLabels[type]}
                  <span className="tabular-nums opacity-60">
                    {
                      searchedModels.filter(
                        (model) => model.primaryType === type,
                      ).length
                    }
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <h3 className="px-1 text-sm font-medium text-foreground">
            {t("model")}
            <span className="ml-2 tabular-nums text-muted-foreground">
              {searchedModels.length}
            </span>
          </h3>
        )}
        <div className="ml-auto flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {showGroupHeaders && modelGroups.length > 1 && !searching ? (
            <Tooltip
              content={
                allGroupsExpanded
                  ? t("collapseAllGroups")
                  : t("expandAllGroups")
              }
            >
              <Button
                type="button"
                onClick={() =>
                  setCollapsedGroups(
                    allGroupsExpanded
                      ? new Set(modelGroups.map(([group]) => group))
                      : new Set(),
                  )
                }
                aria-label={
                  allGroupsExpanded
                    ? t("collapseAllGroups")
                    : t("expandAllGroups")
                }
                variant="ghost"
                size="icon"
              >
                {allGroupsExpanded ? (
                  <ChevronsDownUp className="size-4" />
                ) : (
                  <ChevronsUpDown className="size-4" />
                )}
              </Button>
            </Tooltip>
          ) : null}
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Input
              leftIcon={<Search />}
              aria-label={t("searchModels")}
              placeholder={t("searchModels")}
              value={modelQuery}
              onChange={setModelQuery}
              className="w-full"
            />
          </div>
          <AddModelDialog slug={slug} providerId={provider.id} />
        </div>
      </div>

      {refreshMessage || refreshState.error ? (
        <div className="shrink-0 border-b border-border px-5 py-2">
          {refreshMessage ? (
            <p role="status" className="text-xs text-muted-foreground">
              {refreshMessage}
            </p>
          ) : null}
          {refreshState.error ? (
            <p role="alert" className="text-xs text-destructive">
              {`${t("modelsFetchFailedSaved")} ${refreshState.error}`}
            </p>
          ) : refreshState.warning ? (
            <p role="alert" className="text-xs text-muted-foreground">
              {refreshState.warning}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {modelGroups.length > 0 ? (
          <>
            <div
              aria-hidden="true"
              className={`${MODEL_ROW_GRID} sticky top-0 z-10 hidden border-b border-border bg-card px-4 py-2 text-[11px] font-medium text-muted-foreground xl:grid`}
            >
              <span>{t("model")}</span>
              <span className="text-right">{t("modelColumnContext")}</span>
              <span className="text-right">{t("modelColumnMaxOutput")}</span>
              <span className="text-right">{t("catalogInputPrice")}</span>
              <span className="text-right">{t("catalogOutputPrice")}</span>
              <span />
            </div>
            {modelGroups.map(([group, models]) => {
              const expanded = searching || !collapsedGroups.has(group);
              return (
                <section
                  key={group || "__ungrouped"}
                  aria-label={group || t("ungroupedModels")}
                >
                  {showGroupHeaders ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() =>
                        setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {group || t("ungroupedModels")}
                      </span>
                      <span className="tabular-nums">{models.length}</span>
                    </button>
                  ) : null}
                  {expanded ? (
                    <div className="divide-y divide-border/60 border-b border-border/60">
                      {models.map((model) => (
                        <ModelTestRow
                          key={model.modelId}
                          slug={slug}
                          providerId={provider.id}
                          model={model}
                          numbers={numbers}
                          prices={prices}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
              {[
                t("providerModelCount", { count: provider.models.length }),
                provider.modelsFetchedAt &&
                  t("lastRefreshedAt", { date: provider.modelsFetchedAt }),
                hasPrices && t("catalogPriceUnit"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        ) : (
          <DashboardEmptyState
            icon={Boxes}
            title={
              provider.models.length > 0
                ? t("noMatchingModels")
                : t("noModelsCachedYet")
            }
          />
        )}
      </div>
    </section>
  );
}
