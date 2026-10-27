"use client";
import { ButtonLink } from "@/components/motion/button";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { GitBranch, List, PackageCheck, Store } from "lucide-react";

const LIFECYCLE_TABS = [
  { key: "discover", labelKey: "discover", icon: Store },
  { key: "installed", labelKey: "installedResources", icon: PackageCheck },
  { key: "updates", labelKey: "updates", icon: PackageCheck },
  { key: "sources", labelKey: "githubRegistry.title", icon: GitBranch },
  { key: "publish", labelKey: "ownedPublications", icon: List },
] as const;

export function MarketTabs({
  slug,
  updateCount = 0,
}: {
  slug: string;
  updateCount?: number;
}) {
  const pathname = usePathname() ?? "";
  const t = useTranslations("console.market");
  const searchParams = useSearchParams();
  const base = `/app/${encodeURIComponent(slug)}/market`;
  const workspaceResources = pathname.startsWith(`${base}/installed`);
  const sources = pathname === `${base}/sources`;
  const publications = pathname.startsWith(`${base}/publish`);

  return (
    <div className="min-w-0 max-w-full">
      <nav
        aria-label={t("navigation")}
        className="flex min-w-0 max-w-full gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ overflowX: "auto", overflowY: "hidden" }}
      >
        {LIFECYCLE_TABS.map((tab) => {
          const href =
            tab.key === "discover"
              ? base
              : tab.key === "updates"
                ? `${base}/installed?updates=1`
                : `${base}/${tab.key}`;
          const active =
            tab.key === "discover"
              ? (pathname === base || pathname.startsWith(`${base}/`)) &&
                !workspaceResources &&
                !publications &&
                !sources
              : tab.key === "updates"
                ? pathname === `${base}/installed` &&
                  searchParams.get("updates") === "1"
                : tab.key === "installed"
                  ? workspaceResources && searchParams.get("updates") !== "1"
                  : tab.key === "sources"
                    ? sources
                    : publications;
          const Icon = tab.icon;
          return (
            <ButtonLink
              key={tab.key}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={
                tab.key === "updates" && updateCount > 0
                  ? `${t(tab.labelKey)} ${updateCount}`
                  : undefined
              }
              variant={active ? "secondary" : "ghost"}
              className="shrink-0 justify-start border-0"
            >
              <Icon className="size-4 shrink-0" />
              <span>{t(tab.labelKey)}</span>
              {tab.key === "updates" && updateCount > 0 ? (
                <span className="rounded-full bg-(--color-warning) px-1.5 text-xs">
                  {updateCount}
                </span>
              ) : null}
            </ButtonLink>
          );
        })}
      </nav>
    </div>
  );
}
