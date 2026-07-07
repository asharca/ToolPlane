import { getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Plug, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { originFromHeaders } from '@/lib/http/origin';
import { effectiveStatus } from '@/lib/process/supervisor';
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
} from '@/lib/workspace/actions';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { getDeploymentLogs } from '@/lib/observability/log';
import { DeploymentLogs } from '@/components/dashboard/DeploymentLogs';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';

export const dynamic = 'force-dynamic';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtTime(d: Date): string {
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'variables', label: 'Variables' },
  { key: 'tools', label: 'Tools' },
  { key: 'logs', label: 'Logs' },
];

export default async function DeploymentInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; deploymentId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations('console.mcp');
  const { workspace: slug, deploymentId } = await params;
  const { tab } = await searchParams;
  const current = TABS.some((t) => t.key === tab) ? tab! : 'overview';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ws.id },
    include: { server: { select: { name: true, slug: true } } },
  });
  if (!dep) notFound();

  const label = deploymentLabel(dep);
  const envCfg = (dep.installCfg ?? {}) as { env?: Record<string, string>; network?: string };
  const envRows = Object.entries(envCfg.env ?? {}).map(([key, value]) => ({ key, value }));

  const status = effectiveStatus(deploymentId, dep.status);
  const running = status === 'running';
  const tools = running && current === 'tools' ? await listMcpTools(deploymentId) : [];
  const logs = current === 'logs' ? await getDeploymentLogs(deploymentId) : [];

  const endpoint = `${originFromHeaders(await headers())}/api/v1/mcp/${deploymentId}/rpc`;
  const base = `/app/${slug}/mcp/${deploymentId}`;
  const provisioning = status === 'provisioning';

  return (
    <>
      <ProvisioningRefresher active={provisioning} />
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
              <span>{t('refreshed')} {fmtDate(dep.updatedAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectDialog
              endpoint={endpoint}
              name={label.name}
              label={t('connect')}
              variant="outline"
            />
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
            ) : (
              <form action={startDeploymentAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <SubmitButton flash={false} pendingLabel={t('starting')} className={actionButton}>
                  {t('start')}
                </SubmitButton>
              </form>
            )}
            <form action={rebuildDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deploymentId} />
              <SubmitButton flash={false} pendingLabel={t('rebuilding')} className={actionButton}>
                {t('rebuild')}
              </SubmitButton>
            </form>
            <form action={removeDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deploymentId} />
              <button className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10">
                {t('remove')}
              </button>
            </form>
          </div>
        </div>

        <TabBar tabs={TABS} current={current} basePath={base} />

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
            <ReadyToConnectBanner noun="server" endpoint={endpoint} name={label.name} />

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
                    {fmtDate(dep.createdAt)}
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
          <VariablesEditor slug={slug} deploymentId={deploymentId} initial={envRows} network={envCfg.network} />
        ) : null}

        {current === 'tools' ? (
          <section>
            <div className="mb-3 flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('tools')} {tools.length > 0 ? `(${tools.length})` : ''}
              </h2>
            </div>
            {running ? (
              <ToolPlayground deploymentId={deploymentId} tools={tools} />
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {t('thisDeploymentIs')} {status}{t('startItToInspectAndRunItsTools')}
                </p>
              </div>
            )}
          </section>
        ) : null}

        {current === 'logs' ? (
          logs.length === 0 ? (
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
                  time: fmtTime(l.createdAt),
                  method: call.method,
                  tool: call.tool,
                  statusCode: l.statusCode,
                  durationMs: l.durationMs,
                  request: l.requestBody,
                  response: l.responseBody,
                };
              })}
            />
          )
        ) : null}
      </div>
    </>
  );
}
