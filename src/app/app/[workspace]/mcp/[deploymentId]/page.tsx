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
  CopyPlus,
  KeyRound,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
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
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { VariablesEditor } from "@/components/dashboard/VariablesEditor";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { getDeploymentLogs } from "@/lib/observability/log";
import { DeploymentLogs } from "@/components/dashboard/DeploymentLogs";
import { ContainerLogs } from "@/components/dashboard/ContainerLogs";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { McpJsonConfigEditor } from "@/components/dashboard/McpJsonConfigEditor";
import { McpToolExposureEditor } from "@/components/dashboard/McpToolExposureEditor";
import { McpToolCatalog } from "@/components/dashboard/McpToolCatalog";
import { RuntimeFilesEditor } from "@/components/dashboard/RuntimeFilesEditor";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import {
  isEditableMcpSource,
  serializeMcpDeploymentConfig,
} from "@/lib/workspace/custom-mcp";
import {
  parseServerRecipe,
  storedRequiredEnvironment,
} from "@/lib/workspace/server-recipe";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";

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

function fmtTime(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(
    d,
    timeZone,
    {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
    locale,
  );
}

const transitioningStatuses = new Set([
  "provisioning",
  "copying",
  "restoring",
  "upgrading",
  "deleting",
]);

export default async function DeploymentInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [t, common, locale] = await Promise.all([
    getTranslations("console.mcp"),
    getTranslations("common"),
    getLocale(),
  ]);
  const { workspace: slug, deploymentId } = await params;
  const { tab } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
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

  const editableConfiguration = isEditableMcpSource(dep.source);
  const baseTabs = [
    { key: "overview", label: t("overview") },
    { key: "tools", label: t("tools") },
    { key: "logs", label: t("mcpCallLogs") },
    { key: "runtime", label: t("runtimeLogs") },
    ...(editableConfiguration
      ? [{ key: "configuration", label: t("configuration") }]
      : []),
    { key: "variables", label: t("variables") },
    { key: "settings", label: t("settings") },
  ];
  const tabs = baseTabs;
  const current = tabs.find((item) => item.key === tab)?.key ?? "overview";

  const label = deploymentLabel(dep);
  const defaultCloneName = t("copyNameDefault", {
    name: label.name.slice(0, 75).trimEnd(),
  });
  const envCfg = (dep.installCfg ?? {}) as {
    env?: Record<string, string>;
    network?: string;
    command?: string;
  };
  const declaredEnvironment =
    parseServerRecipe(dep.server?.installCfg)?.env ??
    storedRequiredEnvironment(dep.installCfg);
  const variableKeys = [
    ...new Set([...declaredEnvironment, ...Object.keys(envCfg.env ?? {})]),
  ].sort((left, right) => left.localeCompare(right));
  const envRows = variableKeys.map((key) => ({
    key,
    configured: Boolean(envCfg.env?.[key]?.trim()),
    required: declaredEnvironment.includes(key),
  }));
  const missingRequiredVariables = envRows.filter(
    (row) => row.required && !row.configured,
  );
  const configuredVariables = envRows.filter((row) => row.configured).length;
  // Credentials live in Variables after the initial deployment. Keep the
  // editable runtime config focused on commands, references, and networking.
  const serializedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, { includeEnv: false })
    : "";
  const maskedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, {
        maskSecrets: true,
        includeEnv: false,
      })
    : "";

  const status = effectiveStatus(deploymentId, dep.status);
  const running = status === "running";
  const transitioning = transitioningStatuses.has(status);
  let discoveryFailed = false;
  const liveTools =
    running && current === "tools"
      ? await listMcpTools(deploymentId).catch(() => {
          discoveryFailed = true;
          return [];
        })
      : [];
  const deploymentToolCatalogKnown = hasMcpToolCatalog(dep.installCfg);
  const serverToolCatalogKnown =
    dep.source !== "remote" && hasMcpToolCatalog(dep.server?.installCfg);
  const savedTools = deploymentToolCatalogKnown
    ? readMcpToolCatalog(dep.installCfg)
    : serverToolCatalogKnown
      ? readMcpToolCatalog(dep.server?.installCfg)
      : [];
  const refreshedConfig =
    running && current === "tools" && liveTools.length === 0
      ? await db.deployment.findFirst({
          where: { id: deploymentId, workspaceId: ws.id },
          select: { installCfg: true },
        })
      : null;
  const tools =
    running && current === "tools"
      ? liveTools.length
        ? liveTools
        : hasMcpToolCatalog(refreshedConfig?.installCfg)
          ? readMcpToolCatalog(refreshedConfig?.installCfg)
          : savedTools
      : savedTools;
  const logs =
    current === "logs"
      ? await getDeploymentLogs(ws.id, deploymentId, 100, user.id)
      : [];
  const runtimeSnapshot =
    current === "runtime" ? getDeploymentRuntimeSnapshot(deploymentId) : null;
  const initialRuntimeLogs =
    current === "runtime"
      ? getDeploymentRuntimeLogChunk(deploymentId, { limit: 64 * 1024 })
      : null;
  const playgroundAvailable = running;

  const endpoint = `${originFromHeaders(await headers())}/api/v1/mcp/${deploymentId}/rpc`;
  const base = `/app/${slug}/mcp/${deploymentId}`;
  const provisioning = status === "provisioning";
  const setupRequired = status === "setup_required";
  const runtimePolling = provisioning || running;
  const sourceLabel =
    label.source === "catalog"
      ? t("catalog")
      : ["custom", "config", "docker"].includes(label.source)
        ? t(`source.${label.source}`)
        : label.source;
  const networkLabel =
    envCfg.network === "none" ? t("networkNone") : t("networkIsolated");
  const knownToolCount =
    running && current === "tools"
      ? tools.length
      : deploymentToolCatalogKnown || serverToolCatalogKnown
        ? savedTools.length
        : dep.server?.verifiedTools;
  const toolCatalogLabels = {
    title: t("toolCatalog"),
    description: t("toolCatalogDescription"),
    count: t("toolsCount", { count: tools.length }),
    instructions: t("instructions"),
    inputSchema: t("inputSchema"),
    schemaJson: t("schemaJson"),
    parameter: t("parameter"),
    type: t("type"),
    descriptionColumn: t("descriptionColumn"),
    required: t("required"),
    defaultValue: t("defaultValue"),
    noDescription: t("noDescription"),
    noArguments: t("noArguments"),
  };

  return (
    <>
      <ProvisioningRefresher
        active={runtimePolling}
        deploymentId={deploymentId}
        initialStatus={status}
      />
      <DashboardPage className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
        <section className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                <Plug className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="break-words text-xl font-semibold tracking-tight text-foreground">
                    {label.name}
                  </h1>
                  <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                    {sourceLabel}
                  </AnimatedBadge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <StatusBadge status={status} />
                  {label.ref ? (
                    <code className="max-w-full truncate font-mono text-xs">
                      {label.ref}
                    </code>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <ConnectDialog
                  endpoint={endpoint}
                  name={label.name}
                  label={t("connect")}
                  variant="outline"
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
                        {t("stop")}
                      </SubmitButton>
                    </form>
                  ) : null}
                </>
              ) : setupRequired ? (
                <ButtonLink
                  href={`${base}?tab=variables`}
                  variant="primary"
                  size="sm"
                >
                  <KeyRound className="size-4" />
                  {t("configureVariables")}
                </ButtonLink>
              ) : running ? (
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
                    {t("stop")}
                  </SubmitButton>
                </form>
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
                    variant="secondary"
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
                  variant="primary"
                  size="sm"
                >
                  {t("viewRuntimeLogs")}
                </ButtonLink>
              ) : null}
            </div>
          </div>
        </section>
        {!running ? (
          <p
            role="status"
            className={`rounded-lg border border-border px-4 py-3 text-sm ${status === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
          >
            {setupRequired
              ? t("variablesNeedAttention", {
                  count: missingRequiredVariables.length,
                })
              : transitioning
                ? t("runtimeStartingDescription")
                : status === "error"
                  ? t("runtimeErrorDescription")
                  : t("stoppedNextStep")}
            {setupRequired && missingRequiredVariables.length
              ? ` ${missingRequiredVariables.map((row) => row.key).join(" · ")}`
              : null}
          </p>
        ) : null}

        <div className="-mx-4 overflow-hidden px-4 sm:mx-0 sm:px-0">
          <TabBar tabs={tabs} current={current} basePath={base} />
        </div>

        {current === "overview" ? (
          <div className="space-y-5">
            <DashboardPanel title={t("connectionDetails")}>
              <dl className="divide-y divide-border text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground">{t("endpoint")}</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <code
                      title={endpoint}
                      className="min-w-0 max-w-[20rem] truncate font-mono text-xs text-foreground"
                    >
                      {endpoint}
                    </code>
                    <CopyButton text={endpoint} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-3 last:pb-0">
                  <dt className="text-muted-foreground">{t("created")}</dt>
                  <dd className="text-foreground">
                    {fmtDate(dep.createdAt, timeZone, locale)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-3 last:pb-0">
                  <dt className="text-muted-foreground">{t("apiToken")}</dt>
                  <dd>
                    <Link
                      href={`/app/${slug}/settings/tokens`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline"
                    >
                      <KeyRound className="size-3.5" />
                      {t("manageTokens")}
                    </Link>
                  </dd>
                </div>
              </dl>
              <div className="py-3 text-muted-foreground">
                {t("configurationUpdatedAt", {
                  value: fmtDate(dep.updatedAt, timeZone, locale),
                })}
              </div>
            </DashboardPanel>
            <DashboardPanel
              title={t("aboutThisMcp")}
              description={dep.server?.description ?? undefined}
            >
              {dep.server?.readme ? (
                <SafeStreamdown
                  mode="static"
                  linkSafety={{ enabled: true }}
                  className="prose prose-sm max-h-[42rem] max-w-none overflow-auto leading-7 dark:prose-invert"
                >
                  {dep.server.readme}
                </SafeStreamdown>
              ) : dep.server?.description ? null : (
                <p className="text-sm text-muted-foreground">
                  {t("noDescription")}
                </p>
              )}
              <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                {dep.server?.author ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("author")}
                    </dt>
                    <dd className="mt-1 font-medium text-foreground">
                      {dep.server.author}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("sourceLabel")}
                  </dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {sourceLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("network")}
                  </dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {networkLabel}
                  </dd>
                </div>
                {typeof knownToolCount === "number" ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("tools")}
                    </dt>
                    <dd className="mt-1 font-medium text-foreground">
                      {knownToolCount.toLocaleString(locale)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </DashboardPanel>
          </div>
        ) : null}

        {current === "variables" ? (
          <VariablesEditor
            slug={slug}
            deploymentId={deploymentId}
            initial={envRows}
          />
        ) : null}

        {current === "configuration" && editableConfiguration ? (
          <div className="space-y-6">
            <McpJsonConfigEditor
              slug={slug}
              deploymentId={deploymentId}
              maskedConfig={maskedConfig}
              requiresReveal={serializedConfig !== maskedConfig}
              initialNetwork={envCfg.network === "none" ? "none" : "isolated"}
              warnAboutPackageInstall={dep.source !== "docker"}
              variablesHref={`${base}?tab=variables`}
              configuredVariables={configuredVariables}
            />
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
          </div>
        ) : null}

        {current === "tools" ? (
          <div className="space-y-6">
            {discoveryFailed ? (
              <p role="alert" className="text-sm text-destructive">
                {t("toolDiscoveryFailed")}
              </p>
            ) : null}
            {tools.length ? (
              <McpToolCatalog
                tools={tools}
                labels={toolCatalogLabels}
                compact
                hrefForTool={(toolName) =>
                  `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(deploymentId)}/tools/${encodeURIComponent(toolName)}`
                }
              />
            ) : null}

            <section className="rounded-xl border border-border bg-card overflow-hidden">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex min-w-0 items-start gap-2.5">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      {t("toolAccess")}
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t("toolAccessDescription")}
                    </p>
                  </div>
                </div>
                {running ? (
                  <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                    {t("toolsCount", { count: tools.length })}
                  </AnimatedBadge>
                ) : null}
              </header>
              <div className="px-5 py-5">
                <McpToolExposureEditor
                  workspace={slug}
                  deploymentId={deploymentId}
                  tools={tools}
                  initialMode={dep.mcpToolExposure}
                  initialAllowedTools={dep.mcpAllowedTools}
                  initialPublicInvocable={dep.publicInvocable}
                  running={running}
                />
              </div>
            </section>

            {playgroundAvailable ? (
              <section className="rounded-xl border border-border bg-card overflow-hidden">
                <header className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold text-foreground">
                    {t("manualToolTesting")}
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("manualToolTestingDescription")}
                  </p>
                </header>
                <div className="px-5 py-5">
                  <ToolPlayground
                    key={`runtime:${tools.map((tool) => tool.name).join("|")}`}
                    workspace={slug}
                    deploymentId={deploymentId}
                    tools={tools}
                    defaultRuntime
                  />
                </div>
              </section>
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
                    href={`${base}?tab=logs`}
                    variant="secondary"
                    size="md"
                  >
                    {t("viewRuntimeLogs")}
                  </ButtonLink>
                }
                className="min-h-44"
              />
            )}
          </div>
        ) : null}

        {current === "settings" ? (
          <div className="max-w-4xl space-y-5">
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
                <p className="rounded-md border border-border bg-muted/[0.06] px-3 py-2 text-xs leading-5 text-foreground text-foreground">
                  {t("cloneSensitiveDataHint")}
                </p>
                <div className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <FormCheckbox
                    name="copyEnvironmentVariables"
                    value="true"
                    defaultChecked
                    label={t("copyEnvironmentVariables")}
                  />
                  <span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t("copyEnvironmentVariablesDescription")}
                    </span>
                  </span>
                </div>
                <div className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <FormCheckbox
                    name="copyRuntimeFiles"
                    value="true"
                    defaultChecked
                    label={t("copyRuntimeFiles")}
                  />
                  <span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t("copyRuntimeFilesDescription")}
                    </span>
                  </span>
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
                  <Activity className="mt-0.5 size-4 text-muted-foreground" />
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                    {t("rebuildDescription")}
                  </p>
                </div>
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
            className="rounded-xl border border-border bg-card scroll-mt-6 px-5 py-5"
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

        {current === "logs" ? (
          <section id="request-logs" className="min-w-0 space-y-4">
            <header>
              <h2 className="text-base font-semibold text-foreground">
                {t("mcpCallLogs")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("requestLogsDescription")}
              </p>
            </header>
            <div className="min-w-0">
              <DeploymentLogs
                logs={logs.map((log) => ({
                  ...log,
                  time: fmtTime(log.createdAt, timeZone, locale),
                }))}
              />
            </div>
          </section>
        ) : null}
      </DashboardPage>
    </>
  );
}
