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
  PluginQuickAdd,
  PluginSourceFilter,
} from "@/components/dashboard/plugins/PluginForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listPlugins, pluginReleaseLabel } from "@/lib/plugins/catalog";
import { releaseContents } from "@/lib/plugins/release-contents";
import { listPluginSources } from "@/lib/plugins/sources";

export const dynamic = "force-dynamic";

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
  const [{ items, updateCount }, sources, membership] = await Promise.all([
    listPlugins(workspace.id, user.id, {
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
          {updateCount > 0 ? (
            <>
              {" · "}
              <Link
                href={`${base}/installed?filter=updates`}
                className="text-primary hover:underline"
              >
                {t("installed.subtitleUpdates", { count: updateCount })}
              </Link>
            </>
          ) : null}
        </p>
      </DashboardToolbar>
      <div className="flex w-full flex-wrap items-center gap-2">
        <form action={base} className="w-full sm:w-72">
          {sourceId ? (
            <input type="hidden" name="source" value={sourceId} />
          ) : null}
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
        {sources.length > 1 ? (
          <PluginSourceFilter
            base={base}
            params={{ q }}
            value={sourceId}
            options={sources.map((source) => ({
              value: source.id,
              label: source.official ? t("officialSource") : source.name,
            }))}
          />
        ) : null}
      </div>
      {items.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((plugin) => {
            const href = `${base}/${encodeURIComponent(plugin.id)}`;
            const contents = plugin.latestRelease
              ? releaseContents(plugin.latestRelease.releaseSummary)
              : { counts: [], mcp: 0, omp: false };
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
                        href={href}
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
                {contents.counts.length || contents.mcp || contents.omp ? (
                  <ul className="flex flex-wrap gap-1.5 text-xs">
                    {contents.omp ? (
                      <li className="rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                        {t("ompRetired")}
                      </li>
                    ) : null}
                    {contents.counts.map(({ kind, count }) => (
                      <li
                        key={kind}
                        className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
                      >
                        {t(kind)} {count}
                      </li>
                    ))}
                    {contents.mcp ? (
                      <li className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
                        MCP {contents.mcp}
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
                      contents.mcp ? (
                        <ButtonLink
                          href={`${href}#install`}
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
                        href={`${href}#install`}
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
          title={t("allEmpty")}
          actions={
            canManage ? (
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
