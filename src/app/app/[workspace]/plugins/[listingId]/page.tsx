import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, Puzzle } from "lucide-react";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import {
  PluginActionForm,
  PluginInstallForm,
} from "@/components/dashboard/plugins/PluginForms";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser, getDeployments } from "@/lib/workspace/queries";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { db } from "@/lib/db";
import {
  getPlugin,
  PluginError,
  requirePluginWorkspace,
  pluginReleaseLabel,
} from "@/lib/plugins/catalog";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { PluginConfiguration } from "@/components/dashboard/plugins/PluginConfiguration";
import { PluginReadme } from "@/components/dashboard/plugins/PluginReadme";
import { PluginAgentChooser } from "@/components/dashboard/plugins/PluginAgentChooser";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import { previewPluginResource } from "@/lib/plugins/resource-preview";

export const dynamic = "force-dynamic";

export default async function PluginDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; listingId: string }>;
  searchParams: Promise<{
    version?: string;
    view?: string;
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
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`${base}/${encodeURIComponent(listingId)}`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const plugin = await getPlugin(workspace.id, user.id, listingId).catch(
    (error: unknown) => {
      if (error instanceof PluginError && error.status === 404) notFound();
      throw error;
    },
  );
  const [canManage, deployments, agents] = await Promise.all([
    requirePluginWorkspace(workspace.id, user.id, true)
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof PluginError && error.status === 403) return false;
        throw error;
      }),
    getDeployments(workspace.id),
    db.agent.findMany({
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
    }),
  ]);
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
  const contextSuffix = context ? `&${context}` : "";
  const releases = plugin.releases.map((release) => ({
    ...release,
    snapshot: parsePiPackageReleaseManifest(release.manifest, release.checksum)
      .package,
  }));
  const selected =
    releases.find((release) => release.id === query.version) ?? releases[0];
  // Adding to an Agent uses the workspace's installed version, not a historical preview.
  const targetRelease = plugin.install
    ? releases.find(
        (release) => release.id === plugin.install?.currentReleaseId,
      )
    : releases[0];
  if (
    query.version &&
    !releases.some((release) => release.id === query.version)
  )
    notFound();
  const preview =
    selected && query.resource
      ? previewPluginResource(selected.snapshot, query.resource)
      : null;
  const resourceHref = (path: string, raw = false) =>
    `${base}/${encodeURIComponent(plugin.id)}?view=resources&version=${encodeURIComponent(selected?.id ?? "")}&resource=${encodeURIComponent(path)}${raw ? "&raw=1" : ""}${contextSuffix}`;
  const view =
    query.view === "resources" ||
    query.view === "settings" ||
    query.view === "changelog"
      ? query.view
      : "overview";
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
  const summary =
    selected?.releaseSummary &&
    typeof selected.releaseSummary === "object" &&
    !Array.isArray(selected.releaseSummary)
      ? selected.releaseSummary
      : {};
  const provenance =
    summary.source &&
    typeof summary.source === "object" &&
    !Array.isArray(summary.source)
      ? summary.source
      : {};
  const commit = typeof provenance.commit === "string" ? provenance.commit : "";
  const map = plugin.install?.resourceMap;
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
  return (
    <DashboardPage>
      <Link
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        href={`${base}${context ? `?${context}` : ""}`}
      >
        <ArrowLeft className="size-4" />
        {t("title")}
      </Link>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <header className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          <div className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted">
              <Puzzle className="size-7" />
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 text-2xl font-semibold">
                  {plugin.name}
                </h1>
                {source?.official ? (
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                    {t("official")}
                  </span>
                ) : null}
                {plugin.updateAvailable ? (
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                    {t("updateAvailable")}
                  </span>
                ) : null}
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                {plugin.summary}
              </p>
            </div>
          </div>
          {source ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                {t("source")}
              </summary>
              <a
                className="mt-2 block break-all font-mono hover:underline"
                href={`https://github.com/${source.repository}${commit ? `/tree/${commit}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {source.repository}
                {commit ? `@${commit}` : ""}
              </a>
            </details>
          ) : null}
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
        </header>
        <div className="min-w-0 space-y-5">
          <section id="plugin-install" className="scroll-mt-4">
            <DashboardPanel
              title={t(plugin.install ? "manage" : "add")}
              bodyClassName="space-y-4 [overflow-wrap:anywhere]"
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t("status")}</dt>
                <dd>{t(plugin.install ? "added" : "notAdded")}</dd>
                {plugin.install ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t("currentVersion")}
                    </dt>
                    <dd>{pluginReleaseLabel(plugin.install.currentRelease)}</dd>
                  </>
                ) : releases[0] ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t("installVersion")}
                    </dt>
                    <dd>
                      {releases[0].snapshot.version ?? releases[0].version}
                    </dd>
                  </>
                ) : null}
                {selected ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t("viewedVersion")}
                    </dt>
                    <dd>{selected.snapshot.version ?? selected.version}</dd>
                  </>
                ) : null}
              </dl>
              {plugin.status !== "published" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t(
                    plugin.status === "withdrawn"
                      ? "withdrawnNotice"
                      : "removedNotice",
                  )}
                </p>
              ) : !releases.length ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              ) : null}
              {canManage && plugin.status === "published" && releases.length ? (
                <PluginInstallForm
                  workspace={slug}
                  listingId={plugin.id}
                  installId={plugin.install?.id}
                  currentReleaseId={plugin.install?.currentReleaseId}
                  releases={releases.map((release) => ({
                    id: release.id,
                    version:
                      release.snapshot.version ?? String(release.version),
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
                />
              ) : null}
              {canManage &&
              plugin.install &&
              plugin.status === "published" &&
              releases.length ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("updateImpact", {
                    count: plugin.install.agentPiPackages.length,
                  })}
                </p>
              ) : null}
            </DashboardPanel>
          </section>
          <DashboardPanel title={t("flow.addToAgent")}>
            <PluginAgentChooser
              workspace={slug}
              listingId={plugin.id}
              agents={agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                packageCount: agent.piPackages.length,
                selected: agent.piPackages.some(
                  (binding) => binding.marketInstallId === plugin.install?.id,
                ),
              }))}
              canManage={canManage}
              installed={Boolean(plugin.install)}
              compatible={targetRelease?.snapshot.runtime.kind === "pi-sdk"}
              available={
                plugin.status === "published" && Boolean(targetRelease)
              }
              returnAgent={returnAgent}
              pluginChannel={pluginChannel}
              version={
                targetRelease?.snapshot.version ??
                String(targetRelease?.version ?? "—")
              }
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
        </div>
        <div className="min-w-0 space-y-5">
          <nav
            aria-label={t("detailNavigation")}
            className="flex gap-1 overflow-x-auto border-b border-border"
          >
            {(["overview", "changelog", "resources", "settings"] as const)
              .filter((item) => item !== "settings" || plugin.install)
              .map((item) => (
                <Link
                  key={item}
                  href={`${base}/${encodeURIComponent(plugin.id)}?view=${item}${selected ? `&version=${encodeURIComponent(selected.id)}` : ""}${contextSuffix}`}
                  aria-current={view === item ? "page" : undefined}
                  className={`shrink-0 border-b-2 px-4 py-3 text-sm ${view === item ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {t(item === "settings" ? "capabilities.config" : item)}
                </Link>
              ))}
          </nav>
          {view === "overview" ? (
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
          ) : null}
          {view === "changelog" ? (
            releases.length ? (
              <div className="space-y-5">
                {releases.map((release) => (
                  <section
                    key={release.id}
                    id={`release-${release.id}`}
                    aria-label={`${t("changelog")} · ${release.snapshot.version ?? release.version}`}
                    className="scroll-mt-4"
                  >
                    <DashboardPanel
                      title={`${t("changelog")} · ${release.snapshot.version ?? release.version}`}
                    >
                      <div className="space-y-4">
                        {release.changelog?.text.trim() ? (
                          <>
                            {release.changelog.kind === "changelog" ? (
                              <p className="text-sm leading-6 text-muted-foreground">
                                {t("changelogSnapshot")}
                              </p>
                            ) : null}
                            <PluginReadme
                              text={release.changelog.text}
                              sourceUrl={
                                release.changelog.sourceUrl ?? undefined
                              }
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
                    </DashboardPanel>
                  </section>
                ))}
              </div>
            ) : (
              <DashboardPanel title={t("changelog")}>
                <p className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              </DashboardPanel>
            )
          ) : null}
          {view === "resources" ? (
            <DashboardPanel title={t("resources")}>
              {selected ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  {(
                    [
                      "skills",
                      "prompts",
                      "extensions",
                      "themes",
                      "hooks",
                      "tools",
                      "commands",
                      "subagents",
                    ] as const
                  )
                    .filter(
                      (kind) =>
                        (selected.snapshot.resources[kind] ?? []).length > 0,
                    )
                    .map((kind) => (
                      <section key={kind} className="min-w-0">
                        <h3 className="mb-2 text-sm font-medium">
                          {t(kind)}{" "}
                          <span className="text-muted-foreground">
                            {(selected.snapshot.resources[kind] ?? []).length}
                          </span>
                        </h3>
                        <ul className="space-y-1">
                          {(selected.snapshot.resources[kind] ?? []).map(
                            (path) => (
                              <li
                                key={path}
                                className="break-all font-mono text-xs text-muted-foreground"
                              >
                                <Link
                                  href={resourceHref(path)}
                                  aria-current={
                                    query.resource === path ? "page" : undefined
                                  }
                                  className="text-primary underline-offset-4 hover:underline focus-visible:underline"
                                >
                                  {path}
                                </Link>
                              </li>
                            ),
                          )}
                        </ul>
                      </section>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              )}
            </DashboardPanel>
          ) : null}
          {view === "resources" && selected ? (
            <DashboardPanel title={t("preview.title")}>
              <div className="min-w-0 space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("preview.version", {
                    version: selected.snapshot.version ?? selected.version,
                  })}
                </p>
                {query.resource ? (
                  <p className="break-all font-mono text-xs">
                    {preview && "kind" in preview && preview.kind
                      ? `${t(preview.kind)} · `
                      : ""}
                    {query.resource}
                  </p>
                ) : null}
                {preview?.status === "ready" && query.resource ? (
                  <>
                    {preview.markdown ? (
                      <nav
                        aria-label={t("preview.mode")}
                        className="flex gap-4 text-sm"
                      >
                        <Link
                          href={resourceHref(query.resource)}
                          aria-current={query.raw !== "1" ? "page" : undefined}
                          className="text-primary hover:underline"
                        >
                          {t("preview.rendered")}
                        </Link>
                        <Link
                          href={resourceHref(query.resource, true)}
                          aria-current={query.raw === "1" ? "page" : undefined}
                          className="text-primary hover:underline"
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
                  <p role="status" className="text-sm text-muted-foreground">
                    {t(`preview.${preview?.status ?? "choose"}`)}
                  </p>
                )}
                {preview && preview.status !== "ready" ? (
                  <p className="text-sm text-muted-foreground">
                    {t("preview.alternative")}
                  </p>
                ) : null}
                <p className="text-sm leading-6 text-muted-foreground">
                  {t("preview.declared")}
                </p>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {JSON.stringify(selected.snapshot.runtime, null, 2)}
                </pre>
                <p className="text-sm leading-6 text-muted-foreground">
                  {t("preview.risk")}
                </p>
              </div>
            </DashboardPanel>
          ) : null}
          {view === "settings" && plugin.install ? (
            <DashboardPanel title={t("capabilities.config")}>
              <PluginConfiguration
                key={plugin.install.currentReleaseId}
                workspace={slug}
                installId={plugin.install.id}
                canManage={canManage}
              />
            </DashboardPanel>
          ) : null}
          {view === "resources" ? (
            <DashboardPanel title={t("mcpRequirements")}>
              {selected?.snapshot.toolplane?.mcp.length ? (
                <ul className="space-y-4">
                  {selected.snapshot.toolplane.mcp.map((requirement) => (
                    <li key={requirement.key}>
                      <h3 className="text-sm font-medium">
                        {requirement.name}{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          {requirement.key}
                        </span>
                      </h3>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {requirement.tools.join(", ")}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noMcpRequirements")}
                </p>
              )}
            </DashboardPanel>
          ) : null}
          {view === "overview" ? (
            <DashboardPanel title={t("agentsUsing")}>
              {plugin.install?.agentPiPackages.length ? (
                <ul className="divide-y divide-border">
                  {plugin.install.agentPiPackages.map((binding) => (
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
        </div>
        <aside className="min-w-0 space-y-5">
          {selected ? (
            <DashboardPanel title={t("capabilities.title")}>
              <dl className="grid gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
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
                  {selected.snapshot.runtime.arch}
                </dd>
              </dl>
              <p className="mt-3 text-sm text-muted-foreground">
                {t("flow.counts", {
                  skills: selected.snapshot.resources.skills.length,
                  extensions: selected.snapshot.resources.extensions.length,
                  mcp: selected.snapshot.toolplane?.mcp.length ?? 0,
                })}
              </p>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {t("capabilities.enablementHelp")}
              </p>
              <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
                {t("capabilities.trust")}
              </p>
              {!plugin.install && selected.snapshot.toolplane?.config ? (
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(selected.snapshot.toolplane.config, null, 2)}
                </pre>
              ) : null}
            </DashboardPanel>
          ) : null}
          <details className="min-w-0 rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer text-sm font-semibold">
              {t("versions")}
            </summary>
            <div className="mt-4">
              {releases.length ? (
                <ul className="space-y-3">
                  {releases.map((release) => (
                    <li key={release.id}>
                      <Link
                        href={`${base}/${encodeURIComponent(plugin.id)}?view=${view}&version=${encodeURIComponent(release.id)}${contextSuffix}${view === "resources" && query.resource ? `&resource=${encodeURIComponent(query.resource)}${query.raw === "1" ? "&raw=1" : ""}` : ""}${view === "changelog" ? `#release-${release.id}` : ""}`}
                        aria-current={
                          selected?.id === release.id ? "true" : undefined
                        }
                        className={`block rounded-lg border p-3 text-sm ${selected?.id === release.id ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted"}`}
                      >
                        <span className="flex flex-wrap justify-between gap-2">
                          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                            {release.snapshot.version ?? release.version}
                          </span>
                          {plugin.install?.currentReleaseId === release.id ? (
                            <span className="text-xs text-muted-foreground">
                              {t("currentVersion")}
                            </span>
                          ) : null}
                        </span>
                        {release.publishedAt ? (
                          <time
                            className="mt-1 block text-xs text-muted-foreground"
                            dateTime={release.publishedAt.toISOString()}
                          >
                            {new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                            }).format(release.publishedAt)}
                          </time>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noVersions")}
                </p>
              )}
            </div>
          </details>
          {canManage && plugin.install ? (
            <div className="space-y-3">
              <p className="text-xs leading-5 text-muted-foreground">
                {t("removeImpact")}
              </p>
              <PluginActionForm
                workspace={slug}
                operation="remove"
                id={plugin.install.id}
                label={t("remove")}
                destructive
                confirm
              />
            </div>
          ) : null}
        </aside>
      </div>
    </DashboardPage>
  );
}
