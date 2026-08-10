import { getLocale, getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Plug, BarChart3, CopyPlus, Pencil, Settings } from 'lucide-react';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { originFromHeaders } from '@/lib/http/origin';
import {
  effectiveStatus,
  getDeploymentRuntimeSnapshot,
} from '@/lib/process/supervisor';
import { listMcpTools } from '@/lib/process/mcp-client';
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
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { getDeploymentLogs } from '@/lib/observability/log';
import { DeploymentLogs } from '@/components/dashboard/DeploymentLogs';
import { ContainerLogs } from '@/components/dashboard/ContainerLogs';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { McpJsonConfigEditor } from '@/components/dashboard/McpJsonConfigEditor';
import { McpToolExposureEditor } from '@/components/dashboard/McpToolExposureEditor';
import { RuntimeFilesEditor } from '@/components/dashboard/RuntimeFilesEditor';
import {
  isEditableMcpSource,
  serializeMcpDeploymentConfig,
} from '@/lib/workspace/custom-mcp';

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

// The gateway logs the rpc method (and tool name for tools/call) into the path
// as `…/rpc#tools/call:toolName`. Parse it back for display.
function parseCall(path: string): { method: string; tool?: string } {
  const frag = path.split('#')[1] ?? '';
  const [method, tool] = frag.split(':');
  return { method: method || 'request', tool: tool || undefined };
}

const actionButton =
  'inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800';

