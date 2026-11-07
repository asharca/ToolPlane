import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { Puzzle, ArrowUpCircle, GitBranch } from "lucide-react";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import { Button, ButtonLink } from "@/components/motion/button";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  PluginActionForm,
  PluginSourceCreate,
  PluginWebhook,
} from "@/components/dashboard/plugins/PluginForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listPluginCards, visiblePluginWhere } from "@/lib/plugins/catalog";
import { listPluginSources } from "@/lib/plugins/sources";

export const dynamic = "force-dynamic";
const pluginFieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

export default async function PluginsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, query, user, t, locale] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.plugins"),
    getLocale(),
  ]);
  const base = `/app/${encodeURIComponent(slug)}/plugins`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(base)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const value = (key: string) =>
    (Array.isArray(query[key]) ? query[key][0] : query[key]) ?? "";
  const tab = ["added", "sources"].includes(value("tab"))
    ? value("tab")
    : "discover";
  const q = value("q").trim().slice(0, 200);
  const sourceId = value("source").slice(0, 240);
  const returnAgent = value("returnAgent").slice(0, 240);
  const pluginChannel = /^[a-f0-9-]{36}$/.test(value("pluginChannel"))
    ? value("pluginChannel")
    : "";
  const context = new URLSearchParams({
    ...(returnAgent ? { returnAgent } : {}),
    ...(pluginChannel ? { pluginChannel } : {}),
  }).toString();
  const origin = ["official", "private"].includes(value("origin"))
    ? value("origin")
    : "";
  const capability = ["skills", "extensions", "mcp"].includes(
    value("capability"),
  )
    ? value("capability")
    : "";
  const availability = ["available", "unavailable"].includes(
    value("availability"),
  )
    ? value("availability")
    : "";
  const hasFilters = Boolean(
    q || sourceId || origin || capability || availability,
  );
  const tabHref = (nextTab: string, clearFilters = false) => {
    const search = new URLSearchParams(context);
    if (nextTab !== "discover") search.set("tab", nextTab);
    if (!clearFilters) {
      if (q) search.set("q", q);
      if (sourceId) search.set("source", sourceId);
      if (origin) search.set("origin", origin);
      if (capability) search.set("capability", capability);
      if (availability) search.set("availability", availability);
    }
    const suffix = search.toString();
    return suffix ? `${base}?${suffix}` : base;
  };
  const [catalog, sources, membership] = await Promise.all([
    listPluginCards(workspace.id, user.id, {
      query: q,
      sourceId: sourceId || undefined,
      installedOnly: tab === "added",
    }),
    listPluginSources(workspace.id, user.id),
    db.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { role: true },
    }),
  ]);
  const items = catalog.items.filter((plugin) => {
    if (
      origin === "official" &&
      !plugin.githubRegistryResource?.registry.official
    )
      return false;
    if (
      origin === "private" &&
      plugin.githubRegistryResource?.registry.official
    )
      return false;
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
  const hasInstalledPlugins =
    tab === "added" && catalog.items.length === 0 && hasFilters
      ? Boolean(
          await db.marketListing.findFirst({
            where: {
              ...visiblePluginWhere(workspace.id),
              installs: {
                some: { targetWorkspaceId: workspace.id, status: "ready" },
              },
            },
            select: { id: true },
          }),
        )
      : catalog.items.length > 0;
  const emptyMessage =
    tab === "added"
      ? hasInstalledPlugins
        ? "addedFilteredEmpty"
        : "addedEmpty"
      : hasFilters
        ? "discoverFilteredEmpty"
        : "discoverEmpty";
  const canManage =
    workspace.ownerId === user.id ||
    membership?.role === "admin" ||
    membership?.role === "owner";
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <DashboardPage>
      <header className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <Puzzle className="size-6" />
            {t("title")}
          </h1>
          <div className="flex flex-wrap gap-2">
            <ButtonLink
              href="https://github.com/asharca/toolplane-plugins/fork"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              size="sm"
            >
              {t("createMarket")}
            </ButtonLink>
            <ButtonLink
              href="https://github.com/asharca/toolplane-plugins/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
            >
              {t("contribute")}
            </ButtonLink>
          </div>
        </div>
        <nav
          aria-label={t("title")}
          className="flex gap-1 border-b border-border"
        >
          {(["discover", "added", "sources"] as const).map((item) => (
            <Link
              key={item}
              href={tabHref(item)}
              aria-current={tab === item ? "page" : undefined}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm ${tab === item ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t(item)}
              {item === "added" && catalog.updateCount > 0 ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {t("updatesCount", { count: catalog.updateCount })}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
      </header>
      {tab === "sources" ? (
        <div className="space-y-5">
          <p className="text-sm leading-6 text-muted-foreground">
            {t("marketGuide")}
          </p>
          {sources.length ? (
            sources.map((source) => (
              <DashboardPanel
                key={source.id}
                title={
                  <span className="flex items-center gap-2">
                    {source.official ? t("officialSource") : source.name}
                    {source.official ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        {t("official")}
                      </span>
                    ) : null}
                  </span>
                }
              >
                <div className="space-y-4">
                  <a
                    className="inline-flex items-center gap-2 break-all text-sm hover:underline"
                    href={`https://github.com/${source.repository}/tree/${encodeURIComponent(source.branch)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <GitBranch className="size-4 shrink-0" />
                    {source.repository} · {source.branch}
                  </a>
                  <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">{t("status")}</dt>
                      <dd>
                        {t.has(`sourceStatuses.${source.status}`)
                          ? t(`sourceStatuses.${source.status}`)
                          : source.status}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("lastSync")}</dt>
                      <dd>
                        {source.lastSyncAt
                          ? dateFormat.format(source.lastSyncAt)
                          : t("neverSynced")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("lastCommit")}
                      </dt>
                      <dd className="break-all font-mono text-xs">
                        {source.lastAppliedCommit ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("visibility")}
                      </dt>
                      <dd>
                        {t(
                          source.visibility === "private"
                            ? "private"
                            : "public",
                        )}
                      </dd>
                    </div>
                  </dl>
                  {source.error ? (
                    <p
                      role="alert"
                      className="break-words text-sm text-destructive"
                    >
                      {t.has(`errors.${source.error}`)
                        ? t(`errors.${source.error}`)
                        : t("errors.registry_sync_failed")}
                    </p>
                  ) : null}
                  {source.canSync ? (
                    <PluginActionForm
                      workspace={slug}
                      operation="source-sync"
                      id={source.id}
                      label={t("syncNow")}
                    />
                  ) : null}
                  {!source.official && canManage ? (
                    <>
                      <details className="rounded-lg border border-border p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          {t("credentials")}
                          {source.hasCredentials ? ` · ${t("configured")}` : ""}
                        </summary>
                        <div className="mt-3">
                          <PluginActionForm
                            workspace={slug}
                            operation="source-credentials"
                            id={source.id}
                            label={t("replaceCredentials")}
                          >
                            <label className="grid gap-1 text-sm">
                              {t("token")}
                              <input
                                type="password"
                                name="token"
                                autoComplete="off"
                                className={pluginFieldClass}
                                required={source.visibility === "private"}
                                maxLength={4096}
                              />
                            </label>
                          </PluginActionForm>
                        </div>
                      </details>
                      {source.webhook ? (
                        <details className="rounded-lg border border-border p-3">
                          <summary className="cursor-pointer text-sm font-medium">
                            {t("webhook")}
                          </summary>
                          <div className="mt-3">
                            <PluginWebhook
                              path={source.webhook.path}
                              secret={source.webhook.secret}
                            />
                          </div>
                        </details>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("webhookUnavailable")}
                        </p>
                      )}
                      <PluginActionForm
                        workspace={slug}
                        operation="source-delete"
                        id={source.id}
                        label={t("deleteSource")}
                        destructive
                        confirm
                      />
                    </>
                  ) : null}
                </div>
              </DashboardPanel>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              {t("sourcesEmpty")}
            </p>
          )}
          {canManage ? (
            <DashboardPanel title={t("sourceAdd")}>
              <PluginSourceCreate workspace={slug} />
            </DashboardPanel>
          ) : null}
        </div>
      ) : (
        <>
          <form
            key={JSON.stringify([
              tab,
              q,
              sourceId,
              origin,
              capability,
              availability,
            ])}
            action={base}
            method="get"
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="tab" value={tab} />
            {returnAgent ? (
              <input type="hidden" name="returnAgent" value={returnAgent} />
            ) : null}
            {pluginChannel ? (
              <input type="hidden" name="pluginChannel" value={pluginChannel} />
            ) : null}
            <label className="grid min-w-0 flex-1 basis-full gap-1 text-sm sm:basis-0">
              {t("search")}
              <input
                name="q"
                type="search"
                className={pluginFieldClass}
                defaultValue={q}
                maxLength={200}
                placeholder={t("searchPlaceholder")}
              />
            </label>
            <div className="grid gap-1 text-sm">
              <label htmlFor="plugin-source-filter">{t("source")}</label>
              <FormSelect
                id="plugin-source-filter"
                name="source"
                label={t("source")}
                defaultValue={sourceId}
                className="w-48"
                options={[
                  { value: "", label: t("allSources") },
                  ...(sourceId &&
                  !sources.some((source) => source.id === sourceId)
                    ? [{ value: sourceId, label: t("unavailableSource") }]
                    : []),
                  ...sources.map((source) => ({
                    value: source.id,
                    label: source.official ? t("officialSource") : source.name,
                  })),
                ]}
              />
            </div>
            {(
              [
                {
                  name: "origin",
                  value: origin,
                  options: ["official", "private"],
                },
                {
                  name: "capability",
                  value: capability,
                  options: ["skills", "extensions", "mcp"],
                },
                {
                  name: "availability",
                  value: availability,
                  options: ["available", "unavailable"],
                },
              ] as const
            ).map((filter) => (
              <div
                key={filter.name}
                className="grid min-w-0 flex-1 basis-full gap-1 text-sm sm:basis-40"
              >
                <label htmlFor={`plugin-${filter.name}`}>
                  {t(`catalog.${filter.name}`)}
                </label>
                <FormSelect
                  id={`plugin-${filter.name}`}
                  name={filter.name}
                  label={t(`catalog.${filter.name}`)}
                  defaultValue={filter.value}
                  className="w-full"
                  options={[
                    { value: "", label: t("catalog.all") },
                    ...filter.options.map((option) => ({
                      value: option,
                      label: t(`catalog.${option}`),
                    })),
                  ]}
                />
              </div>
            ))}
            <Button type="submit" variant="secondary">
              {t("search")}
            </Button>
          </form>
          {items.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {items.map((plugin) => (
                <article
                  key={plugin.id}
                  className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-5"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Puzzle className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words font-semibold [overflow-wrap:anywhere]">
                        <Link
                          aria-label={`${plugin.name} · #${plugin.id.slice(-12)}`}
                          className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                          href={`${base}/${encodeURIComponent(plugin.id)}${context ? `?${context}` : ""}`}
                        >
                          {plugin.name}
                        </Link>
                      </h2>
                      <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {plugin.githubRegistryResource?.registry.official
                          ? t("official")
                          : t("privatePlugin")}
                        {" · "}
                        <span className="font-mono">
                          #{plugin.id.slice(-12)}
                        </span>
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
                    {plugin.card.summary?.trim() || t("catalog.noSummary")}
                  </p>
                  <p className="break-words text-sm [overflow-wrap:anywhere]">
                    {t(plugin.install ? "catalog.installedVersion" : "version")}
                    {": "}
                    {plugin.card.version ?? t("catalog.unnamedVersion")}
                    {plugin.card.revision !== null
                      ? ` · ${t("catalog.revision", { version: plugin.card.revision })}`
                      : ""}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {plugin.card.resources.length
                      ? plugin.card.resources
                          .map(
                            (resource) =>
                              `${t(resource.kind === "extensions" ? "catalog.extensions" : resource.kind)} ${resource.count}`,
                          )
                          .join(" · ")
                      : t("catalog.noCapabilities")}
                    {plugin.card.mcpCount
                      ? ` · ${t("mcpRequirements")} ${plugin.card.mcpCount}`
                      : ""}
                  </p>
                  {plugin.install ? (
                    <p className="text-xs text-muted-foreground">
                      {t("catalog.agentBindings", {
                        count: plugin.card.agentBindingCount,
                      })}
                    </p>
                  ) : null}
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-primary">
                      {t("catalog.identityDetails")}
                    </summary>
                    <dl className="mt-2 space-y-2 break-words [overflow-wrap:anywhere]">
                      <div>
                        <dt>{t("catalog.listingId")}</dt>
                        <dd className="select-text font-mono">{plugin.id}</dd>
                      </div>
                      {plugin.githubRegistryResource ? (
                        <div>
                          <dt>{t("repository")}</dt>
                          <dd>
                            {plugin.githubRegistryResource.registry.repository}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>{t("catalog.snapshotRuntime")}</dt>
                        <dd>
                          {plugin.card.runtime
                            ? `${plugin.card.runtime.kind} · ${"piVersion" in plugin.card.runtime ? plugin.card.runtime.piVersion : plugin.card.runtime.ompVersion} · Node ${plugin.card.runtime.nodeMajor} · ${plugin.card.runtime.platform}/${plugin.card.runtime.arch}`
                            : t("catalog.unknownRuntime")}
                        </dd>
                      </div>
                      <div>
                        <dt className="sr-only">{t("capabilities.title")}</dt>
                        <dd>{t("catalog.runtimeHelp")}</dd>
                      </div>
                    </dl>
                  </details>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {!plugin.card.available ? (
                      <span className="text-muted-foreground">
                        {t(
                          plugin.card.revoked
                            ? "catalog.revoked"
                            : "catalog.unavailable",
                        )}
                      </span>
                    ) : null}
                    {plugin.install ? (
                      <span className="rounded-full bg-muted px-2 py-1">
                        {t("added")}
                      </span>
                    ) : null}
                    {plugin.updateAvailable ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-primary">
                        <ArrowUpCircle className="size-3" />
                        {t("updateAvailable")}
                      </span>
                    ) : null}
                    {plugin.status !== "published" ? (
                      <span className="text-muted-foreground">
                        {t(
                          plugin.status === "withdrawn"
                            ? "withdrawn"
                            : "removed",
                        )}
                      </span>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="space-y-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              <p>{t(emptyMessage)}</p>
              {hasFilters ? (
                <ButtonLink
                  href={tabHref(tab, true)}
                  variant="secondary"
                  size="sm"
                >
                  {t("clearFilters")}
                </ButtonLink>
              ) : null}
            </div>
          )}
        </>
      )}
    </DashboardPage>
  );
}
