import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, Puzzle, TriangleAlert } from "lucide-react";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import { PluginInstallForm } from "@/components/dashboard/plugins/PluginForms";
import { PluginAgentChooser } from "@/components/dashboard/plugins/PluginAgentChooser";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser, getDeployments } from "@/lib/workspace/queries";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { db } from "@/lib/db";
import {
  getPlugin,
  PluginError,
  pluginReleaseLabel,
  requirePluginWorkspace,
} from "@/lib/plugins/catalog";
import { previewPluginResource } from "@/lib/plugins/resource-preview";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { PluginReadme } from "@/components/dashboard/plugins/PluginReadme";
import {
  pluginResourceKinds,
  type PluginResourceKind,
} from "@/lib/plugins/release-contents";

export const dynamic = "force-dynamic";

const views = ["overview", "contents", "versions"] as const;
type View = (typeof views)[number];

/** Skills are named by their folder; other resources by file name. */
function resourceName(kind: PluginResourceKind, path: string) {
  const parts = path.replace(/\/+$/, "").split("/");
  const file = parts.at(-1) ?? path;
  if (kind === "skills" && /^skill\.md$/i.test(file) && parts.length > 1)
    return parts.at(-2) ?? file;
  return file.replace(/\.[^.]+$/, "") || file;
}

