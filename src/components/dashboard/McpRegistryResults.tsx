"use client";

import { ArrowRight, GitBranch, Loader2, Mail, Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import type {
  ConnectorPreset,
  ConnectorPresetId,
} from "@/lib/connectors/presets";
import type { McpRegistryItem } from "@/lib/workspace/mcp-intake-types";

function presetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function PresetIcon({ id }: { id: ConnectorPresetId }) {
  if (id === "github") {
    return <GitBranch className="size-4" aria-hidden="true" />;
  }
  if (id === "gmail") {
    return <Mail className="size-4" aria-hidden="true" />;
  }
  return <Plug className="size-4" aria-hidden="true" />;
}

export function McpRegistryResults({
  presets,
  onSelectPreset,
  featured,
  onSelectFeatured,
  isSearching,
  registryItems,
  registryLoading,
  registryLoadingMore,
  registryNextCursor,
  registryError,
  onSelectRegistryItem,
  onLoadMore,
  busy,
}: {
  presets: readonly ConnectorPreset[];
  onSelectPreset: (preset: ConnectorPreset) => void;
  featured: readonly { name: string; url: string }[];
  onSelectFeatured: (url: string) => void;
  isSearching: boolean;
  registryItems: McpRegistryItem[];
  registryLoading: boolean;
  registryLoadingMore: boolean;
  registryNextCursor: string | null;
  registryError: "notAuthorized" | "registryUnavailable" | null;
  onSelectRegistryItem: (item: McpRegistryItem) => void;
  onLoadMore: () => void;
  busy: boolean;
}) {
  const t = useTranslations("console.mcp");
  const common = useTranslations("common");

  const kindLabel = (kind: McpRegistryItem["kinds"][number]) => {
    switch (kind) {
      case "remote":
        return t("intake.kindRemote");
      case "npm":
        return t("intake.kindNpm");
      case "pypi":
        return t("intake.kindPypi");
      case "oci":
        return t("intake.kindDocker");
    }
  };

  const cards = [
    ...presets.map((preset) => ({
      key: preset.id,
      name: preset.name,
      url: preset.remote.url,
      icon: <PresetIcon id={preset.id} />,
      onSelect: () => onSelectPreset(preset),
    })),
    ...featured.map((item) => ({
      key: item.url,
      name: item.name,
      url: item.url,
      icon: <Plug className="size-4" aria-hidden="true" />,
      onSelect: () => onSelectFeatured(item.url),
    })),
  ];

  return (
    <div className="space-y-3">
      {cards.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <button
              key={card.key}
              type="button"
              disabled={busy}
              onClick={card.onSelect}
              className="group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                {card.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {card.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {presetHost(card.url)}
                </span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      ) : null}

      {isSearching ? (
        <div className="space-y-2">
          {registryLoading ? (
            <div
              role="status"
              className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              <span>{t("intake.searching")}</span>
            </div>
          ) : null}

          {registryError ? (
            <p role="alert" className="text-sm text-destructive">
              {t(`intake.errors.${registryError}`)}
            </p>
          ) : null}

          {!registryLoading &&
          !registryError &&
          registryItems.length === 0 &&
          presets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {common("noResults")}
            </p>
          ) : null}

          {registryItems.length > 0 ? (
            <div className="grid gap-1.5 lg:grid-cols-2">
              {registryItems.map((item) => (
                <button
                  key={`${item.name}@${item.version}`}
                  type="button"
                  disabled={!item.supported || busy}
                  onClick={() => onSelectRegistryItem(item)}
                  className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-border disabled:hover:bg-card"
                >
                  <div className="flex w-full min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {item.title || item.name}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-1">
                      {item.kinds.map((kind) => (
                        <AnimatedBadge
                          key={kind}
                          status="neutral"
                          size="sm"
                          showIcon={false}
                        >
                          {kindLabel(kind)}
                        </AnimatedBadge>
                      ))}
                      {!item.supported ? (
                        <AnimatedBadge
                          status="warning"
                          size="sm"
                          showIcon={false}
                        >
                          {t("intake.unsupported")}
                        </AnimatedBadge>
                      ) : null}
                    </span>
                  </div>
                  <span className="block w-full truncate font-mono text-[11px] text-muted-foreground">
                    {item.name}
                  </span>
                  {item.description ? (
                    <span className="block w-full truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {registryNextCursor ? (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={registryLoadingMore || busy}
                onClick={onLoadMore}
              >
                {registryLoadingMore ? (
                  <>
                    <Loader2
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    {t("intake.loadingMore")}
                  </>
                ) : (
                  t("intake.loadMore")
                )}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