export default async function DeploymentInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations('console.mcp'),
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
      server: { select: { name: true, slug: true } },
      configFiles: {
        select: { id: true, path: true, size: true, updatedAt: true },
        orderBy: { path: 'asc' },
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
    sandboxId?: string;
  };
  const envRows = Object.entries(envCfg.env ?? {}).map(([key, value]) => ({ key, value }));
  const serializedConfig = editableConfiguration ? serializeMcpDeploymentConfig(dep) : '';
  const maskedConfig = editableConfiguration
    ? serializeMcpDeploymentConfig(dep, { maskSecrets: true })
    : '';

  const status = effectiveStatus(deploymentId, dep.status);
  const running = status === 'running';
  const tools = running && current === 'tools' ? await listMcpTools(deploymentId) : [];
  const logs = current === 'logs' ? await getDeploymentLogs(deploymentId) : [];
  const runtimeSnapshot = current === 'logs'
    ? getDeploymentRuntimeSnapshot(deploymentId)
    : null;

  const endpoint = `${originFromHeaders(await headers())}/api/v1/mcp/${deploymentId}/rpc`;
  const base = `/app/${slug}/mcp/${deploymentId}`;
  const provisioning = status === 'provisioning';
  const setupRequired = status === 'setup_required';
  const runtimePolling = provisioning || running;

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
      <div className="space-y-6 px-8 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {label.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
              <StatusBadge status={status} />
              <CopyButton text={endpoint} label={t('copyEndpointUrl')} />
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>{t('refreshedAt', { value: fmtDate(dep.updatedAt, timeZone, locale) })}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <ConnectDialog
                endpoint={endpoint}
                name={label.name}
                label={t('connect')}
                variant="outline"
              />
            ) : null}
            {running ? (
              <>
                <form action={restartDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <SubmitButton flash={false} pendingLabel={t('restarting')} className={actionButton}>
                    {t('restart')}
                  </SubmitButton>
                </form>
                <form action={stopDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <SubmitButton flash={false} pendingLabel={t('stopping')} className={actionButton}>
                    {t('stop')}
                  </SubmitButton>
                </form>
              </>
            ) : setupRequired ? (
              <Link href={`${base}?tab=variables`} className={actionButton}>
                {baseTabs.find((item) => item.key === 'variables')?.label}
              </Link>
            ) : (
              <form action={startDeploymentAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <SubmitButton flash={false} pendingLabel={t('starting')} className={actionButton}>
                  {t('start')}
                </SubmitButton>
              </form>
            )}
            {!setupRequired ? (
              <form action={rebuildDeploymentAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <SubmitButton flash={false} pendingLabel={t('rebuilding')} className={actionButton}>
                  {t('rebuild')}
                </SubmitButton>
              </form>
            ) : null}
            <form action={removeDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deploymentId} />
              <button className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10">
                {t('remove')}
              </button>
            </form>
          </div>
        </div>

        <TabBar tabs={tabs} current={current} basePath={base} />

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
            <ReadyToConnectBanner
              noun="server"
              endpoint={endpoint}
              name={label.name}
              status={status}
            />

            <section
              id="identity"
              className="rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t('identity')}
                </h2>
              </header>
              <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t('endpoint')}
                  </dt>
                  <dd className="flex items-center gap-2">
                    <code className="max-w-[28rem] truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                      {endpoint}
                    </code>
                    <CopyButton text={endpoint} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t('created')}
                  </dt>
                  <dd className="text-sm text-zinc-700 dark:text-zinc-300">
                    {fmtDate(dep.createdAt, timeZone, locale)}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 px-4 py-4 dark:border-zinc-800">
              <div className="flex items-start gap-3">
                <BarChart3 className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {t('trackRequestsLatencyAndErrors')}
                  </p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t('viewToolCallsLatencyAndErrorsInObservability')}
                  </p>
                </div>
              </div>
              <Link
                href={`/app/${slug}/observability?deploymentId=${deploymentId}`}
                className={actionButton}
              >
                {t('openObservability')}
              </Link>
            </section>
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
          <section className="space-y-6">
            <div className="mb-3 flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('tools')} {tools.length > 0 ? `(${tools.length})` : ''}
              </h2>
            </div>
            <McpToolExposureEditor
              workspace={slug}
              deploymentId={deploymentId}
              tools={tools}
              initialMode={dep.mcpToolExposure}
              initialAllowedTools={dep.mcpAllowedTools}
              initialPublicInvocable={dep.publicInvocable}
              running={running}
            />
            {running ? (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-foreground">{t('manualToolTesting')}</h3>
                <ToolPlayground workspace={slug} deploymentId={deploymentId} tools={tools} />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {t('deploymentNotRunningTools', {
                    status: status === 'stopped'
                      ? t('stopped')
                      : status === 'error'
                        ? t('error')
                        : status,
                  })}
                </p>
              </div>
            )}
          </section>
        ) : null}

        {current === 'settings' ? (
          <div className="max-w-3xl divide-y divide-border">
            <section className="pb-6">
              <div className="flex items-center gap-2">
                <Settings className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  {t('generalSettings')}
                </h2>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('renameMcpDescription')}
              </p>
              <form
                action={renameDeploymentAction}
                className="mt-4 flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
              >
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
                <SubmitButton
                  pendingLabel={t('renaming')}
                  savedLabel={t('renamed')}
                  className="ui-button-secondary h-9 w-full text-xs sm:w-auto"
                >
                  <Pencil className="size-3.5" />
                  {t('rename')}
                </SubmitButton>
              </form>
            </section>

            <section className="py-6">
              <div className="flex items-center gap-2">
                <CopyPlus className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  {t('cloneMcp')}
                </h2>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('cloneMcpDescription')}
              </p>
              <form action={cloneDeploymentAction} className="mt-4 max-w-xl space-y-4">
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
                <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <input
                    type="checkbox"
                    name="copyEnvironmentVariables"
                    value="true"
                    defaultChecked
                    className="mt-0.5 size-4 rounded border-border accent-brand"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {t('copyEnvironmentVariables')}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t('copyEnvironmentVariablesDescription')}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5 rounded-lg border border-border p-3">
                  <input
                    type="checkbox"
                    name="copyRuntimeFiles"
                    value="true"
                    defaultChecked
                    className="mt-0.5 size-4 rounded border-border accent-brand"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {t('copyRuntimeFiles')}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t('copyRuntimeFilesDescription')}
                    </span>
                  </span>
                </label>
                <SubmitButton
                  flash={false}
                  pendingLabel={t('cloning')}
                  className="ui-button-secondary h-9 w-full text-xs sm:w-auto"
                >
                  <CopyPlus className="size-3.5" />
                  {t('clone')}
                </SubmitButton>
              </form>
            </section>
          </div>
        ) : null}

        {current === 'logs' ? (
          <div className="space-y-8">
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

            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">{t('requestLogs')}</h2>
              {logs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t('noRequestsLoggedYetRunAToolInTheToolsTabOrConnectAClientToSeeCallRecordsHere')}
                  </p>
                </div>
              ) : (
                <DeploymentLogs
                  logs={logs.map((l) => {
                    const call = parseCall(l.path);
                    return {
                      id: l.id,
                      time: fmtTime(l.createdAt, timeZone, locale),
                      method: call.method,
                      tool: call.tool,
                      statusCode: l.statusCode,
                      durationMs: l.durationMs,
                      request: l.requestBody,
                      response: l.responseBody,
                    };
                  })}
                />
              )}
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}