export default async function PluginDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; listingId: string }>;
  searchParams: Promise<{
    version?: string;
    view?: string;
    from?: string;
    returnAgent?: string;
    pluginChannel?: string;
    resource?: string;
    raw?: string;
  }>;
}) {
  const [{ workspace: slug, listingId }, query, user, t, locale] =
    await Promise.all([
      params,
      searchParams,
      getCurrentUser(),
      getTranslations("console.plugins"),
      getLocale(),
    ]);
  const base = `/app/${encodeURIComponent(slug)}/plugins`;
  const detail = `${base}/${encodeURIComponent(listingId)}`;
  const fromInstalled = query.from === "installed";
  // Agent settings open plugins with a target Agent and a tab channel to report back to.
  const returnAgent =
    typeof query.returnAgent === "string"
      ? query.returnAgent.slice(0, 240)
      : "";
  const pluginChannel =
    typeof query.pluginChannel === "string" &&
    /^[a-f0-9-]{36}$/.test(query.pluginChannel)
      ? query.pluginChannel
      : "";
  const context = new URLSearchParams({
    ...(returnAgent ? { returnAgent } : {}),
    ...(pluginChannel ? { pluginChannel } : {}),
  }).toString();
  const linkQuery = new URLSearchParams({
    ...(fromInstalled ? { from: "installed" } : {}),
    ...(returnAgent ? { returnAgent } : {}),
    ...(pluginChannel ? { pluginChannel } : {}),
  }).toString();
  const linkSuffix = linkQuery ? `&${linkQuery}` : "";
  if (!user) redirect(`/app/login?next=${encodeURIComponent(detail)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const plugin = await getPlugin(workspace.id, user.id, listingId).catch(
    (error: unknown) => {
      if (error instanceof PluginError && error.status === 404) notFound();
      throw error;
    },
  );
  const canManage = await requirePluginWorkspace(workspace.id, user.id, true)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof PluginError && error.status === 403) return false;
      throw error;
    });
  const [deployments, agents] = await Promise.all([
    getDeployments(workspace.id),
    canManage
      ? db.agent.findMany({
          where: {
            workspaceId: workspace.id,
            ...ORDINARY_AGENT_FILTER,
            runtimeKind: "pi-sdk",
            retiredAt: null,
          },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            piPackages: { select: { marketInstallId: true } },
          },
        })
      : [],
  ]);
  const releases = plugin.releases.map((release) => ({
    ...release,
    label: pluginReleaseLabel(release),
    snapshot: parsePiPackageReleaseManifest(release.manifest, release.checksum)
      .package,
  }));
  if (
    query.version &&
    !releases.some((release) => release.id === query.version)
  )
    notFound();
  const latest = releases[0];
  const selected =
    releases.find((release) => release.id === query.version) ?? latest;
  const viewingOlder = Boolean(selected && latest && selected.id !== latest.id);
  const install = plugin.install;
  // Adding to an Agent uses the workspace's installed version, not a historical preview.
  const targetRelease = install
    ? releases.find((release) => release.id === install.currentReleaseId)
    : latest;
  const view: View = (views as readonly string[]).includes(query.view ?? "")
    ? (query.view as View)
    : "overview";
  const preview =
    view === "contents" && selected && query.resource
      ? previewPluginResource(selected.snapshot, query.resource)
      : null;
  const resourceHref = (path: string, raw = false) =>
    `${detail}?view=contents&version=${encodeURIComponent(selected?.id ?? "")}&resource=${encodeURIComponent(path)}${raw ? "&raw=1" : ""}${linkSuffix}`;
  const readme = selected?.snapshot.entries.find(
    (entry) =>
      entry.type === "file" &&
      /^package\/readme(?:\.md|\.markdown|\.txt)?$/i.test(entry.path),
  );
  const readmeBytes =
    readme?.type === "file" ? Buffer.from(readme.content, "base64") : null;
  const readmeText =
    readmeBytes && readmeBytes.length <= 262_144
      ? readmeBytes.toString("utf8")
      : null;
  const packageSource = selected?.snapshot.source;
  const readmeSourceUrl =
    packageSource?.kind === "git" &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(packageSource.url) &&
    /^[a-f0-9]{40,64}$/.test(packageSource.commit)
      ? `${packageSource.url.replace(/\.git$/, "")}/blob/${packageSource.commit}/${packageSource.path ? `${packageSource.path.split("/").map(encodeURIComponent).join("/")}/` : ""}${encodeURIComponent(readme?.path.split("/").at(-1) ?? "README.md")}`
      : undefined;
  const source = plugin.githubRegistryResource?.registry;
  const latestSummary =
    latest?.releaseSummary &&
    typeof latest.releaseSummary === "object" &&
    !Array.isArray(latest.releaseSummary)
      ? latest.releaseSummary
      : {};
  const provenance =
    latestSummary.source &&
    typeof latestSummary.source === "object" &&
    !Array.isArray(latestSummary.source)
      ? latestSummary.source
      : {};
  const commit = typeof provenance.commit === "string" ? provenance.commit : "";
  const commitPath =
    typeof provenance.path === "string" && provenance.path
      ? `/${provenance.path.split("/").map(encodeURIComponent).join("/")}`
      : "";
  const map = install?.resourceMap;
  const rawBindings =
    map &&
    typeof map === "object" &&
    !Array.isArray(map) &&
    map.mcpBindings &&
    typeof map.mcpBindings === "object" &&
    !Array.isArray(map.mcpBindings)
      ? map.mcpBindings
      : {};
  const defaults: Record<string, { deploymentId: string; tools: string[] }> =
    {};
  for (const [key, binding] of Object.entries(rawBindings)) {
    if (
      binding &&
      typeof binding === "object" &&
      !Array.isArray(binding) &&
      typeof binding.deploymentId === "string" &&
      Array.isArray(binding.tools) &&
      binding.tools.every((tool) => typeof tool === "string")
    )
      defaults[key] = {
        deploymentId: binding.deploymentId,
        tools: binding.tools as string[],
      };
  }
  const resources = selected
    ? pluginResourceKinds.flatMap((kind) => {
        const paths = selected.snapshot.resources[kind] ?? [];
        return paths.length ? [{ kind, paths }] : [];
      })
    : [];
  const requirements = selected?.snapshot.toolplane?.mcp ?? [];
  const contentCount =
    resources.reduce((total, group) => total + group.paths.length, 0) +
    requirements.length;
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <DashboardPage>
      <header className="space-y-4">
        <Link
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          href={
            fromInstalled
              ? `${base}/installed`
              : `${base}${context ? `?${context}` : ""}`
          }
        >
          <ArrowLeft className="size-3.5" />
          {t(fromInstalled ? "installed.title" : "title")}
        </Link>
        <div className="flex items-start gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Puzzle className="size-7" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{plugin.name}</h1>
              {source?.official ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {t("official")}
                </span>
              ) : null}
              {latest?.snapshot.runtime.kind === "omp" ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                  {t("ompRetired")}
                </span>
              ) : null}
              {plugin.status !== "published" ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t(plugin.status === "withdrawn" ? "withdrawn" : "removed")}
                </span>
              ) : null}
            </div>
            {plugin.summary?.trim() ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {plugin.summary}
              </p>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground/60 italic">
                {t("noSummary")}
              </p>
            )}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {source ? (
                <a
                  className="break-all hover:text-foreground hover:underline"
                  href={`https://github.com/${source.repository}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.repository}
                </a>
              ) : (
                <span>{t("privatePlugin")}</span>
              )}
              {latest ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">v{latest.label}</span>
                </>
              ) : null}
              {source && commit ? (
                <>
                  <span aria-hidden="true">·</span>
                  <a
                    className="font-mono hover:text-foreground hover:underline"
                    href={`https://github.com/${source.repository}/tree/${commit}${commitPath}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {commit.slice(0, 7)}
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {plugin.tags.length ? (
          <div className="flex flex-wrap gap-2">
            {plugin.tags.map((tag) => (
              <span
                className="rounded-full bg-muted px-2 py-1 text-xs"
                key={tag}
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {plugin.status !== "published" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(
              plugin.status === "withdrawn"
                ? "withdrawnNotice"
                : "removedNotice",
            )}
          </p>
        ) : null}
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 space-y-5 lg:col-start-2 lg:row-start-1">
          <div
            id="plugin-install"
            className="min-w-0 scroll-mt-4 rounded-xl border border-border bg-card p-5"
          >
            <PluginInstallForm
              key={install?.currentReleaseId ?? "none"}
              workspace={slug}
              listingId={plugin.id}
              install={
                install
                  ? {
                      id: install.id,
                      releaseId: install.currentReleaseId,
                      version: pluginReleaseLabel(install.currentRelease),
                    }
                  : undefined
              }
              releases={releases.map((release) => ({
                id: release.id,
                version: release.label,
                requirements: release.snapshot.toolplane?.mcp ?? [],
              }))}
              defaults={defaults}
              deployments={deployments.map((deployment) => ({
                id: deployment.id,
                name: deploymentLabel(deployment).name,
                tools: readMcpToolCatalog(deployment.installCfg)
                  .filter(
                    (tool) =>
                      deployment.mcpToolExposure !== "allowlist" ||
                      deployment.mcpAllowedTools.includes(tool.name),
                  )
                  .map((tool) => tool.name),
              }))}
              canManage={canManage}
              status={plugin.status}
            />
            {canManage &&
            install &&
            plugin.status === "published" &&
            latest &&
            install.currentReleaseId !== latest.id ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {t("updateImpact", { count: install.agentPiPackages.length })}
              </p>
            ) : null}
          </div>
          {canManage ? (
            <DashboardPanel title={t("flow.addToAgent")}>
              <PluginAgentChooser
                workspace={slug}
                listingId={plugin.id}
                agents={agents.map((agent) => ({
                  id: agent.id,
                  name: agent.name,
                  packageCount: agent.piPackages.length,
                  selected: agent.piPackages.some(
                    (binding) => binding.marketInstallId === install?.id,
                  ),
                }))}
                canManage={canManage}
                installed={Boolean(install)}
                compatible={targetRelease?.snapshot.runtime.kind === "pi-sdk"}
                available={
                  plugin.status === "published" && Boolean(targetRelease)
                }
                returnAgent={returnAgent}
                pluginChannel={pluginChannel}
                version={targetRelease ? `v${targetRelease.label}` : "—"}
                counts={{
                  skills: targetRelease?.snapshot.resources.skills.length ?? 0,
                  extensions:
                    targetRelease?.snapshot.resources.extensions.length ?? 0,
                  mcp: targetRelease?.snapshot.toolplane?.mcp.length ?? 0,
                }}
              >
                <Link
                  href="#plugin-install"
                  className="text-sm text-primary hover:underline"
                >
                  {t("add")}
                </Link>
              </PluginAgentChooser>
            </DashboardPanel>
          ) : null}
        </div>
        <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {viewingOlder && selected ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              {t("viewingVersion", { version: selected.label })}
              {" · "}
              <Link
                className="font-medium text-foreground hover:underline"
                href={`${detail}?view=${view}${linkSuffix}`}
              >
                {t("viewLatest")}
              </Link>
            </p>
          ) : null}
          <nav
            aria-label={t("detailNavigation")}
            className="flex gap-1 overflow-x-auto border-b border-border"
          >
            {views.map((item) => (
              <Link
                key={item}
                href={`${detail}?view=${item}${viewingOlder && selected ? `&version=${encodeURIComponent(selected.id)}` : ""}${linkSuffix}`}
                aria-current={view === item ? "page" : undefined}
                className={`shrink-0 border-b-2 px-4 py-3 text-sm ${view === item ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t(item === "versions" ? "versionHistory" : item)}
                {item === "contents" || item === "versions" ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {item === "contents" ? contentCount : releases.length}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          {view === "overview" ? (
            <>
              <DashboardPanel title="README">
                {readmeText?.trim() ? (
                  <PluginReadme text={readmeText} sourceUrl={readmeSourceUrl} />
                ) : (
                  <div className="py-8 text-sm leading-7 text-muted-foreground">
                    <p>
                      {t(
                        readmeBytes && readmeBytes.length > 262_144
                          ? "readmeTooLarge"
                          : "readmeMissing",
                      )}
                    </p>
                    <p>{t("readmeHelp")}</p>
                  </div>
                )}
              </DashboardPanel>
              {install ? (
                <DashboardPanel title={t("agentsUsing")}>
                  {install.agentPiPackages.length ? (
                    <ul className="divide-y divide-border">
                      {install.agentPiPackages.map((binding) => (
                        <li
                          key={binding.agentId}
                          className="flex flex-wrap items-center justify-between gap-2 py-3"
                        >
                          <Link
                            className="text-sm font-medium hover:underline"
                            href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(binding.agentId)}`}
                          >
                            {binding.agent.name}
                          </Link>
                          <span
                            className={`rounded-full px-2 py-1 text-xs ${binding.syncStatus === "failed" ? "bg-destructive/10 text-destructive" : binding.syncStatus === "review_required" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}
                          >
                            {t.has(`syncStatuses.${binding.syncStatus}`)
                              ? t(`syncStatuses.${binding.syncStatus}`)
                              : binding.syncStatus}
                          </span>
                          {binding.syncError ? (
                            <p className="w-full break-words text-xs text-destructive">
                              {binding.syncError}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("agentsEmpty")}
                    </p>
                  )}
                </DashboardPanel>
              ) : null}
            </>
          ) : null}
          {preview && selected && query.resource ? (
            <DashboardPanel title={t("preview.title")}>
              <div className="min-w-0 space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("preview.version", { version: selected.label })}
                </p>
                <p className="break-all font-mono text-xs">
                  {"kind" in preview && preview.kind
                    ? `${t(preview.kind)} · `
                    : ""}
                  {query.resource}
                </p>
                {preview.status === "ready" ? (
                  <>
                    {preview.markdown ? (
                      <nav
                        aria-label={t("preview.mode")}
                        className="flex gap-4 text-sm"
                      >
                        <Link
                          href={resourceHref(query.resource)}
                          aria-current={query.raw !== "1" ? "page" : undefined}
                          className="text-primary hover:underline aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                        >
                          {t("preview.rendered")}
                        </Link>
                        <Link
                          href={resourceHref(query.resource, true)}
                          aria-current={query.raw === "1" ? "page" : undefined}
                          className="text-primary hover:underline aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                        >
                          {t("preview.raw")}
                        </Link>
                      </nav>
                    ) : null}
                    <section
                      className="max-h-[36rem] overflow-auto rounded-md border border-border p-4"
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded resource preview.
                      tabIndex={0}
                      aria-label={t("preview.title")}
                    >
                      {preview.markdown && query.raw !== "1" ? (
                        <PluginReadme text={preview.text} resourcePreview />
                      ) : (
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6">
                          {preview.text}
                        </pre>
                      )}
                    </section>
                  </>
                ) : (
                  <>
                    <p role="status" className="text-sm text-muted-foreground">
                      {t(`preview.${preview.status}`)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t("preview.alternative")}
                    </p>
                  </>
                )}
                <p className="flex gap-2 text-xs leading-5 text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  {t("preview.risk")}
                </p>
              </div>
            </DashboardPanel>
          ) : null}
          {view === "contents" ? (
            <DashboardPanel title={t("contents")}>
              {selected ? (
                <div className="space-y-6">
                  {resources.map(({ kind, paths }) => (
                    <section key={kind} className="min-w-0">
                      <h3 className="mb-2 text-sm font-medium">
                        {t(kind)}{" "}
                        <span className="text-muted-foreground">
                          {paths.length}
                        </span>
                      </h3>
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {paths.map((path) => (
                          <li key={path} className="min-w-0">
                            <Link
                              href={resourceHref(path)}
                              aria-current={
                                query.resource === path ? "page" : undefined
                              }
                              className={`block px-3 py-2 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary ${query.resource === path ? "bg-muted/50" : ""}`}
                            >
                              <span className="block truncate text-sm text-primary">
                                {resourceName(kind, path)}
                              </span>
                              <span className="block break-all font-mono text-xs text-muted-foreground">
                                {path}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  <section className="min-w-0">
                    <h3 className="mb-2 text-sm font-medium">
                      {t("mcpRequirements")}{" "}
                      {requirements.length ? (
                        <span className="text-muted-foreground">
                          {requirements.length}
                        </span>
                      ) : null}
                    </h3>
                    {requirements.length ? (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {requirements.map((requirement) => (
                          <li
                            key={requirement.key}
                            className="space-y-2 px-3 py-2"
                          >
                            <p className="text-sm">
                              {requirement.name}{" "}
                              <span className="font-mono text-xs text-muted-foreground">
                                {requirement.key}
                              </span>
                            </p>
                            <ul className="flex flex-wrap gap-1.5">
                              {requirement.tools.map((tool) => (
                                <li
                                  key={tool}
                                  className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                                >
                                  {tool}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("noMcpRequirements")}
                      </p>
                    )}
                  </section>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("preview.declared")}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              )}
            </DashboardPanel>
          ) : null}
          {view === "versions" ? (
            releases.length ? (
              <ol className="space-y-6 border-l border-border pl-5">
                {releases.map((release, index) => (
                  <li
                    key={release.id}
                    id={`release-${release.id}`}
                    aria-label={`v${release.label}`}
                    className="relative scroll-mt-4"
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2 border-background ${index === 0 ? "bg-primary" : "bg-muted-foreground/40"}`}
                    />
                    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="font-mono text-sm font-semibold">
                        v{release.label}
                      </h3>
                      {release.publishedAt ? (
                        <time
                          className="text-xs text-muted-foreground"
                          dateTime={release.publishedAt.toISOString()}
                        >
                          {dateFormat.format(release.publishedAt)}
                        </time>
                      ) : null}
                      {index === 0 ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {t("latest")}
                        </span>
                      ) : null}
                      {install?.currentReleaseId === release.id ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t("currentVersion")}
                        </span>
                      ) : null}
                      <Link
                        className="ml-auto text-xs text-primary hover:underline"
                        href={`${detail}?view=overview&version=${encodeURIComponent(release.id)}${linkSuffix}`}
                      >
                        {t("viewVersion")}
                      </Link>
                    </div>
                    <div className="space-y-3 rounded-xl border border-border bg-card px-5 py-4">
                      {release.changelog?.text.trim() ? (
                        <>
                          {release.changelog.kind === "changelog" ? (
                            <p className="text-sm leading-6 text-muted-foreground">
                              {t("changelogSnapshot")}
                            </p>
                          ) : null}
                          <PluginReadme
                            text={release.changelog.text}
                            sourceUrl={release.changelog.sourceUrl ?? undefined}
                          />
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("changelogMissing")}
                        </p>
                      )}
                      {release.changelog?.sourceUrl ? (
                        <a
                          className="inline-flex text-sm text-primary hover:underline"
                          href={release.changelog.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("changelogSource")}
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <DashboardPanel title={t("versionHistory")}>
                <p className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              </DashboardPanel>
            )
          ) : null}
        </div>
        {selected ? (
          <DashboardPanel
            title={t("about")}
            className="lg:col-start-2 lg:row-start-2"
          >
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("latestVersion")}</dt>
              <dd className="font-mono">{latest ? `v${latest.label}` : "—"}</dd>
              {install ? (
                <>
                  <dt className="text-muted-foreground">
                    {t("catalog.installedVersion")}
                  </dt>
                  <dd>
                    <span className="font-mono">
                      v{pluginReleaseLabel(install.currentRelease)}
                    </span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {t("catalog.revision", {
                        version: install.currentRelease.version,
                      })}
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">
                {t("capabilities.runtime")}
              </dt>
              <dd>
                {selected.snapshot.runtime.kind === "omp"
                  ? `OMP ${selected.snapshot.runtime.ompVersion}`
                  : `Pi ${selected.snapshot.runtime.piVersion}`}
              </dd>
              <dt className="text-muted-foreground">
                {t("capabilities.platform")}
              </dt>
              <dd>
                {selected.snapshot.runtime.platform} /{" "}
                {selected.snapshot.runtime.arch} · Node{" "}
                {selected.snapshot.runtime.nodeMajor}
              </dd>
              <dt className="text-muted-foreground">{t("publishedAt")}</dt>
              <dd>
                {selected.publishedAt ? (
                  <time dateTime={selected.publishedAt.toISOString()}>
                    {dateFormat.format(selected.publishedAt)}
                  </time>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted-foreground">
                {t("catalog.listingId")}
              </dt>
              <dd className="select-text break-all font-mono text-xs leading-5">
                {plugin.id}
              </dd>
            </dl>
            <p className="mt-4 flex gap-2 text-xs leading-5 text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              {t("capabilities.trust")}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t("capabilities.enablementHelp")}
            </p>
          </DashboardPanel>
        ) : null}
      </div>
    </DashboardPage>
  );
}
