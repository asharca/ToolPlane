import { Button, ButtonLink } from "@/components/motion/button";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listWorkspaceMarketInstalls } from "@/lib/market/skills";
import { listMarketListings } from "@/lib/market/listings";
import { effectiveStatus } from "@/lib/process/supervisor";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
const SOURCE_KINDS = [
  "npm",
  "git",
  "zip",
  "toolplane",
  "pypi",
  "github",
  "docker",
  "config",
  "remote",
] as const;
const SOURCE_LABELS = {
  npm: "sourceNpm",
  git: "sourceGit",
  zip: "sourceZip",
  toolplane: "sourceComposed",
  pypi: "sourcePypi",
  github: "sourceGithub",
  docker: "sourceDocker",
  config: "sourceConfig",
  remote: "sourceRemote",
} as const;

export default async function MarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, query, user, t, common] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.market"),
    getTranslations("common"),
  ]);
  const legacyKind = Array.isArray(query.kind) ? query.kind[0] : query.kind;
  const legacySections: Record<string, string> = {
    mcp: "mcp",
    skill: "skills",
    agent: "agents",
    assistant: "assistants",
    toolkit: "pi-packages",
  };
  if (legacyKind && legacySections[legacyKind]) {
    const suffix = new URLSearchParams(
      Object.entries(query)
        .filter(([key]) => key !== "kind")
        .flatMap(([key, value]) =>
          (Array.isArray(value) ? value : value ? [value] : []).map((entry) => [
            key,
            entry,
          ]),
        ),
    ).toString();
    redirect(
      `/app/${encodeURIComponent(slug)}/market/${legacySections[legacyKind]}${suffix ? `?${suffix}` : ""}`,
    );
  }
  if (!user)
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const q = (Array.isArray(query.q) ? query.q[0] : (query.q ?? ""))
    .trim()
    .slice(0, 200);
  const typeValue = Array.isArray(query.type) ? query.type[0] : query.type;
  const allowedKinds = ["mcp", "skill", "agent", "assistant", "pi-package"];
  const type = typeValue && allowedKinds.includes(typeValue) ? typeValue : "";
  const sourceValue = Array.isArray(query.sourceKind)
    ? query.sourceKind[0]
    : query.sourceKind;
  const sourceKind =
    sourceValue &&
    SOURCE_KINDS.includes(sourceValue as (typeof SOURCE_KINDS)[number])
      ? sourceValue
      : "";
  const targetValue = Array.isArray(query.target)
    ? query.target[0]
    : query.target;
  const target =
    targetValue === "agent" || targetValue === "assistant"
      ? targetValue
      : undefined;
  const requestedPage = Number(
    Array.isArray(query.page) ? query.page[0] : query.page,
  );
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const result = await listMarketListings({
    kind: type,
    q,
    sourceKind,
    target,
    page,
    pageSize: 18,
    viewer: { workspaceId: workspace.id, userId: user.id },
  });
  const installs = await listWorkspaceMarketInstalls(workspace.id);
  const installByListing = new Map(
    installs.map((install) => [install.listingId, install]),
  );
  const base = `/app/${encodeURIComponent(slug)}/market`;
  return (
    <DashboardPage className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("discoverTitle")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("discoverDescription")}
        </p>
        <ButtonLink href={`${base}/import`} variant="primary" size="md">
          {t("importResource")}
        </ButtonLink>
        <form
          action={base}
          method="get"
          className="flex max-w-4xl flex-wrap gap-2"
        >
          <label className="sr-only" htmlFor="resource-query">
            {common("search")}
          </label>
          <input
            id="resource-query"
            name="q"
            defaultValue={q}
            placeholder={t("search")}
            maxLength={200}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <Button type="submit" variant="secondary" size="md">
            {common("search")}
          </Button>
          <details
            className="basis-full min-w-0 rounded-md border border-border px-3 py-2"
            open={Boolean(type || sourceKind || target)}
          >
            <summary className="cursor-pointer text-sm font-medium">
              {t("filterResources")}
            </summary>
            <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-3">
              <label
                className="grid min-w-0 gap-1 text-sm"
                htmlFor="resource-type"
              >
                {t("resourceTypes")}
                <select
                  id="resource-type"
                  name="type"
                  defaultValue={type}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t("resourceTypes")}</option>
                  <option value="mcp">{t("kindMcp")}</option>
                  <option value="skill">{t("kindSkill")}</option>
                  <option value="agent">{t("kindAgent")}</option>
                  <option value="assistant">{t("kindAssistant")}</option>
                  <option value="pi-package">{t("kindPiPackage")}</option>
                </select>
              </label>
              <label
                className="grid min-w-0 gap-1 text-sm"
                htmlFor="resource-source"
              >
                {t("sourceKindLabel")}
                <select
                  id="resource-source"
                  name="sourceKind"
                  defaultValue={sourceKind}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t("sourceKindLabel")}</option>
                  {SOURCE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(SOURCE_LABELS[kind])}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="grid min-w-0 gap-1 text-sm"
                htmlFor="resource-target"
              >
                {t("compatibleTarget")}
                <select
                  id="resource-target"
                  name="target"
                  defaultValue={target ?? ""}
                  className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t("compatibleTarget")}</option>
                  <option value="agent">{t("targetAgent")}</option>
                  <option value="assistant">{t("targetAssistant")}</option>
                </select>
              </label>
            </div>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="mt-3"
            >
              {common("search")}
            </Button>
          </details>
        </form>
      </header>
      <section className="space-y-3" aria-label={t("publishedResources")}>
        <h2 className="text-lg font-semibold">{t("publishedResources")}</h2>
        {result.items.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((item) => {
              const kindLabels = {
                mcp: "kindMcp",
                skill: "kindSkill",
                agent: "kindAgent",
                assistant: "kindAssistant",
                "pi-package": "kindPiPackage",
              } as const;
              const kindKey = kindLabels[item.kind as keyof typeof kindLabels];
              if (!kindKey) return null;
              const sourceKey = item.sourceKind
                ? SOURCE_LABELS[item.sourceKind as keyof typeof SOURCE_LABELS]
                : undefined;
              const runtime = item.runtimeCompatibility;
              const runtimeText =
                runtime?.runtime === "pi-sdk"
                  ? t("runtimePiSdkDetail", {
                      version: runtime.piVersion,
                      nodeMajor: runtime.nodeMajor,
                      target: `${runtime.platform}/${runtime.arch}`,
                    })
                  : runtime?.runtime === "mcp"
                    ? t(
                        runtime.transport === "stdio"
                          ? "runtimeMcpStdio"
                          : runtime.transport === "streamable-http"
                            ? "runtimeMcpStreamableHttp"
                            : "runtimeMcpSse",
                      )
                    : null;
              const installation = installByListing.get(item.id);
              const installationStatus =
                installation?.deployment && item.kind === "mcp"
                  ? effectiveStatus(
                      installation.deployment.id,
                      installation.deployment.status,
                    )
                  : installation?.status;
              const statusKey = installationStatus
                ? (
                    {
                      ready: "statusReady",
                      running: "statusRunning",
                      stopped: "statusStopped",
                      setup_required: "statusSetupRequired",
                      modified: "statusModified",
                      error: "statusError",
                    } as const
                  )[
                    installationStatus as
                      | "ready"
                      | "running"
                      | "stopped"
                      | "setup_required"
                      | "modified"
                      | "error"
                  ]
                : undefined;
              return (
                <article
                  key={`${item.kind}:${item.id}`}
                  className="min-w-0 rounded-lg border border-border p-4"
                >
                  <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>{t(kindKey)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t("sourceMarket")}</span>
                  </p>
                  <h3 className="mt-1 truncate font-semibold">{item.name}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {item.summary}
                  </p>
                  {item.latestRelease ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("latestVersion", {
                        version: item.latestRelease.version,
                      })}
                    </p>
                  ) : null}
                  {sourceKey ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("sourceKindLabel")}: {t(sourceKey)}
                    </p>
                  ) : null}
                  {runtimeText ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {runtimeText}
                    </p>
                  ) : null}
                  {installation ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("installedResources")} ·{" "}
                      {t("installedVersion", {
                        version: installation.currentRelease.version,
                      })}{" "}
                      · {statusKey ? t(statusKey) : installationStatus}
                      {installation.updateAvailable
                        ? ` · ${t("updateAvailable")}`
                        : ""}
                    </p>
                  ) : null}
                  <ButtonLink
                    className="mt-3"
                    href={
                      item.kind === "agent"
                        ? `${base}/agents/${encodeURIComponent(item.id)}`
                        : `${base}/items/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.slug)}`
                    }
                    variant="ghost"
                    size="sm"
                  >
                    {t("viewDetails")}
                  </ButtonLink>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("noPublishedResources")}
          </p>
        )}
        {result.total > result.pageSize ? (
          <nav
            aria-label={t("navigation")}
            className="flex items-center justify-between gap-3"
          >
            {page > 1 ? (
              <ButtonLink
                href={`${base}?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}), ...(sourceKind ? { sourceKind } : {}), ...(target ? { target } : {}), page: String(page - 1) })}`}
                variant="ghost"
                size="sm"
              >
                {common("previous")}
              </ButtonLink>
            ) : (
              <Button type="button" disabled variant="ghost" size="sm">
                {common("previous")}
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              {t("pageOf", {
                page,
                total: Math.ceil(result.total / result.pageSize),
              })}
            </span>
            {page < Math.ceil(result.total / result.pageSize) ? (
              <ButtonLink
                href={`${base}?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}), ...(sourceKind ? { sourceKind } : {}), ...(target ? { target } : {}), page: String(page + 1) })}`}
                variant="ghost"
                size="sm"
              >
                {common("next")}
              </ButtonLink>
            ) : (
              <Button type="button" disabled variant="ghost" size="sm">
                {common("next")}
              </Button>
            )}
          </nav>
        ) : null}
      </section>
    </DashboardPage>
  );
}
