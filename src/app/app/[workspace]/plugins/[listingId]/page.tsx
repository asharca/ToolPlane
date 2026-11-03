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
import { getPlugin, PluginError } from "@/lib/plugins/catalog";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { PluginConfiguration } from "@/components/dashboard/plugins/PluginConfiguration";
import { PluginReadme } from "@/components/dashboard/plugins/PluginReadme";

export const dynamic = "force-dynamic";

export default async function PluginDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; listingId: string }>;
  searchParams: Promise<{ version?: string; view?: string }>;
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
  const [membership, deployments] = await Promise.all([
    db.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { role: true },
    }),
    getDeployments(workspace.id),
  ]);
  const canManage =
    workspace.ownerId === user.id ||
    membership?.role === "admin" ||
    membership?.role === "owner";
  const releases = plugin.releases.map((release) => ({
    ...release,
    snapshot: parsePiPackageReleaseManifest(release.manifest, release.checksum)
      .package,
  }));
  const selected =
    releases.find((release) => release.id === query.version) ?? releases[0];
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
        href={base}
      >
        <ArrowLeft className="size-4" />
        {t("title")}
      </Link>
      <header className="space-y-4">
        <div className="flex items-start gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Puzzle className="size-7" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{plugin.name}</h1>
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
          <a
            className="block break-all font-mono text-xs text-muted-foreground hover:underline"
            href={`https://github.com/${source.repository}${commit ? `/tree/${commit}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {source.repository}
            {commit ? `@${commit}` : ""}
          </a>
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
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
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
                  href={`${base}/${encodeURIComponent(plugin.id)}?view=${item}${selected ? `&version=${encodeURIComponent(selected.id)}` : ""}`}
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
                                {path}
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
          {canManage && plugin.status === "published" && releases.length ? (
            <DashboardPanel title={t(plugin.install ? "manage" : "add")}>
              <PluginInstallForm
                workspace={slug}
                listingId={plugin.id}
                installId={plugin.install?.id}
                currentReleaseId={plugin.install?.currentReleaseId}
                releases={releases.map((release) => ({
                  id: release.id,
                  version: release.snapshot.version ?? String(release.version),
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
            </DashboardPanel>
          ) : null}
          <DashboardPanel title={t("versions")}>
            {releases.length ? (
              <ul className="space-y-3">
                {releases.map((release) => (
                  <li key={release.id}>
                    <Link
                      href={`${base}/${encodeURIComponent(plugin.id)}?view=${view}&version=${encodeURIComponent(release.id)}${view === "changelog" ? `#release-${release.id}` : ""}`}
                      aria-current={
                        selected?.id === release.id ? "true" : undefined
                      }
                      className={`block rounded-lg border p-3 text-sm ${selected?.id === release.id ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted"}`}
                    >
                      <span className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">
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
              <p className="text-sm text-muted-foreground">{t("noVersions")}</p>
            )}
          </DashboardPanel>
          {canManage && plugin.install ? (
            <PluginActionForm
              workspace={slug}
              operation="remove"
              id={plugin.install.id}
              label={t("remove")}
              destructive
              confirm
            />
          ) : null}
        </aside>
      </div>
    </DashboardPage>
  );
}
