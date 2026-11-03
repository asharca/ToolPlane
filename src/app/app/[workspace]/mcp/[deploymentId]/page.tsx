import { McpHttpApprovalForm } from "@/components/dashboard/McpHttpConsent";
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
import { McpJsonConfigEditor } from "@/components/dashboard/McpJsonConfigEditor";
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
import {
  isEditableMcpSource,
  serializeMcpDeploymentConfig,
} from "@/lib/workspace/custom-mcp";
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
  const [usingAgents, usingAssistants] = await Promise.all([
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

  const editableConfiguration = isEditableMcpSource(dep.source);
  const baseTabs = [
    { key: "overview", label: t("overview") },
    { key: "tools", label: t("tools") },
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
  const configuredVariables = envRows.filter((row) => row.configured).length;
  // Credentials live in Variables after the initial deployment. Keep the
  // editable runtime config focused on commands, references, and networking.
  const serializedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, { includeEnv: false })
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
  const aboutMarkdown = dep.server?.readme?.trim() || null;
  const aboutDescription = dep.server?.description?.trim() || null;

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
        (dep.installCfg as { allowUnsafeHttp?: boolean } | null)
          ?.allowUnsafeHttp !== true ? (
          <McpHttpApprovalForm
            workspace={slug}
            deploymentId={deploymentId}
            url={dep.sourceRef}
          />
        ) : null}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm">
              <Plug className="size-5" />
            </span>
            <div className="min-w-0">
              <h1
                title={label.name}
                className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
              >
                {label.name}
              </h1>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                <StatusBadge status={status} />
                <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                  {sourceLabel}
                </AnimatedBadge>
                {pinnedPackage || label.ref ? (
                  <code
                    title={pinnedPackage ?? label.ref ?? undefined}
                    className="max-w-full truncate rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {pinnedPackage ?? label.ref}
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
                <input type="hidden" name="deploymentId" value={deploymentId} />
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
                <input type="hidden" name="deploymentId" value={deploymentId} />
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
        </header>
        {!running ? (
          <p
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm ${status === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/40 text-muted-foreground"}`}
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
          <div
            className={
              aboutMarkdown || aboutDescription
                ? "grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start"
                : "max-w-3xl"
            }
          >
            <DashboardPanel
              title={t("connectionDetails")}
              className="lg:order-2"
            >
              <dl className="space-y-5 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("endpoint")}
                  </dt>
                  <dd className="mt-1.5 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
                    <code
                      title={endpoint}
                      className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                    >
                      {endpoint}
                    </code>
                    <CopyButton text={endpoint} />
                  </dd>
                </div>
                {connected.length ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t("connectedTo")}
                    </dt>
                    <dd className="mt-1.5">
                      <McpConnectedChips objects={connected} />
                    </dd>
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {t("sourceLabel")}
                    </dt>
                    <dd className="mt-1 truncate font-medium text-foreground">
                      {sourceLabel}
                    </dd>
                  </div>
                  {pinnedVersion ? (
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {t("pinnedVersion")}
                      </dt>
                      <dd
                        title={pinnedPackage ?? undefined}
                        className="mt-1 truncate font-mono text-foreground"
                      >
                        {pinnedVersion}
                      </dd>
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {t("network")}
                    </dt>
                    <dd className="mt-1 truncate font-medium text-foreground">
                      {networkLabel}
                    </dd>
                  </div>
                  {typeof knownToolCount === "number" ? (
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {t("tools")}
                      </dt>
                      <dd className="mt-1">
                        <Link
                          href={`${base}?tab=tools`}
                          className="font-medium text-foreground tabular-nums hover:underline"
                        >
                          {knownToolCount.toLocaleString(locale)}
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                  {dep.server?.author ? (
                    <div className="col-span-2 min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {t("author")}
                      </dt>
                      <dd
                        title={dep.server.author}
                        className="mt-1 truncate font-medium text-foreground"
                      >
                        {dep.server.author}
                      </dd>
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {t("created")}
                    </dt>
                    <dd className="mt-1 text-foreground">
                      {fmtDate(dep.createdAt, timeZone, locale)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {t("updated")}
                    </dt>
                    <dd className="mt-1 text-foreground">
                      {fmtDate(dep.updatedAt, timeZone, locale)}
                    </dd>
                  </div>
                </div>
              </dl>
              <Link
                href={`/app/${slug}/settings/tokens`}
                className="mt-5 flex items-center gap-1.5 border-t border-border pt-4 text-sm font-medium text-foreground hover:underline"
              >
                <KeyRound className="size-3.5 text-muted-foreground" />
                {t("manageTokens")}
              </Link>
            </DashboardPanel>
            {aboutMarkdown || aboutDescription ? (
              <DashboardPanel
                title={t("aboutThisMcp")}
                className="lg:order-1"
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
              remote={dep.source === "remote"}
              maskedConfig={serializedConfig}
              requiresReveal={false}
              initialNetwork={envCfg.network === "none" ? "none" : "isolated"}
              warnAboutPackageInstall={dep.source !== "docker"}
              variablesHref={`${base}?tab=variables`}
              configuredVariables={configuredVariables}
            />
            {dep.source !== "remote" ? (
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
          </div>
        ) : null}

        {current === "tools" ? (
          <div className="space-y-5">
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
                    size="md"
                  >
                    {t("viewRuntimeLogs")}
                  </ButtonLink>
                }
                className="min-h-44 rounded-xl border border-dashed border-border"
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
                <p className="rounded-xl border border-border bg-muted/[0.06] px-3 py-2 text-xs leading-5 text-foreground text-foreground">
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
      </DashboardPage>
    </>
  );
}
