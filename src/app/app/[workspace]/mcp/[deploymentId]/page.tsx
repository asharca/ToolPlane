import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { McpHttpApprovalForm } from "@/components/dashboard/McpHttpConsent";
import { RemoteMcpTransportNotice } from "@/components/dashboard/RemoteMcpTransportNotice";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CopyPlus,
  KeyRound,
  LogIn,
  Pause,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { originFromHeaders } from "@/lib/http/origin";
import {
  effectiveStatus,
  getDeploymentRuntimeLogChunk,
  getDeploymentRuntimeSnapshot,
} from "@/lib/process/supervisor";
import { listMcpTools } from "@/lib/process/mcp-client";
import {
  hasMcpToolCatalog,
  readMcpToolCatalog,
} from "@/lib/process/mcp-tool-catalog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { ConnectDialog } from "@/components/dashboard/ConnectDialog";
import { TabBar } from "@/components/dashboard/TabBar";
import { ToolPlayground } from "@/components/dashboard/ToolPlayground";
import {
  startDeploymentAction,
  stopDeploymentAction,
  restartDeploymentAction,
  rebuildDeploymentAction,
  removeDeploymentAction,
  renameDeploymentAction,
  cloneDeploymentAction,
} from "@/lib/workspace/actions";
import {
  deploymentLabel,
  deploymentPinnedPackage,
  packageSelectorVersion,
} from "@/lib/workspace/deployment-label";
import { VariablesEditor } from "@/components/dashboard/VariablesEditor";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { ContainerLogs } from "@/components/dashboard/ContainerLogs";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import {
  McpConfigDocumentEditor,
  McpConfigResolvedPanel,
  McpConfigVariablesPanel,
} from "@/components/dashboard/McpConfigDocumentEditor";
import { McpConfigRevisions } from "@/components/dashboard/McpConfigRevisions";
import { McpRuntimeTargetControl } from "@/components/dashboard/McpRuntimeTargetControl";
import { McpSamplingToggle } from "@/components/dashboard/McpSamplingToggle";
import { McpToolExposureEditor } from "@/components/dashboard/McpToolExposureEditor";
import { McpSandboxPlacementEditor } from "@/components/dashboard/McpSandboxPlacementEditor";
import {
  mcpRunsInAgentSandbox,
  supportsAgentSandboxPlacement,
} from "@/lib/process/mcp-definition";
import {
  McpConnectedChips,
  type McpConnectedObject,
} from "@/components/dashboard/McpConnectedChips";
import { RuntimeFilesEditor } from "@/components/dashboard/RuntimeFilesEditor";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { getMcpConfigAction } from "@/lib/workspace/mcp-config-actions";
import type { McpRuntimeTarget } from "@/lib/workspace/mcp-config-types";
import {
  parseServerRecipe,
  storedRequiredEnvironment,
} from "@/lib/workspace/server-recipe";
import { mcpEnvironmentState } from "@/lib/workspace/mcp-environment";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import { McpOAuthConnectionPanel } from "@/components/dashboard/McpOAuthConnectionPanel";
import { getMcpOAuthConnectionSummary } from "@/lib/remote-mcp/oauth-status";

export const dynamic = "force-dynamic";

function fmtDate(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(
    d,
    timeZone,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    locale,
  );
}

const TRANSITIONING_STATUSES: Record<string, true> = {
  provisioning: true,
  copying: true,
  restoring: true,
  upgrading: true,
  deleting: true,
};

const KNOWN_SOURCES: Record<string, true> = {
  catalog: true,
  custom: true,
  config: true,
  docker: true,
  remote: true,
  npm: true,
  pypi: true,
  github: true,
};

