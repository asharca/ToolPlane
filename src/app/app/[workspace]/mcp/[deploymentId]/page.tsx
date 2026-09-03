import { getLocale, getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  CopyPlus,
  KeyRound,
  LoaderCircle,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { originFromHeaders } from '@/lib/http/origin';
import {
  effectiveStatus,
  getDeploymentRuntimeSnapshot,
} from '@/lib/process/supervisor';
import { listMcpTools } from '@/lib/process/mcp-client';
import { hasMcpToolCatalog, readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';
import { readMcpInspectorConnection } from '@/lib/workspace/inspector-connection';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { ReadyToConnectBanner } from '@/components/dashboard/ReadyToConnectBanner';
import { ConnectDialog } from '@/components/dashboard/ConnectDialog';
import { TabBar } from '@/components/dashboard/TabBar';
import { ToolPlayground } from '@/components/dashboard/ToolPlayground';
import {
  startDeploymentAction,
  stopDeploymentAction,
  restartDeploymentAction,
  rebuildDeploymentAction,
  removeDeploymentAction,
  renameDeploymentAction,
  cloneDeploymentAction,
} from '@/lib/workspace/actions';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { usesDefaultRemoteRuntime } from '@/lib/workspace/deployment-provenance';
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { getDeploymentLogs } from '@/lib/observability/log';
import { DeploymentLogs } from '@/components/dashboard/DeploymentLogs';
import { ContainerLogs } from '@/components/dashboard/ContainerLogs';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { McpJsonConfigEditor } from '@/components/dashboard/McpJsonConfigEditor';
import { McpToolExposureEditor } from '@/components/dashboard/McpToolExposureEditor';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import { RuntimeFilesEditor } from '@/components/dashboard/RuntimeFilesEditor';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import {
  isEditableMcpSource,
  serializeMcpDeploymentConfig,
} from '@/lib/workspace/custom-mcp';
import {
  parseServerRecipe,
  storedRequiredEnvironment,
} from '@/lib/workspace/server-recipe';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

function fmtDate(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }, locale);
}

function fmtTime(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }, locale);
}

const secondaryAction = 'ui-button-secondary h-9';
const primaryAction = 'ui-button-primary h-9';
const transitioningStatuses = new Set([
  'provisioning',
  'copying',
  'restoring',
  'upgrading',
  'deleting',
]);

