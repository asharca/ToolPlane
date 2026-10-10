import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  ArrowRight,
  PackageCheck,
  Puzzle,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  listMarketListingCategories,
  listMarketListings,
} from "@/lib/market/listings";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
} from "@/components/dashboard/DashboardUI";
import { MarketCategorySidebar } from "@/components/dashboard/market/MarketCategorySidebar";
import {
  PiCatalogNavigation,
  PiCatalogView,
} from "@/components/dashboard/market/PiCatalogView";

export const dynamic = "force-dynamic";
type MarketSort = "popular" | "newest" | "name";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function marketHref(
  workspace: string,
  input: { q?: string; category?: string; sort?: MarketSort; page?: number },
) {
  const query = new URLSearchParams();
  if (input.q) query.set("q", input.q);
  query.set("view", "toolplane");
  if (input.category) query.set("category", input.category);
  if (input.sort && input.sort !== "popular") query.set("sort", input.sort);
  if (input.page && input.page > 1) query.set("page", String(input.page));
  const base = `/app/${encodeURIComponent(workspace)}/market/pi-packages`;
  return query.size ? `${base}?${query.toString()}` : base;
}

export default async function PiPackageMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    view?: string | string[];
    page?: string | string[];
    q?: string | string[];
    category?: string | string[];
    sort?: string | string[];
  }>;
}) {
  const [{ workspace: slug }, query, t, common, user] = await Promise.all([
    params,
    searchParams,
    getTranslations("console.market"),
    getTranslations("common"),
    getCurrentUser(),
  ]);
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/market/pi-packages`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const rawPage = Number(firstParam(query.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(query.q).trim().slice(0, 200);
  const view = firstParam(query.view);
  if (view === "workspace")
    redirect(`/app/${encodeURIComponent(slug)}/toolkits/pi-packages`);
  if (view !== "toolplane")
    return <PiCatalogView workspace={workspace} query={q} page={page} />;
  const category = firstParam(query.category).trim().toLocaleLowerCase();
  const requestedSort = firstParam(query.sort);
  const sort: MarketSort =
    requestedSort === "newest" || requestedSort === "name"
      ? requestedSort
      : "popular";
  const [categories, result] = await Promise.all([
    listMarketListingCategories("pi-package", {
      workspaceId: workspace.id,
      userId: user.id,
    }),
    listMarketListings({
      kind: "pi-package",
      q,
      category,
      sort,
      page,
      pageSize: 24,
      viewer: { workspaceId: workspace.id, userId: user.id },
    }),
  ]);
  if (category && !categories.some((item) => item.slug === category))
    redirect(marketHref(slug, { q, sort }));
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (page > lastPage)
    redirect(marketHref(slug, { q, category, sort, page: lastPage }));
  const hasFilters = Boolean(q || category || sort !== "popular");

  return (
    <DashboardPage className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-foreground">
          {t("piPackages")}
        </h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {t("piMarketDescription")}
        </p>
      </div>
      <PiCatalogNavigation workspace={slug} active="toolplane" />
      <form className="flex w-full flex-col gap-2 sm:flex-row">
        <input type="hidden" name="view" value="toolplane" />
        <input type="hidden" name="category" value={category} />
        <Input
          label={t("piSearch")}
          leftIcon={<Search />}
          name="q"
          defaultValue={q}
          placeholder={t("piSearch")}
          className="min-w-0 flex-1"
        />
        <FormSelect
          name="sort"
          defaultValue={sort}
          label={t("sortResources")}
          options={[
            { value: "popular", label: t("sortPopular") },
            { value: "newest", label: t("sortNewest") },
            { value: "name", label: t("sortName") },
          ]}
          className="sm:w-40"
        />
        <Button variant="secondary" size="md" type="submit">
          <SlidersHorizontal className="size-4" />
          {t("applyFilters")}
        </Button>
      </form>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <MarketCategorySidebar
          label={t("filterByCategory")}
          allLabel={t("allCategories")}
          allHref={marketHref(slug, { q, sort })}
          allCount={result.availableTotal}
          allActive={!category}
          categories={categories.map((item) => ({
            name: item.name,
            count: item.count,
            active: item.slug === category,
            href: marketHref(slug, {
              q,
              sort,
              category: item.slug === category ? undefined : item.slug,
            }),
          }))}
        />
        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{t("piResultSummary", { count: result.total })}</span>
            {hasFilters ? (
              <ButtonLink href={marketHref(slug, {})} variant="ghost" size="sm">
                {t("clearFilters")}
              </ButtonLink>
            ) : null}
          </div>
          {result.items.length === 0 ? (
            <DashboardEmptyState
              icon={Puzzle}
              title={t("piEmptyTitle")}
              description={t(hasFilters ? "piNoMatches" : "piEmptyDescription")}
              actions={
                <ButtonLink
                  href={`/app/${encodeURIComponent(slug)}/toolkits/pi-packages`}
                  variant="secondary"
                  size="sm"
                >
                  {t("piPublishTitle")}
                </ButtonLink>
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {result.items.map((item) => {
                if (!item.latestRelease) return null;
                const href = `/app/${encodeURIComponent(slug)}/market/items/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.slug)}`;
                return (
                  <article
                    key={item.id}
                    className="flex min-w-0 flex-col rounded-3xl border border-border bg-card p-4"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Puzzle className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={href}
                          className="line-clamp-1 font-semibold text-foreground hover:underline"
                        >
                          {item.name}
                        </Link>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.namespace} · Pi SDK
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-10 flex-1 text-sm leading-5 text-muted-foreground">
                      {item.summary ?? t("noDescription")}
                    </p>
                    <div className="mt-3 flex min-h-7 flex-wrap gap-1.5">
                      {item.categories.slice(0, 3).map((entry) => (
                        <ButtonLink
                          key={entry.slug}
                          href={marketHref(slug, {
                            q,
                            sort,
                            category: entry.slug,
                          })}
                          variant="ghost"
                          size="sm"
                        >
                          {entry.name}
                        </ButtonLink>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {t("versionLabel", {
                          version: item.latestRelease.version,
                        })}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <PackageCheck className="size-3.5" />
                        {item.installCount}
                      </span>
                    </div>
                    <ButtonLink
                      href={href}
                      variant="secondary"
                      size="sm"
                      className="mt-4"
                    >
                      {t("viewDetails")}
                      <ArrowRight className="size-4" />
                    </ButtonLink>
                  </article>
                );
              })}
            </div>
          )}
          <DashboardPagination
            page={result.page}
            lastPage={lastPage}
            summary={t("paginationSummary", {
              page: result.page,
              lastPage,
              total: result.total,
              label: t("piPackages"),
            })}
            previousLabel={common("previous")}
            nextLabel={common("next")}
            hrefForPage={(nextPage) =>
              marketHref(slug, { q, category, sort, page: nextPage })
            }
          />
        </div>
      </div>
    </DashboardPage>
  );
}