export default async function DeploymentInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const [t, common, locale] = await Promise.all([
    getTranslations("console.mcp"),
    getTranslations("common"),
    getLocale(),
  ]);
  const { workspace: slug, deploymentId } = await params;
  const { tab, error: queryError } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await resolveWorkspaceScope({ slug }, user.id);
  if (!ws) redirect("/app");

  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ws.id },
    include: {
      server: {
        select: {
          name: true,
          slug: true,
          author: true,
          description: true,
          readme: true,
          verifiedTools: true,
          installCfg: true,
        },
      },
      configFiles: {
        select: { id: true, path: true, size: true, updatedAt: true },
        orderBy: { path: "asc" },
      },
    },
  });
  if (!dep) notFound();
  const [usingAgents, usingAssistants, { allowHttp }, oauthSummary] =
    await Promise.all([
      db.agent.findMany({
        where: {
          workspaceId: ws.id,
          retiredAt: null,
          servers: { some: { deploymentId } },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      db.chatAssistant.findMany({
        where: { workspaceId: ws.id, mcpGrants: { some: { deploymentId } } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      getTransportSettings(),
      getMcpOAuthConnectionSummary({
        workspaceId: ws.id,
        workspaceSlug: slug,
        deploymentId,
      }),
    ]);
  const connected: McpConnectedObject[] = [
    ...usingAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: "agent" as const,
      href: `/app/${slug}/agents/${agent.id}`,
    })),
    ...usingAssistants.map((assistant) => ({
      id: assistant.id,
      name: assistant.name,
      kind: "assistant" as const,
      href: `/app/${slug}/chat?assistant=${encodeURIComponent(assistant.id)}&settings=1`,
    })),
  ];

  const label = deploymentLabel(dep);
  const pinnedPackage = deploymentPinnedPackage(dep);
  const pinnedVersion = pinnedPackage
    ? packageSelectorVersion(pinnedPackage)
    : null;
  const defaultCloneName = t("copyNameDefault", {
    name: label.name.slice(0, 75).trimEnd(),
  });
  const envCfg = (dep.installCfg ?? {}) as {
    network?: string;
    command?: string;
    args?: string[];
  };
  const environmentState = mcpEnvironmentState(dep.installCfg);
  const declaredEnvironment =
    parseServerRecipe(dep.server?.installCfg)?.env ??
    storedRequiredEnvironment(dep.installCfg);
  const variableKeys = [
    ...new Set([...declaredEnvironment, ...Object.keys(environmentState)]),
  ].sort((left, right) => left.localeCompare(right));
  const envRows = variableKeys.map((key) => ({
    key,
    configured: Boolean(environmentState[key]),
    required: declaredEnvironment.includes(key),
  }));
  const missingRequiredVariables = envRows.filter(
    (row) => row.required && !row.configured,
  );
  const canManage = ws.role === "owner" || ws.role === "admin";
  const status = effectiveStatus(deploymentId, dep.status);
  const running = status === "running";
  const transitioning = Boolean(TRANSITIONING_STATUSES[status]);

  const requestedTab = tab === "variables" ? "configuration" : tab;
  const deploymentToolCatalogKnown = hasMcpToolCatalog(dep.installCfg);
  const serverToolCatalogKnown =
    dep.source !== "remote" && hasMcpToolCatalog(dep.server?.installCfg);
  const savedTools = deploymentToolCatalogKnown
    ? readMcpToolCatalog(dep.installCfg)
    : serverToolCatalogKnown
      ? readMcpToolCatalog(dep.server?.installCfg)
      : [];

  const preliminaryTab =
    requestedTab === "tools" ||
    requestedTab === "configuration" ||
    requestedTab === "runtime" ||
    requestedTab === "settings"
      ? requestedTab
      : "overview";

  let discoveryFailed = false;
  const liveTools =
    running && preliminaryTab === "tools"
      ? await listMcpTools(deploymentId).catch(() => {
          discoveryFailed = true;
          return [];
        })
      : [];
  const refreshedConfig =
    running && preliminaryTab === "tools" && liveTools.length === 0
      ? await db.deployment.findFirst({
          where: { id: deploymentId, workspaceId: ws.id },
          select: { installCfg: true },
        })
      : null;
  const tools =
    running && preliminaryTab === "tools"
      ? liveTools.length
        ? liveTools
        : hasMcpToolCatalog(refreshedConfig?.installCfg)
          ? readMcpToolCatalog(refreshedConfig?.installCfg)
          : savedTools
      : savedTools;

  const knownToolCount =
    running && preliminaryTab === "tools"
      ? tools.length
      : deploymentToolCatalogKnown || serverToolCatalogKnown
        ? savedTools.length
        : dep.server?.verifiedTools;

  const tabs = [
    { key: "overview", label: t("overview") },
    {
      key: "tools",
      label: t("tools"),
      count: typeof knownToolCount === "number" ? knownToolCount : undefined,
    },
    { key: "configuration", label: t("configuration") },
    { key: "runtime", label: t("logs") },
    { key: "settings", label: t("settings") },
  ];
  const current =
    tabs.find((item) => item.key === preliminaryTab)?.key ?? "overview";

  const configResult =
    dep.source !== null &&
    (current === "configuration" || current === "settings")
      ? await getMcpConfigAction({ workspace: slug, deploymentId })
      : null;
  const configView = configResult?.ok ? configResult.view : null;
  const runtimeSnapshot =
    current === "runtime" ? getDeploymentRuntimeSnapshot(deploymentId) : null;
  const initialRuntimeLogs =
    current === "runtime"
      ? getDeploymentRuntimeLogChunk(deploymentId, { limit: 64 * 1024 })
      : null;
  const playgroundAvailable = running;

  const endpoint = `${originFromHeaders(await headers())}/api/v1/mcp/${deploymentId}/rpc`;
  const listHref = `/app/${encodeURIComponent(slug)}/mcp`;
  const base = `/app/${slug}/mcp/${deploymentId}`;
  const provisioning = status === "provisioning";
  const setupRequired =
    status === "setup_required" &&
    (oauthSummary !== null ||
      !(
        allowHttp &&
        dep.source === "remote" &&
        dep.sourceRef?.startsWith("http:") &&
        missingRequiredVariables.length === 0
      ));
  const runtimePolling = provisioning || running;
  const sourceLabel = KNOWN_SOURCES[label.source]
    ? t(`source.${label.source}`)
    : label.source;
  const networkLabel =
    envCfg.network === "none" ? t("networkNone") : t("networkIsolated");
  const aboutMarkdown = dep.server?.readme?.trim() || null;
  const aboutDescription = dep.server?.description?.trim() || null;
  const commandSummary =
    envCfg.command && Array.isArray(envCfg.args)
      ? [envCfg.command, ...envCfg.args].join(" ")
      : (envCfg.command ?? null);
  const targetSummary = pinnedPackage ?? label.ref ?? commandSummary ?? null;
  const showStatusNotice = setupRequired || status === "error" || transitioning;

  return (
    <>
      <ProvisioningRefresher
        active={runtimePolling}
        deploymentId={deploymentId}
        initialStatus={status}
      />
      <DashboardPage className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
        {dep.source === "remote" &&
        dep.sourceRef?.startsWith("http:") &&
        !allowHttp &&
        (dep.installCfg as { allowUnsafeHttp?: boolean } | null)
          ?.allowUnsafeHttp !== true ? (
          <McpHttpApprovalForm
            workspace={slug}
            deploymentId={deploymentId}
            url={dep.sourceRef}
          />
        ) : dep.source === "remote" ? (
          <RemoteMcpTransportNotice url={dep.sourceRef} />
        ) : null}

        <header className="space-y-3">
          <Link
            href={listHref}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("title")}
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
                <Plug className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1
                    title={label.name}
                    className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
                  >
                    {label.name}
                  </h1>
                  <StatusBadge status={status} />
                  <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                    {sourceLabel}
                  </AnimatedBadge>
                </div>
                {targetSummary ? (
                  <p
                    title={targetSummary}
                    className="mt-1 max-w-2xl truncate font-mono text-xs text-muted-foreground"
                  >
                    {targetSummary}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <ConnectDialog
                  endpoint={endpoint}
                  name={label.name}
                  label={t("connect")}
                  variant="banner"
                />
              ) : null}
              {transitioning ? (
                <>
                  <ButtonLink
                    href={`${base}?tab=runtime`}
                    variant="secondary"
                    size="sm"
                  >
                    {t("viewRuntimeLogs")}
                  </ButtonLink>
                  {status !== "deleting" ? (
                    <form action={stopDeploymentAction}>
                      <input type="hidden" name="workspace" value={slug} />
                      <input
                        type="hidden"
                        name="deploymentId"
                        value={deploymentId}
                      />
                      <SubmitButton
                        flash={false}
                        pendingLabel={t("stopping")}
                        variant="secondary"
                        size="sm"
                      >
                        <Pause className="size-3.5" />
                        {t("stop")}
                      </SubmitButton>
                    </form>
                  ) : null}
                </>
              ) : setupRequired ? (
                oauthSummary ? (
                  <ButtonLink
                    href={oauthSummary.startUrl}
                    variant="primary"
                    size="sm"
                  >
                    <LogIn className="size-4" aria-hidden="true" />
                    {oauthSummary.status === "reauth_required"
                      ? t("oauth.reSignIn")
                      : t("oauth.signIn")}
                  </ButtonLink>
                ) : (
                  <ButtonLink
                    href={`${base}?tab=configuration#variables`}
                    variant="primary"
                    size="sm"
                  >
                    <KeyRound className="size-4" />
                    {t("configureVariables")}
                  </ButtonLink>
                )
              ) : running ? (
                <>
                  <form action={restartDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input
                      type="hidden"
                      name="deploymentId"
                      value={deploymentId}
                    />
                    <SubmitButton
                      flash={false}
                      pendingLabel={t("restarting")}
                      variant="secondary"
                      size="sm"
                    >
                      <RotateCcw className="size-3.5" />
                      {t("restart")}
                    </SubmitButton>
                  </form>
                  <form action={stopDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input
                      type="hidden"
                      name="deploymentId"
                      value={deploymentId}
                    />
                    <SubmitButton
                      flash={false}
                      pendingLabel={t("stopping")}
                      variant="secondary"
                      size="sm"
                    >
                      <Pause className="size-3.5" />
                      {t("stop")}
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <form action={startDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input
                    type="hidden"
                    name="deploymentId"
                    value={deploymentId}
                  />
                  <SubmitButton
                    flash={false}
                    pendingLabel={t("starting")}
                    variant="primary"
                    size="sm"
                  >
                    <Play className="size-3.5" />
                    {t("start")}
                  </SubmitButton>
                </form>
              )}
              {status === "error" ? (
                <ButtonLink
                  href={`${base}?tab=runtime`}
                  variant="secondary"
                  size="sm"
                >
                  {t("viewRuntimeLogs")}
                </ButtonLink>
              ) : null}
            </div>
          </div>
        </header>

        {showStatusNotice ? (
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm ${
              status === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : setupRequired
                  ? "border-amber-500/30 bg-amber-500/[0.07] text-foreground"
                  : "border-border bg-muted/40 text-muted-foreground"
            }`}
          >
            <span>
              {setupRequired
                ? oauthSummary
                  ? oauthSummary.status === "reauth_required"
                    ? t("oauth.reauthRequiredBanner")
                    : t("oauth.signInRequiredBanner")
                  : t("variablesNeedAttention", {
                      count: missingRequiredVariables.length,
                    })
                : transitioning
                  ? t("runtimeStartingDescription")
                  : t("runtimeErrorDescription")}
            </span>
            {setupRequired &&
            !oauthSummary &&
            missingRequiredVariables.length ? (
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {missingRequiredVariables.map((row) => (
                  <code
                    key={row.key}
                    className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-xs text-foreground"
                  >
                    {row.key}
                  </code>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="-mx-4 overflow-hidden px-4 sm:mx-0 sm:px-0">
          <TabBar tabs={tabs} current={current} basePath={base} />
        </div>

        {current === "overview" ? (
          <div className="max-w-4xl space-y-5">
            {oauthSummary ? (
              <McpOAuthConnectionPanel
                workspace={slug}
                deploymentId={deploymentId}
                summary={oauthSummary}
              />
            ) : null}

            <section
              aria-label={t("connectionDetails")}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <dl className="grid grid-cols-2 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <div className="min-w-0 px-5 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {pinnedVersion
                      ? t("pinnedVersion")
                      : commandSummary && dep.source !== "remote"
                        ? t("startCommand")
                        : t("sourceLabel")}
                  </dt>
                  <dd
                    title={pinnedPackage ?? commandSummary ?? sourceLabel}
                    className={`mt-1 truncate text-sm font-medium text-foreground ${
                      pinnedVersion ||
                      (commandSummary && dep.source !== "remote")
                        ? "font-mono text-xs leading-5"
                        : ""
                    }`}
                  >
                    {pinnedVersion ??
                      (dep.source !== "remote" && commandSummary
                        ? commandSummary
                        : sourceLabel)}
                  </dd>
                </div>

                <div className="min-w-0 px-5 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t("tools")}
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">
                    {typeof knownToolCount === "number" ? (
                      <Link
                        href={`${base}?tab=tools`}
                        className="hover:underline"
                      >
                        {knownToolCount.toLocaleString(locale)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>

                <div className="min-w-0 px-5 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t("network")}
                  </dt>
                  <dd className="mt-1 truncate text-sm font-medium text-foreground">
                    {networkLabel}
                  </dd>
                </div>

                <div className="min-w-0 px-5 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t("created")}
                  </dt>
                  <dd
                    title={`${t("updated")}: ${fmtDate(dep.updatedAt, timeZone, locale)}`}
                    className="mt-1 truncate text-sm font-medium text-foreground"
                  >
                    {fmtDate(dep.createdAt, timeZone, locale)}
                  </dd>
                </div>
              </dl>

              <div className="space-y-4 border-t border-border px-5 py-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("endpoint")}
                    </span>
                    <Link
                      href={`/app/${slug}/settings/tokens`}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <KeyRound className="size-3.5" aria-hidden="true" />
                      {t("manageTokens")}
                    </Link>
                  </div>
                  <div className="mt-1.5 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 py-1 pr-1 pl-3">
                    <code
                      title={endpoint}
                      className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                    >
                      {endpoint}
                    </code>
                    <CopyButton text={endpoint} />
                  </div>
                </div>

                {dep.server?.author ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("author")}:</span>
                    <span className="font-medium text-foreground">
                      {dep.server.author}
                    </span>
                  </div>
                ) : null}

                {connected.length ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("connectedTo")}
                    </span>
                    <McpConnectedChips objects={connected} />
                  </div>
                ) : null}
              </div>
            </section>

            {aboutMarkdown || aboutDescription ? (
              <DashboardPanel
                title={t("aboutThisMcp")}
                bodyClassName="px-5 py-5 sm:px-6"
              >
                {aboutMarkdown ? (
                  <SafeStreamdown
                    mode="static"
                    linkSafety={{ enabled: true }}
                    className="max-w-3xl text-sm leading-7 text-foreground [&_[data-streamdown=heading-1]]:mt-0 [&_[data-streamdown=heading-1]]:text-xl [&_[data-streamdown=heading-2]]:text-lg [&_[data-streamdown=heading-3]]:text-base"
                  >
                    {aboutMarkdown}
                  </SafeStreamdown>
                ) : (
                  <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
                    {aboutDescription}
                  </p>
                )}
              </DashboardPanel>
            ) : null}
          </div>
        ) : null}

        {current === "configuration" ? (
          dep.source !== null && configView ? (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="min-w-0 space-y-6">
                <McpConfigDocumentEditor
                  key={configView.activeRevisionId}
                  workspace={slug}
                  deploymentId={deploymentId}
                  view={configView}
                />
                <McpConfigRevisions
                  workspace={slug}
                  deploymentId={deploymentId}
                  revisions={configView.revisions}
                  canManage={configView.canManage}
                />
              </div>
              <div className="min-w-0 space-y-6">
                <McpConfigVariablesPanel
                  key={JSON.stringify(configView.variables)}
                  workspace={slug}
                  deploymentId={deploymentId}
                  variables={configView.variables}
                  canManage={configView.canManage}
                />
                <McpConfigResolvedPanel
                  workspace={slug}
                  deploymentId={deploymentId}
                  resolved={configView.resolved}
                  canManage={configView.canManage}
                />
                {configView.kind !== "remote" ? (
                  <RuntimeFilesEditor
                    workspace={slug}
                    deploymentId={deploymentId}
                    relativePathArgumentsWork={
                      dep.source === "config" && envCfg.command !== "docker"
                    }
                    initialFiles={dep.configFiles.map((file) => ({
                      id: file.id,
                      path: file.path,
                      size: file.size,
                      updatedAt: file.updatedAt.toISOString(),
                    }))}
                  />
                ) : null}
                {supportsAgentSandboxPlacement(dep) ? (
                  <DashboardPanel
                    title={t("agentSandboxPlacement")}
                    description={t("agentSandboxPlacementDescription")}
                  >
                    <McpSandboxPlacementEditor
                      workspace={slug}
                      deploymentId={deploymentId}
                      initialEnabled={mcpRunsInAgentSandbox(dep)}
                    />
                  </DashboardPanel>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <VariablesEditor
                slug={slug}
                deploymentId={deploymentId}
                initial={envRows}
                canManage={canManage}
              />
              {supportsAgentSandboxPlacement(dep) ? (
                <DashboardPanel
                  title={t("agentSandboxPlacement")}
                  description={t("agentSandboxPlacementDescription")}
                  className="max-w-4xl"
                >
                  <McpSandboxPlacementEditor
                    workspace={slug}
                    deploymentId={deploymentId}
                    initialEnabled={mcpRunsInAgentSandbox(dep)}
                  />
                </DashboardPanel>
              ) : null}
            </div>
          )
        ) : null}

        {current === "tools" ? (
          <div className="max-w-4xl space-y-5">
            {discoveryFailed ? (
              <p
                role="alert"
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {t("toolDiscoveryFailed")}
              </p>
            ) : null}
            <McpToolExposureEditor
              workspace={slug}
              deploymentId={deploymentId}
              tools={tools}
              initialMode={dep.mcpToolExposure}
              initialAllowedTools={dep.mcpAllowedTools}
              initialPublicInvocable={dep.publicInvocable}
              editable={running}
              connected={connected}
              toolBasePath={`${base}/tools`}
            />

            {playgroundAvailable ? (
              <DashboardPanel title={t("manualToolTesting")}>
                <ToolPlayground
                  key={`runtime:${tools.map((tool) => tool.name).join("|")}`}
                  workspace={slug}
                  deploymentId={deploymentId}
                  tools={tools}
                  defaultRuntime
                />
              </DashboardPanel>
            ) : (
              <DashboardEmptyState
                icon={Wrench}
                title={
                  tools.length
                    ? t("toolTestingUnavailable")
                    : t("toolsUnavailable")
                }
                description={
                  tools.length
                    ? t("deploymentNotRunningTesting", { status })
                    : t("deploymentNotRunningTools", { status })
                }
                actions={
                  <ButtonLink
                    href={`${base}?tab=runtime`}
                    variant="secondary"
                    size="sm"
                  >
                    {t("viewRuntimeLogs")}
                  </ButtonLink>
                }
                className="min-h-40 rounded-xl border border-dashed border-border"
              />
            )}
          </div>
        ) : null}

        {current === "settings" ? (
          <div className="max-w-4xl space-y-5">
            <McpRuntimeTargetControl
              workspace={slug}
              deploymentId={deploymentId}
              kind={
                configView?.kind ??
                (dep.source === "remote" ? "remote" : "stdio")
              }
              initialTarget={
                configView?.runtime.target ??
                (dep as { runtimeTarget?: McpRuntimeTarget }).runtimeTarget ??
                "managed"
              }
              initialSandboxId={
                configView?.runtime.sandboxId ??
                (dep as { runtimeSandboxId?: string | null })
                  .runtimeSandboxId ??
                null
              }
              sandboxes={configView?.runtime.sandboxes ?? []}
              canManage={configView?.canManage ?? canManage}
            />

            <McpSamplingToggle
              workspace={slug}
              deploymentId={deploymentId}
              initialEnabled={
                configView?.samplingEnabled ??
                Boolean((dep as { samplingEnabled?: boolean }).samplingEnabled)
              }
              canManage={configView?.canManage ?? canManage}
            />

            <DashboardPanel
              title={t("generalSettings")}
              description={t("renameMcpDescription")}
            >
              <form
                action={renameDeploymentAction}
                className="flex max-w-xl flex-col items-stretch gap-3 sm:flex-row sm:items-end"
              >
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <label
                  htmlFor="deployment-name"
                  className="min-w-0 flex-1 space-y-1.5 text-xs font-medium text-muted-foreground"
                >
                  {t("mcpName")}
                  <Input
                    id="deployment-name"
                    name="name"
                    defaultValue={label.name}
                    required
                    maxLength={80}
                    pattern=".*\S.*"
                    title={t("nameCannotBeBlank")}
                    className="min-w-0"
                  />
                </label>
                <SubmitButton
                  pendingLabel={t("renaming")}
                  savedLabel={t("renamed")}
                  variant="secondary"
                  size="sm"
                >
                  <Pencil className="size-3.5" />
                  {t("rename")}
                </SubmitButton>
              </form>
            </DashboardPanel>

            <DashboardPanel
              title={t("cloneMcp")}
              description={t("cloneMcpDescription")}
            >
              {queryError === "mcpVersionResolutionFailed" ? (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  {t("mcpVersionResolutionFailed")}
                </p>
              ) : null}
              <form
                action={cloneDeploymentAction}
                className="max-w-xl space-y-4"
              >
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <input
                  type="hidden"
                  name="copyEnvironmentVariables"
                  value="false"
                />
                <input type="hidden" name="copyRuntimeFiles" value="false" />
                <label
                  htmlFor="deployment-copy-name"
                  className="block space-y-1.5 text-xs font-medium text-muted-foreground"
                >
                  {t("copyName")}
                  <Input
                    id="deployment-copy-name"
                    name="name"
                    defaultValue={defaultCloneName}
                    required
                    maxLength={80}
                    pattern=".*\S.*"
                    title={t("nameCannotBeBlank")}
                  />
                </label>
                <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  {t("cloneSensitiveDataHint")}
                </p>
                <div className="space-y-2.5">
                  <div className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                    <FormCheckbox
                      name="copyEnvironmentVariables"
                      value="true"
                      defaultChecked
                      label={t("copyEnvironmentVariables")}
                    />
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t("copyEnvironmentVariablesDescription")}
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                    <FormCheckbox
                      name="copyRuntimeFiles"
                      value="true"
                      defaultChecked
                      label={t("copyRuntimeFiles")}
                    />
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t("copyRuntimeFilesDescription")}
                    </span>
                  </div>
                </div>
                <SubmitButton
                  flash={false}
                  pendingLabel={t("cloning")}
                  variant="secondary"
                  size="sm"
                >
                  <CopyPlus className="size-3.5" />
                  {t("clone")}
                </SubmitButton>
              </form>
            </DashboardPanel>

            <DashboardPanel
              title={t("maintenance")}
              description={t("maintenanceDescription")}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <Activity className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                    {t("rebuildDescription")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {running ? (
                    <form action={restartDeploymentAction}>
                      <input type="hidden" name="workspace" value={slug} />
                      <input
                        type="hidden"
                        name="deploymentId"
                        value={deploymentId}
                      />
                      <SubmitButton
                        flash={false}
                        pendingLabel={t("restarting")}
                        variant="secondary"
                        size="sm"
                      >
                        <RefreshCw className="size-3.5" />
                        {t("restart")}
                      </SubmitButton>
                    </form>
                  ) : null}
                  <form action={rebuildDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input
                      type="hidden"
                      name="deploymentId"
                      value={deploymentId}
                    />
                    <SubmitButton
                      flash={false}
                      pendingLabel={t("rebuilding")}
                      variant="secondary"
                      size="sm"
                    >
                      <RefreshCw className="size-3.5" />
                      {t("rebuild")}
                    </SubmitButton>
                  </form>
                </div>
              </div>
            </DashboardPanel>

            <DashboardPanel
              title={t("dangerZone")}
              description={t("removeMcpDescription")}
              tone="danger"
              bodyClassName="py-4"
            >
              <form
                action={removeDeploymentAction}
                className="flex flex-wrap items-center justify-between gap-4"
              >
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t("removeMcpWarning")}
                </p>
                <ConfirmSubmitButton
                  triggerLabel={t("remove")}
                  confirmLabel={common("confirm")}
                  cancelLabel={common("cancel")}
                  prompt={t("removeMcpPrompt", { name: label.name })}
                  pendingLabel={t("removing")}
                  className="items-center"
                  triggerVariant="secondary"
                  triggerSize="sm"
                  triggerClassName="inline-flex items-center"
                  confirmVariant="secondary"
                  confirmSize="sm"
                  confirmClassName="inline-flex items-center"
                  cancelVariant="secondary"
                  cancelSize="sm"
                />
              </form>
            </DashboardPanel>
          </div>
        ) : null}

        {current === "runtime" ? (
          <section
            id="runtime-logs"
            className="max-w-4xl scroll-mt-6 rounded-xl border border-border bg-card p-5"
          >
            <ContainerLogs
              key={`${deploymentId}:${runtimeSnapshot?.generation ?? status}`}
              deploymentId={deploymentId}
              initialSnapshot={runtimeSnapshot}
              initialLogs={initialRuntimeLogs}
              initialStatus={status}
              title={t("runtimeLogs")}
              refreshLabel={t("refreshLogs")}
              emptyLabel={t("noRuntimeLogsYet")}
              unavailableLabel={t("runtimeUnavailable")}
              statusLabel={t("runtimeStatus")}
              phaseLabel={t("runtimePhase")}
              imageStateLabel={t("runtimeImageState")}
              containerStateLabel={t("runtimeContainerState")}
              syncErrorLabel={t("runtimeLogSyncFailed")}
              truncatedLabel={t("runtimeLogTruncated")}
            />
          </section>
        ) : null}
      </DashboardPage>
    </>
  );
}
