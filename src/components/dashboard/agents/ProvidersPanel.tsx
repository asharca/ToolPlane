"use client";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardEmptyState } from "@/components/dashboard/DashboardUI";
import { Input } from "@/components/motion/input";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Cpu, RefreshCw, Search } from "lucide-react";
import type { ActionState } from "@/lib/agents/actions";
import type { ProviderModelValues } from "@/lib/agents/model-catalog";
import { apiRequest } from "@/lib/client/api";
import {
  AddProviderDialog,
  providerEndpoint,
  type ProviderPreset,
} from "./ProviderDialogs";
import {
  endpointHost,
  ProviderDetail,
  ProviderMonogram,
} from "./ProviderDetail";

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
  models: string[];
  modelRecords?: Array<
    Omit<
      ProviderModelRow,
      "primaryType" | "capabilities" | "inputModalities"
    > & {
      primaryType: string;
      capabilities: string[];
      inputModalities: string[];
    }
  >;
  modelsFetchedAt: string | null;
};

export type ProviderModelRow = ProviderModelValues & { source: string };

export function ProvidersPanel({
  slug,
  providers,
  piProviderPresets = [],
}: {
  slug: string;
  providers: ProviderRow[];
  piProviderPresets?: ProviderPreset[];
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const router = useRouter();
  const [providerQuery, setProviderQuery] = useState("");
  const searchParams = useSearchParams();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => searchParams.get("provider") ?? providers[0]?.id ?? null,
  );
  const [refreshes, setRefreshes] = useState<
    Record<string, { pending: boolean; state: ActionState }>
  >({});

  async function refreshProvider(providerId: string) {
    setRefreshes((current) => ({
      ...current,
      [providerId]: { pending: true, state: {} },
    }));
    const result = await apiRequest<ActionState>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/${encodeURIComponent(providerId)}/models`,
      { method: "POST" },
    );
    const state: ActionState = result.ok
      ? (result.data ?? {})
      : { error: result.message ?? t("modelsFetchRequestFailed") };
    if (state.savedAt) router.refresh();
    setRefreshes((current) => ({
      ...current,
      [providerId]: { pending: false, state },
    }));
  }

  // Keep the selection in the URL so reloads and shared links reopen it.
  function selectProvider(providerId: string) {
    setSelectedProviderId(providerId);
    const url = new URL(window.location.href);
    url.searchParams.set("provider", providerId);
    window.history.replaceState(null, "", url);
  }

  function handleCreated(providerId: string) {
    selectProvider(providerId);
    setProviderQuery("");
    void refreshProvider(providerId);
  }
  const visibleProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      [provider.name, provider.format, ...provider.models].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [providerQuery, providers]);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0] ??
    null;
  return (
    <>
      <DashboardHeader title={t("modelProviders")} />
      {selectedProvider ? (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--workspace-surface,var(--background))] md:flex-row">
          <aside
            aria-label={t("modelProviders")}
            className="flex max-h-60 shrink-0 flex-col border-b border-border/50 bg-muted/25 md:max-h-none md:w-64 md:border-b-0 md:border-r"
          >
            <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2.5">
              <Input
                leftIcon={<Search />}
                aria-label={`${common("search")} ${t("modelProviders")}`}
                placeholder={common("search")}
                value={providerQuery}
                onChange={setProviderQuery}
                className="min-w-0 flex-1"
              />
              <AddProviderDialog
                slug={slug}
                piProviderPresets={piProviderPresets}
                onCreated={handleCreated}
                iconTrigger
              />
            </div>
            <nav
              aria-label={t("modelProviders")}
              className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
            >
              {visibleProviders.length > 0 ? (
                visibleProviders.map((provider) => {
                  const selected = provider.id === selectedProvider.id;
                  const refresh = refreshes[provider.id];
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-label={provider.name}
                      aria-pressed={selected}
                      aria-busy={refresh?.pending || undefined}
                      onClick={() => selectProvider(provider.id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${selected ? "bg-foreground/[0.08]" : "hover:bg-foreground/5"}`}
                    >
                      <ProviderMonogram name={provider.name} />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-sm text-foreground ${selected ? "font-medium" : ""}`}
                        >
                          {provider.name}
                        </span>
                        <span
                          className={`block truncate text-[11px] ${refresh?.state.error ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {refresh?.pending
                            ? t("modelsFetching")
                            : refresh?.state.error
                              ? t("modelsFetchFailedLabel")
                              : endpointHost(
                                  providerEndpoint(
                                    provider,
                                    piProviderPresets,
                                    provider.format,
                                  ),
                                )}
                        </span>
                      </span>
                      {refresh?.pending ? (
                        <RefreshCw
                          aria-hidden="true"
                          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                        />
                      ) : (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {provider.modelCount}
                        </span>
                      )}
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {common("noResults")}
                </p>
              )}
            </nav>
          </aside>

          <ProviderDetail
            key={selectedProvider.id}
            slug={slug}
            provider={selectedProvider}
            piProviderPresets={piProviderPresets}
            refreshState={refreshes[selectedProvider.id]?.state ?? {}}
            refreshing={refreshes[selectedProvider.id]?.pending ?? false}
            onRefresh={() => {
              void refreshProvider(selectedProvider.id);
            }}
          />
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
          <DashboardEmptyState
            icon={Cpu}
            title={t("noProvidersYet")}
            actions={
              <AddProviderDialog
                slug={slug}
                piProviderPresets={piProviderPresets}
                onCreated={handleCreated}
              />
            }
          />
        </div>
      )}
    </>
  );
}
