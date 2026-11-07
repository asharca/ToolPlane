import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  ArrowUpCircle,
  CircleCheck,
  CircleSlash,
  GitBranch,
  Puzzle,
  Search,
} from "lucide-react";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  PluginListFilter,
  PluginQuickAdd,
} from "@/components/dashboard/plugins/PluginForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listPluginCards, pluginReleaseLabel } from "@/lib/plugins/catalog";
import { listPluginSources } from "@/lib/plugins/sources";

export const dynamic = "force-dynamic";

const origins = ["official", "private"] as const;
const capabilities = ["skills", "extensions", "mcp"] as const;
const availabilities = ["available", "unavailable"] as const;

export default async function PluginsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.plugins"),
  ]);
  const base = `/app/${encodeURIComponent(slug)}/plugins`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(base)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const value = (key: string) =>
    (Array.isArray(query[key]) ? query[key][0] : query[key]) ?? "";
  const q = value("q").trim().slice(0, 200);
  const sourceId = value("source").slice(0, 240);
  // Agent settings open the catalog with a target Agent and a tab channel to report back to.
  const returnAgent = value("returnAgent").slice(0, 240);
  const pluginChannel = /^[a-f0-9-]{36}$/.test(value("pluginChannel"))
    ? value("pluginChannel")
    : "";
  const context = new URLSearchParams({
    ...(returnAgent ? { returnAgent } : {}),
    ...(pluginChannel ? { pluginChannel } : {}),
  }).toString();
  const origin = origins.find((item) => item === value("origin")) ?? "";
  const capability =
    capabilities.find((item) => item === value("capability")) ?? "";
  const availability =
    availabilities.find((item) => item === value("availability")) ?? "";
  const filterParams = {
    q,
    source: sourceId,
    origin,
    capability,
    availability,
    returnAgent,
    pluginChannel,
  };
  const hasFilters = Boolean(
    q || sourceId || origin || capability || availability,
  );
  const [catalog, sources, membership] = await Promise.all([
    listPluginCards(workspace.id, user.id, {
      query: q,
      sourceId: sourceId || undefined,
    }),
    listPluginSources(workspace.id, user.id),
    db.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { role: true },
    }),
  ]);
  const canManage =
    workspace.ownerId === user.id ||
    membership?.role === "admin" ||
    membership?.role === "owner";
  const items = catalog.items.filter((plugin) => {
    const official = Boolean(plugin.githubRegistryResource?.registry.official);
    if (origin && official !== (origin === "official")) return false;
    if (capability === "mcp" && !plugin.card.mcpCount) return false;
    if (
      capability &&
      capability !== "mcp" &&
      !plugin.card.resources.some((resource) => resource.kind === capability)
    )
      return false;
    return (
      !availability || plugin.card.available === (availability === "available")
    );
  });
  const filters = [
    ...(sources.length > 1 || sourceId
      ? [
          {
            name: "source",
            label: t("source"),
            value: sourceId,
            options: [
              { value: "", label: t("allSources") },
              ...(sourceId && !sources.some((source) => source.id === sourceId)
                ? [{ value: sourceId, label: t("unavailableSource") }]
                : []),
              ...sources.map((source) => ({
                value: source.id,
                label: source.official ? t("officialSource") : source.name,
              })),
            ],
          },
        ]
      : []),
    {
      name: "origin",
      label: t("catalog.origin"),
      value: origin,
      options: [
        { value: "", label: t("catalog.allOrigins") },
        ...origins.map((item) => ({
          value: item,
          label: t(`catalog.${item}`),
        })),
      ],
    },
    {
      name: "capability",
      label: t("catalog.capability"),
      value: capability,
      options: [
        { value: "", label: t("catalog.allCapabilities") },
        ...capabilities.map((item) => ({
          value: item,
          label: t(`catalog.${item}`),
        })),
      ],
    },
    {
      name: "availability",
      label: t("catalog.availability"),
      value: availability,
      options: [
        { value: "", label: t("catalog.allAvailability") },
        ...availabilities.map((item) => ({
          value: item,
          label: t(`catalog.${item}`),
        })),
      ],
    },
  ];
  return (
    <DashboardPage>
      <DashboardToolbar
        actions={
          <ButtonLink href={`${base}/sources`} variant="secondary" size="md">
            <GitBranch className="size-4" />
            {t("sources")}
          </ButtonLink>
        }
      >
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("availableCount", { count: items.length })}
          {catalog.updateCount > 0 ? (
            <>
              {" · "}
              <Link
                href={`${base}/installed?filter=updates`}
                className="text-primary hover:underline"
              >
                {t("installed.subtitleUpdates", {
                  count: catalog.updateCount,
                })}
              </Link>
            </>
          ) : null}
        </p>
      </DashboardToolbar>
      <div className="flex w-full flex-wrap items-center gap-2">
        <form key={q} action={base} method="get" className="w-full sm:w-72">
          {Object.entries(filterParams).map(([name, item]) =>
            name !== "q" && item ? (
              <input key={name} type="hidden" name={name} value={item} />
            ) : null,
          )}
          <Input
            name="q"
            type="search"
            defaultValue={q}
            maxLength={200}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            leftIcon={<Search />}
            className="w-full"
          />
        </form>
        {filters.map((filter) => (
          <PluginListFilter
            key={filter.name}
            base={base}
            params={filterParams}
            name={filter.name}
            label={filter.label}
            value={filter.value}
            options={filter.options}
          />
        ))}
      </div>
      {items.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((plugin) => {
            const href = `${base}/${encodeURIComponent(plugin.id)}`;
            const published = plugin.status === "published";
            return (
              <article
                key={plugin.id}
                className="relative flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-colors focus-within:border-primary/40 hover:border-primary/40"
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Puzzle className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">
                      <Link
                        href={context ? `${href}?${context}` : href}
                        className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
                      >
                        {plugin.name}
                      </Link>
                    </h2>
                    <p className="truncate text-xs text-muted-foreground">
                      {plugin.githubRegistryResource?.registry.official
                        ? t("official")
                        : (plugin.githubRegistryResource?.registry.repository ??
                          t("privatePlugin"))}
                    </p>
                  </div>
                  {!published ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      <CircleSlash className="size-3" />
                      {t(
                        plugin.status === "withdrawn" ? "withdrawn" : "removed",
                      )}
                    </span>
                  ) : plugin.updateAvailable ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      <ArrowUpCircle className="size-3" />
                      {t("updateAvailable")}
                    </span>
                  ) : plugin.install ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      <CircleCheck className="size-3" />
                      {t("added")}
                    </span>
                  ) : null}
                </div>
                {plugin.summary?.trim() ? (
                  <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {plugin.summary}
                  </p>
                ) : (
                  <p className="text-sm leading-6 text-muted-foreground/60 italic">
                    {t("noSummary")}
                  </p>
                )}
                {!plugin.card.available ? (
                  <p className="text-xs text-destructive">
                    {t(
                      plugin.card.revoked
                        ? "catalog.revoked"
                        : "catalog.unavailable",
                    )}
                  </p>
                ) : null}
                {plugin.card.resources.length ||
                plugin.card.mcpCount ||
                plugin.card.runtime?.kind === "omp" ? (
                  <ul className="flex flex-wrap gap-1.5 text-xs">
                    {plugin.card.runtime?.kind === "omp" ? (
                      <li className="rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                        {t("ompRetired")}
                      </li>
                    ) : null}
                    {plugin.card.resources.map(({ kind, count }) => (
                      <li
                        key={kind}
                        className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
                      >
                        {t(kind)} {count}
                      </li>
                    ))}
                    {plugin.card.mcpCount ? (
                      <li className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
                        MCP {plugin.card.mcpCount}
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                <div className="mt-auto flex min-h-8 items-center justify-between gap-3 pt-1">
                  <span className="font-mono text-xs text-muted-foreground">
                    {plugin.install?.currentRelease
                      ? `v${pluginReleaseLabel(plugin.install.currentRelease)}${
                          plugin.updateAvailable && plugin.latestRelease
                            ? ` → v${pluginReleaseLabel(plugin.latestRelease)}`
                            : ""
                        }`
                      : plugin.latestRelease
                        ? `v${pluginReleaseLabel(plugin.latestRelease)}`
                        : ""}
                  </span>
                  {canManage && published && plugin.latestRelease ? (
                    !plugin.install ? (
                      plugin.card.mcpCount ? (
                        <ButtonLink
                          href={`${href}${context ? `?${context}` : ""}#plugin-install`}
                          variant="secondary"
                          size="sm"
                          className="relative z-10"
                        >
                          {t("quickAdd")}
                        </ButtonLink>
                      ) : (
                        <PluginQuickAdd
                          workspace={slug}
                          listingId={plugin.id}
                          name={plugin.name}
                        />
                      )
                    ) : plugin.updateAvailable ? (
                      <ButtonLink
                        href={`${href}${context ? `?${context}` : ""}#plugin-install`}
                        variant="secondary"
                        size="sm"
                        className="relative z-10"
                      >
                        {t("update")}
                      </ButtonLink>
                    ) : null
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <DashboardEmptyState
          icon={Puzzle}
          title={t(hasFilters ? "discoverFilteredEmpty" : "discoverEmpty")}
          actions={
            hasFilters ? (
              <ButtonLink
                href={context ? `${base}?${context}` : base}
                variant="secondary"
                size="sm"
              >
                {t("clearFilters")}
              </ButtonLink>
            ) : canManage ? (
              <ButtonLink
                href={`${base}/sources`}
                variant="secondary"
                size="sm"
              >
                <GitBranch className="size-4" />
                {t("sources")}
              </ButtonLink>
            ) : null
          }
        />
      )}
    </DashboardPage>
  );
}