export default async function DeploymentInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [t, common, locale] = await Promise.all([
    getTranslations('console.mcp'),
    getTranslations('common'),
    getLocale(),
  ]);
  const { workspace: slug, deploymentId } = await params;
  const { tab } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

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
        orderBy: { path: 'asc' },
      },
      marketInstall: { select: { id: true } },
      toolkitLinks: {
        where: { toolkit: { marketInstall: { isNot: null } } },
        select: { toolkitId: true },
        take: 1,
      },
    },
  });
  if (!dep) notFound();

  const editableConfiguration = isEditableMcpSource(dep.source);
  const baseTabs = [
    { key: 'overview', label: t('overview') },
    { key: 'variables', label: t('variables') },
    { key: 'tools', label: t('tools') },
    { key: 'logs', label: t('logs') },
    { key: 'settings', label: t('settings') },
  ];
  const tabs = editableConfiguration
    ? [baseTabs[0], { key: 'configuration', label: t('configuration') }, ...baseTabs.slice(1)]
    : baseTabs;
  const current = tabs.some((item) => item.key === tab) ? tab! : 'overview';

  const label = deploymentLabel(dep);
  const defaultCloneName = t('copyNameDefault', { name: label.name.slice(0, 75).trimEnd() });
  const envCfg = (dep.installCfg ?? {}) as {
    env?: Record<string, string>;
    network?: string;
    command?: string;
  };
  const declaredEnvironment = parseServerRecipe(dep.server?.installCfg)?.env
    ?? storedRequiredEnvironment(dep.installCfg);
  const variableKeys = [...new Set([
    ...declaredEnvironment,
    ...Object.keys(envCfg.env ?? {}),
  ])].sort((left, right) => left.localeCompare(right));
  const envRows = variableKeys.map((key) => ({
    key,
    configured: Boolean(envCfg.env?.[key]?.trim()),
    required: declaredEnvironment.includes(key),
  }));
  const missingRequiredVariables = envRows.filter((row) => row.required && !row.configured);
  const configuredVariables = envRows.filter((row) => row.configured).length;
  // Credentials live in Variables after the initial deployment. Keep the
  // editable runtime config focused on commands, references, and networking.
  const serializedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, { includeEnv: false })
    : '';
  const maskedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, { maskSecrets: true, includeEnv: false })
    : '';

  const status = effectiveStatus(deploymentId, dep.status);
  const running = status === 'running';
  const transitioning = transitioningStatuses.has(status);
  const defaultRemoteRuntime = usesDefaultRemoteRuntime(dep);
  const inspectorConnection = readMcpInspectorConnection(dep.installCfg);
  const connectedInspectorSandbox = dep.source === 'remote' && !defaultRemoteRuntime && inspectorConnection
    ? await db.sandbox.findFirst({
        where: {
          id: inspectorConnection.sandboxId,
          workspaceId: ws.id,
          kind: { in: ['docker', 'connector'] },
          network: { not: 'none' },
        },
        select: { deploymentId: true, deployment: { select: { status: true } } },
      })
    : null;
  const remoteInspectorConnected = Boolean(
    connectedInspectorSandbox
    && effectiveStatus(
      connectedInspectorSandbox.deploymentId,
      connectedInspectorSandbox.deployment.status,
    ) === 'running',
  );
  const toolCatalogVisible = dep.source !== 'remote' || defaultRemoteRuntime || remoteInspectorConnected;
  const readsLiveTools = dep.source !== 'remote' || defaultRemoteRuntime;
  const liveTools = readsLiveTools && running && current === 'tools'
    ? await listMcpTools(deploymentId)
    : [];
  const deploymentToolCatalogKnown = toolCatalogVisible && hasMcpToolCatalog(dep.installCfg);
  const serverToolCatalogKnown = dep.source !== 'remote' && hasMcpToolCatalog(dep.server?.installCfg);
  const savedTools = deploymentToolCatalogKnown
    ? readMcpToolCatalog(dep.installCfg)
    : serverToolCatalogKnown
      ? readMcpToolCatalog(dep.server?.installCfg)
      : [];
  const refreshedConfig = readsLiveTools && running && current === 'tools' && liveTools.length === 0
    ? await db.deployment.findFirst({
        where: { id: deploymentId, workspaceId: ws.id },
        select: { installCfg: true },
      })
    : null;
  const tools = readsLiveTools && running && current === 'tools'
    ? liveTools.length
      ? liveTools
      : hasMcpToolCatalog(refreshedConfig?.installCfg)
        ? readMcpToolCatalog(refreshedConfig?.installCfg)
        : savedTools
    : savedTools;
  const logs = current === 'logs' ? await getDeploymentLogs(ws.id, deploymentId) : [];
  const runtimeSnapshot = current === 'logs'
    ? getDeploymentRuntimeSnapshot(deploymentId)
    : null;
  const playgroundAvailable = dep.source === 'remote' || running;
  const inspectorSandboxes = current === 'tools' && playgroundAvailable && !defaultRemoteRuntime
    ? (await listSandboxes(ws.id))
      .filter((sandbox) => sandbox.kind === 'docker' || sandbox.kind === 'connector')
      .map((sandbox) => ({
        id: sandbox.id,
        name: sandbox.name,
        kind: sandbox.kind,
        running: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) === 'running',
        networkEnabled: sandbox.network !== 'none',
      }))
    : [];

  const endpoint = `${originFromHeaders(await headers())}/api/v1/mcp/${deploymentId}/rpc`;
  const base = `/app/${slug}/mcp/${deploymentId}`;
  const provisioning = status === 'provisioning';
  const setupRequired = status === 'setup_required';
  const runtimePolling = provisioning || running;
  const sourceLabel = label.source === 'catalog'
    ? t('catalog')
    : ['custom', 'config', 'docker'].includes(label.source)
      ? t(`source.${label.source}`)
      : label.source;
  const networkLabel = envCfg.network === 'none' ? t('networkNone') : t('networkIsolated');
  const knownToolCount = dep.source === 'remote' && !defaultRemoteRuntime && !remoteInspectorConnected
    ? undefined
    : running && current === 'tools'
    ? tools.length
    : deploymentToolCatalogKnown || serverToolCatalogKnown
      ? savedTools.length
      : dep.server?.verifiedTools;
  const toolCatalogLabels = {
    title: t('toolCatalog'),
    description: t('toolCatalogDescription'),
    count: t('toolsCount', { count: tools.length }),
    instructions: t('instructions'),
    inputSchema: t('inputSchema'),
    schemaJson: t('schemaJson'),
    parameter: t('parameter'),
    type: t('type'),
    descriptionColumn: t('descriptionColumn'),
    required: t('required'),
    defaultValue: t('defaultValue'),
    noDescription: t('noDescription'),
    noArguments: t('noArguments'),
  };

  return (
    <>
      <ProvisioningRefresher
        active={runtimePolling}
        deploymentId={deploymentId}
        initialStatus={status}
      />
      <DashboardHeader
        breadcrumb={[
          { label: 'MCP', href: `/app/${slug}/mcp` },
          { label: dep.server?.slug ?? label.name },
        ]}
      />
      <DashboardPage className="space-y-6">
        <section className="ui-panel overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-5 px-5 py-5 sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Plug className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">{label.name}</h1>
                  <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {sourceLabel}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <StatusBadge status={status} />
                  {label.ref ? <code className="max-w-full truncate font-mono text-xs">{label.ref}</code> : null}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {running ? <ConnectDialog endpoint={endpoint} name={label.name} label={t('connect')} variant="outline" /> : null}
              {transitioning ? (
                <>
                  <Link href={`${base}?tab=logs`} className={secondaryAction}>{t('viewRuntimeLogs')}</Link>
                  {status !== 'deleting' ? (
                    <form action={stopDeploymentAction}>
                      <input type="hidden" name="workspace" value={slug} />
                      <input type="hidden" name="deploymentId" value={deploymentId} />
                      <SubmitButton flash={false} pendingLabel={t('stopping')} className={secondaryAction}>
                        {t('stop')}
                      </SubmitButton>
                    </form>
                  ) : null}
                </>
              ) : setupRequired ? (
                <Link href={`${base}?tab=variables`} className={primaryAction}>
                  <KeyRound className="size-4" />
                  {t('configureVariables')}
                </Link>
              ) : running ? (
                <>
                  <form action={restartDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="deploymentId" value={deploymentId} />
                    <SubmitButton flash={false} pendingLabel={t('restarting')} className={secondaryAction}>
                      <RefreshCw className="size-3.5" />
                      {t('restart')}
                    </SubmitButton>
                  </form>
                  <form action={stopDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="deploymentId" value={deploymentId} />
                    <SubmitButton flash={false} pendingLabel={t('stopping')} className={secondaryAction}>
                      {t('stop')}
                    </SubmitButton>
                  </form>
                </>
              ) : (
                <form action={startDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <SubmitButton flash={false} pendingLabel={t('starting')} className={primaryAction}>
                    <Play className="size-3.5" />
                    {t('start')}
                  </SubmitButton>
                </form>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3 sm:px-6">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('endpoint')}</p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <code className="max-w-[min(42rem,70vw)] truncate font-mono text-xs text-foreground">{endpoint}</code>
                <CopyButton text={endpoint} label={t('copyEndpointUrl')} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('configurationUpdatedAt', { value: fmtDate(dep.updatedAt, timeZone, locale) })}</p>
          </div>
        </section>

        <div className="-mx-4 overflow-hidden px-4 sm:mx-0 sm:px-0">
          <TabBar tabs={tabs} current={current} basePath={base} />
        </div>

        {provisioning ? (
          <section className="rounded-lg border border-brand/25 bg-brand-soft px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{t('startingMcpRuntime')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('toolplaneIsPullingDependenciesAndWaitingForTheServerToAnnounceItsPort')}
                </p>
              </div>
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('autorefreshing')}</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
            </div>
          </section>
        ) : null}

        {current === 'overview' ? (
          <div className="space-y-5">
            {running ? (
              <ReadyToConnectBanner
                noun="server"
                endpoint={endpoint}
                name={label.name}
                status={status}
              />
            ) : null}

            <DashboardPanel
              title={t('aboutThisMcp')}
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
                <p className="text-sm text-muted-foreground">{t('noDescription')}</p>
              )}
              <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                {dep.server?.author ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('author')}</dt>
                    <dd className="mt-1 font-medium text-foreground">{dep.server.author}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">{t('sourceLabel')}</dt>
                  <dd className="mt-1 font-medium text-foreground">{sourceLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('network')}</dt>
                  <dd className="mt-1 font-medium text-foreground">{networkLabel}</dd>
                </div>
                {typeof knownToolCount === 'number' ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('tools')}</dt>
                    <dd className="mt-1 font-medium text-foreground">{knownToolCount.toLocaleString(locale)}</dd>
                  </div>
                ) : null}
              </dl>
            </DashboardPanel>

            <DashboardPanel title={t('nextStep')} description={t('nextStepDescription')} bodyClassName="py-4">
              {setupRequired ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-300" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('variablesNeedAttention', { count: missingRequiredVariables.length })}</p>
                      {missingRequiredVariables.length ? (
                        <p className="mt-1 text-xs text-muted-foreground">{missingRequiredVariables.map((row) => row.key).join(' · ')}</p>
                      ) : null}
                    </div>
                  </div>
                  <Link href={`${base}?tab=variables`} className={primaryAction}>
                    <KeyRound className="size-4" />
                    {t('configureVariables')}
                  </Link>
                </div>
              ) : transitioning ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-brand" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('runtimeStartingDescription')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('runtimeStartingHint')}</p>
                    </div>
                  </div>
                  <Link href={`${base}?tab=logs`} className={secondaryAction}>{t('viewRuntimeLogs')}</Link>
                </div>
              ) : status === 'error' ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('runtimeErrorDescription')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('runtimeErrorHint')}</p>
                    </div>
                  </div>
                  <Link href={`${base}?tab=logs`} className={secondaryAction}>{t('viewRuntimeLogs')}</Link>
                </div>
              ) : running ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('runningNextStep')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('runningNextStepHint')}</p>
                    </div>
                  </div>
                  <ConnectDialog endpoint={endpoint} name={label.name} label={t('connect')} variant="outline" />
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <Play className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('stoppedNextStep')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('stoppedNextStepHint')}</p>
                    </div>
                  </div>
                  <form action={startDeploymentAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="deploymentId" value={deploymentId} />
                    <SubmitButton flash={false} pendingLabel={t('starting')} className={primaryAction}>
                      <Play className="size-3.5" />
                      {t('start')}
                    </SubmitButton>
                  </form>
                </div>
              )}
            </DashboardPanel>

            <div className="grid gap-5 lg:grid-cols-2">
              <DashboardPanel title={t('connectionDetails')}>
                <dl className="divide-y divide-border text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <dt className="text-muted-foreground">{t('endpoint')}</dt>
                    <dd className="flex max-w-full items-center gap-2">
                      <code className="max-w-[20rem] truncate font-mono text-xs text-foreground">{endpoint}</code>
                      <CopyButton text={endpoint} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-3 last:pb-0">
                    <dt className="text-muted-foreground">{t('created')}</dt>
                    <dd className="text-foreground">{fmtDate(dep.createdAt, timeZone, locale)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-3 last:pb-0">
                    <dt className="text-muted-foreground">{t('apiToken')}</dt>
                    <dd>
                      <Link href={`/app/${slug}/settings/tokens`} className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline">
                        <KeyRound className="size-3.5" />
                        {t('manageTokens')}
                      </Link>
                    </dd>
                  </div>
                </dl>
              </DashboardPanel>

              <DashboardPanel title={t('requestActivity')} description={t('requestActivityDescription')} bodyClassName="py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <BarChart3 className="mt-0.5 size-5 text-muted-foreground" />
                    <p className="max-w-sm text-sm leading-6 text-muted-foreground">{t('viewToolCallsLatencyAndErrorsInObservability')}</p>
                  </div>
                  <Link href={`${base}?tab=logs`} className={secondaryAction}>{t('openObservability')}</Link>
                </div>
              </DashboardPanel>
            </div>
          </div>
        ) : null}

        {current === 'variables' ? (
          <VariablesEditor slug={slug} deploymentId={deploymentId} initial={envRows} />
        ) : null}

        {current === 'configuration' && editableConfiguration ? (
          <div className="space-y-6">
            <McpJsonConfigEditor
              slug={slug}
              deploymentId={deploymentId}
              maskedConfig={maskedConfig}
              requiresReveal={serializedConfig !== maskedConfig}
              initialNetwork={envCfg.network === 'none' ? 'none' : 'isolated'}
              warnAboutPackageInstall={dep.source !== 'docker'}
              variablesHref={`${base}?tab=variables`}
              configuredVariables={configuredVariables}
            />
            <RuntimeFilesEditor
              workspace={slug}
              deploymentId={deploymentId}
              relativePathArgumentsWork={dep.source === 'config' && envCfg.command !== 'docker'}
              initialFiles={dep.configFiles.map((file) => ({
                id: file.id,
                path: file.path,
                size: file.size,
                updatedAt: file.updatedAt.toISOString(),
              }))}
            />
          </div>
        ) : null}

        {current === 'tools' ? (
          <div className="space-y-6">
            {tools.length ? (
              <McpToolCatalog
                tools={tools}
                labels={toolCatalogLabels}
                compact
                hrefForTool={(toolName) => (
                  `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(deploymentId)}/tools/${encodeURIComponent(toolName)}`
                )}
              />
            ) : null}

            <section className="ui-panel overflow-hidden">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
                <div className="flex min-w-0 items-start gap-2.5">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{t('toolAccess')}</h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('toolAccessDescription')}</p>
                  </div>
                </div>
                {running ? (
                  <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                    {t('toolsCount', { count: tools.length })}
                  </span>
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
              <section className="ui-panel overflow-hidden">
                <header className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold text-foreground">{t('manualToolTesting')}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('manualToolTestingDescription')}</p>
                </header>
                <div className="px-5 py-5">
                  <ToolPlayground
                    key={defaultRemoteRuntime ? `managed:${tools.map((tool) => tool.name).join('|')}` : undefined}
                    workspace={slug}
                    deploymentId={deploymentId}
                    tools={defaultRemoteRuntime || inspectorConnection ? tools : []}
                    sandboxes={inspectorSandboxes}
                    connectedSandboxId={dep.source === 'remote'
                      ? remoteInspectorConnected ? inspectorConnection?.sandboxId : undefined
                      : inspectorConnection?.sandboxId}
                    credentialsRequired={setupRequired}
                    defaultRuntime={defaultRemoteRuntime}
                  />
                </div>
              </section>
            ) : (
              <DashboardEmptyState
                icon={Wrench}
                title={tools.length ? t('toolTestingUnavailable') : t('toolsUnavailable')}
                description={tools.length
                  ? t('deploymentNotRunningTesting', { status })
                  : t('deploymentNotRunningTools', { status })}
                actions={(
                  <Link href={`${base}?tab=logs`} className="ui-button-secondary">
                    {t('viewRuntimeLogs')}
                  </Link>
                )}
                className="min-h-44"
              />
            )}
          </div>
        ) : null}

        {current === 'settings' ? (
          <div className="max-w-4xl space-y-5">
            <DashboardPanel title={t('generalSettings')} description={t('renameMcpDescription')}>
              <form action={renameDeploymentAction} className="flex max-w-xl flex-col items-stretch gap-3 sm:flex-row sm:items-end">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <label className="min-w-0 flex-1 space-y-1.5 text-xs font-medium text-muted-foreground">
                  {t('mcpName')}
                  <input
                    name="name"
                    defaultValue={label.name}
                    required
                    maxLength={80}
                    pattern=".*\S.*"
                    title={t('nameCannotBeBlank')}
                    className="ui-input h-9 min-w-0 text-sm"
                  />
                </label>
                <SubmitButton pendingLabel={t('renaming')} savedLabel={t('renamed')} className={`${secondaryAction} shrink-0`}>
                  <Pencil className="size-3.5" />
                  {t('rename')}
                </SubmitButton>
              </form>
            </DashboardPanel>

            <DashboardPanel title={t('cloneMcp')} description={t('cloneMcpDescription')}>
              <form action={cloneDeploymentAction} className="max-w-xl space-y-4">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <input type="hidden" name="copyEnvironmentVariables" value="false" />
                <input type="hidden" name="copyRuntimeFiles" value="false" />
                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  {t('copyName')}
                  <input
                    name="name"
                    defaultValue={defaultCloneName}
                    required
                    maxLength={80}
                    pattern=".*\S.*"
                    title={t('nameCannotBeBlank')}
                    className="ui-input h-9 text-sm"
                  />
                </label>
                <p className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
                  {t('cloneSensitiveDataHint')}
                </p>
                <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <input type="checkbox" name="copyEnvironmentVariables" value="true" defaultChecked className="mt-0.5 size-4 rounded border-border accent-brand" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{t('copyEnvironmentVariables')}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t('copyEnvironmentVariablesDescription')}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <input type="checkbox" name="copyRuntimeFiles" value="true" defaultChecked className="mt-0.5 size-4 rounded border-border accent-brand" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{t('copyRuntimeFiles')}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t('copyRuntimeFilesDescription')}</span>
                  </span>
                </label>
                <SubmitButton flash={false} pendingLabel={t('cloning')} className={secondaryAction}>
                  <CopyPlus className="size-3.5" />
                  {t('clone')}
                </SubmitButton>
              </form>
            </DashboardPanel>

            <DashboardPanel title={t('maintenance')} description={t('maintenanceDescription')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <Activity className="mt-0.5 size-4 text-muted-foreground" />
                  <p className="max-w-xl text-sm leading-6 text-muted-foreground">{t('rebuildDescription')}</p>
                </div>
                <form action={rebuildDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <SubmitButton flash={false} pendingLabel={t('rebuilding')} className={secondaryAction}>
                    <RefreshCw className="size-3.5" />
                    {t('rebuild')}
                  </SubmitButton>
                </form>
              </div>
            </DashboardPanel>

            <DashboardPanel title={t('dangerZone')} description={t('removeMcpDescription')} tone="danger" bodyClassName="py-4">
              <form action={removeDeploymentAction} className="flex flex-wrap items-center justify-between gap-4">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('removeMcpWarning')}</p>
                <ConfirmSubmitButton
                  triggerLabel={t('remove')}
                  confirmLabel={common('confirm')}
                  cancelLabel={common('cancel')}
                  prompt={t('removeMcpPrompt', { name: label.name })}
                  pendingLabel={t('removing')}
                  className="items-center"
                  triggerClassName="inline-flex h-9 items-center rounded-md border border-red-300 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                  confirmClassName="inline-flex h-9 items-center rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700"
                  cancelClassName="ui-button-secondary h-9"
                />
              </form>
            </DashboardPanel>
          </div>
        ) : null}

        {current === 'logs' ? (
          <div className="space-y-6">
            <section id="runtime-logs" className="ui-panel scroll-mt-6 px-5 py-5">
              <ContainerLogs
                key={`${deploymentId}:${runtimeSnapshot?.generation ?? status}`}
                deploymentId={deploymentId}
                initialSnapshot={runtimeSnapshot}
                initialStatus={status}
                title={t('runtimeLogs')}
                refreshLabel={t('refreshLogs')}
                emptyLabel={t('noRuntimeLogsYet')}
                unavailableLabel={t('runtimeUnavailable')}
                statusLabel={t('runtimeStatus')}
                phaseLabel={t('runtimePhase')}
                imageStateLabel={t('runtimeImageState')}
                containerStateLabel={t('runtimeContainerState')}
                syncErrorLabel={t('runtimeLogSyncFailed')}
                truncatedLabel={t('runtimeLogTruncated')}
              />
            </section>

            <section className="ui-panel overflow-hidden">
              <header className="border-b border-border px-5 py-4">
                <h2 className="text-sm font-semibold text-foreground">{t('requestLogs')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('requestLogsDescription')}</p>
              </header>
              <div className="px-5 py-5">
                {logs.length === 0 ? (
                  <div className="ui-empty min-h-48">
                    <p className="text-sm text-muted-foreground">
                      {t('noRequestsLoggedYetRunAToolInTheToolsTabOrConnectAClientToSeeCallRecordsHere')}
                    </p>
                  </div>
                ) : (
                  <DeploymentLogs
                    logs={logs.map((log) => ({
                      ...log,
                      time: fmtTime(log.createdAt, timeZone, locale),
                    }))}
                  />
                )}
              </div>
            </section>
          </div>
        ) : null}
      </DashboardPage>
    </>
  );
}
