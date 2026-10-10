import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import {
  PiCatalogImportForm,
  PiRegistryPublishForm,
  PiSourceEditor,
} from "@/components/dashboard/market/PiCatalogForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import {
  listPiPackageSources,
  listPiPackageSourceEntries,
} from "@/lib/market/pi-package-catalog";

export const dynamic = "force-dynamic";

export default async function PiPackageSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ source?: string; q?: string; page?: string }>;
}) {
  const [{ workspace: slug }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.market.piCatalog"),
  ]);
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/toolkits/pi-packages/sources`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const context = { workspaceId: workspace.id, userId: user.id };
  const [sources, categories, membership, releases] = await Promise.all([
    listPiPackageSources(context),
    db.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    workspace.ownerId === user.id
      ? null
      : db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          select: { role: true },
        }),
    db.marketRelease.findMany({
      where: {
        reviewStatus: "approved",
        listing: {
          publisherWorkspaceId: workspace.id,
          kind: "pi-package",
          status: "published",
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, version: true, listing: { select: { name: true } } },
    }),
  ]);
  const canManage =
    workspace.ownerId === user.id || membership?.role === "admin";
  const selected = sources.find((source) => source.id === query.source);
  const search =
    typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const pageNumber = Number(query.page);
  const page =
    Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const entries = selected
    ? await listPiPackageSourceEntries({
        ...context,
        sourceId: selected.id,
        query: search,
        page,
      }).catch(() => null)
    : null;
  const base = `/app/${encodeURIComponent(slug)}/toolkits/pi-packages/sources`;
  return (
    <DashboardPage className="space-y-6">
      <h2 className="text-2xl font-semibold">{t("sourcesTitle")}</h2>
      <nav className="flex flex-wrap gap-2" aria-label={t("navigation")}>
        <ButtonLink
          variant="ghost"
          size="sm"
          href={`/app/${encodeURIComponent(slug)}/toolkits/pi-packages`}
        >
          {t("workspacePackages")}
        </ButtonLink>
        <ButtonLink
          variant="ghost"
          size="sm"
          href={`/app/${encodeURIComponent(slug)}/market/pi-packages`}
        >
          {t("officialTitle")}
        </ButtonLink>
      </nav>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        {t("sourcesHelp")}
      </p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4">
          <h3 className="font-semibold">{t("configuredSources")}</h3>
          {!sources.length ? (
            <p className="text-sm text-muted-foreground">{t("noSources")}</p>
          ) : (
            <nav className="flex flex-col items-start gap-2">
              {sources.map((source) => (
                <ButtonLink
                  key={source.id}
                  variant={source.id === selected?.id ? "primary" : "ghost"}
                  size="sm"
                  href={`${base}?${new URLSearchParams({ source: source.id })}`}
                  aria-current={source.id === selected?.id ? "page" : undefined}
                >
                  {source.name}
                </ButtonLink>
              ))}
            </nav>
          )}
          {canManage ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                {t("addSource")}
              </summary>
              <div className="mt-3">
                <PiSourceEditor workspace={slug} />
              </div>
            </details>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("managerRequired")}
            </p>
          )}
        </aside>
        <section className="min-w-0 space-y-5">
          {query.source && !selected ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.source_not_found")}
            </p>
          ) : null}
          {selected ? (
            <>
              <h3 className="font-semibold">{selected.name}</h3>
              <p className="break-all text-xs text-muted-foreground">
                {t(`kind.${selected.kind}`)} · {selected.url} ·{" "}
                {t(
                  selected.hasCredentials
                    ? "credentialsConfigured"
                    : "noCredentials",
                )}
              </p>
              {canManage ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("editSource")}
                  </summary>
                  <div className="mt-3">
                    <PiSourceEditor
                      key={selected.id}
                      workspace={slug}
                      source={selected}
                    />
                  </div>
                </details>
              ) : null}
              <form className="flex flex-wrap gap-2">
                <input type="hidden" name="source" value={selected.id} />
                <Input
                  name="q"
                  label={t("search")}
                  defaultValue={search}
                  maxLength={200}
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="secondary" size="sm">
                  {t("search")}
                </Button>
              </form>
              {!entries ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("discoveryFailed")}
                </p>
              ) : !entries.entries.length ? (
                <p className="text-sm text-muted-foreground">
                  {t("emptyHelp")}
                </p>
              ) : (
                entries.entries.map((entry) => (
                  <article
                    key={entry.source}
                    className="min-w-0 space-y-3 rounded-3xl border border-border bg-card p-4"
                  >
                    <h4 className="break-words font-semibold">{entry.name}</h4>
                    <p className="break-words text-sm text-muted-foreground">
                      {entry.description}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {entry.source}
                      {entry.version ? ` · ${entry.version}` : ""}
                    </p>
                    <PiCatalogImportForm
                      workspace={slug}
                      sourceId={selected.id}
                      entry={entry}
                      categories={categories}
                      canManage={canManage}
                    />
                  </article>
                ))
              )}
              <nav
                aria-label={t("pagination")}
                className="flex justify-between gap-3"
              >
                {page > 1 ? (
                  <ButtonLink
                    variant="ghost"
                    size="sm"
                    href={`${base}?${new URLSearchParams({ source: selected.id, q: search, page: String(page - 1) })}`}
                  >
                    {t("previous")}
                  </ButtonLink>
                ) : (
                  <span />
                )}
                {entries?.hasMore ? (
                  <ButtonLink
                    variant="ghost"
                    size="sm"
                    href={`${base}?${new URLSearchParams({ source: selected.id, q: search, page: String(page + 1) })}`}
                  >
                    {t("next")}
                  </ButtonLink>
                ) : null}
              </nav>
              <PiCatalogImportForm
                workspace={slug}
                sourceId={selected.id}
                entry={{
                  name: "",
                  source: selected.kind === "git" ? selected.url : "npm:",
                  description: "",
                }}
                categories={categories}
                canManage={canManage}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("chooseSource")}</p>
          )}
        </section>
      </div>
      <section
        id="registry-publish"
        className="space-y-3 border-t border-border pt-6"
      >
        <h3 className="font-semibold">{t("publishRegistry")}</h3>
        {canManage ? (
          <PiRegistryPublishForm
            workspace={slug}
            sources={sources.filter((source) => source.kind === "npm")}
            releases={releases.map((release) => ({
              id: release.id,
              label: `${release.listing.name} · #${release.version}`,
            }))}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("managerRequired")}
          </p>
        )}
      </section>
    </DashboardPage>
  );
}
