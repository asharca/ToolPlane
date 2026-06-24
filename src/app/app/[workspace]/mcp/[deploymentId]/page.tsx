import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Plug, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
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
  removeDeploymentAction,
} from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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
  const { workspace: slug, deploymentId } = await params;
  const { tab } = await searchParams;
  const current = TABS.some((t) => t.key === tab) ? tab! : 'overview';

  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ws.id },
    include: { server: { select: { name: true, slug: true } } },
  });
  if (!dep) notFound();

  const status = liveStatus(deploymentId) ?? dep.status;
  const running = status === 'running';
  const tools = running && current === 'tools' ? await listMcpTools(deploymentId) : [];

  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const endpoint = `${proto}://${host}/api/v1/mcp/${deploymentId}/rpc`;
  const base = `/app/${slug}/mcp/${deploymentId}`;

  return (
    <>
      <DashboardHeader
        breadcrumb={[
          { label: 'MCP Servers', href: `/app/${slug}/mcp` },
          { label: dep.server.slug },
        ]}
      />
      <div className="space-y-6 px-8 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {dep.server.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
              <StatusBadge status={status} />
              <CopyButton text={endpoint} label="Copy endpoint URL" />
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>Refreshed {fmtDate(dep.updatedAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectDialog
              endpoint={endpoint}
              name={dep.server.name}
              label="Connect"
              variant="outline"
            />
            {running ? (
              <>
                <form action={restartDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <button className={actionButton}>Restart</button>
                </form>
                <form action={stopDeploymentAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="deploymentId" value={deploymentId} />
                  <button className={actionButton}>Stop</button>
                </form>
              </>
            ) : (
              <form action={startDeploymentAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="deploymentId" value={deploymentId} />
                <button className={actionButton}>Start</button>
              </form>
            )}
            <form action={removeDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deploymentId} />
              <button className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10">
                Rebuild
              </button>
            </form>
          </div>
        </div>

        <TabBar tabs={TABS} current={current} basePath={base} />

        {current === 'overview' ? (
          <div className="space-y-5">
            <ReadyToConnectBanner noun="server" endpoint={endpoint} name={dep.server.name} />

            <section
              id="identity"
              className="rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Identity
                </h2>
              </header>
              <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <dt className="text-sm text-zinc-500 dark:text-zinc-400">
                    Endpoint
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
                    Created
                  </dt>
                  <dd className="text-sm text-zinc-700 dark:text-zinc-300">
                    {fmtDate(dep.createdAt)}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 px-4 py-4 dark:border-zinc-800">
              <div className="flex items-start gap-3">
                <BarChart3 className="mt-0.5 size-4 text-zinc-400" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    Track requests, latency, and errors
                  </p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    View tool calls, latency, and errors in Observability.
                  </p>
                </div>
              </div>
              <Link
                href={`/app/${slug}/observability?deploymentId=${deploymentId}`}
                className={actionButton}
              >
                Open Observability
              </Link>
            </section>
          </div>
        ) : null}

        {current === 'variables' ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This server has no configurable variables.
            </p>
          </div>
        ) : null}

        {current === 'tools' ? (
          <section>
            <div className="mb-3 flex items-center gap-2">
              <Plug className="size-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Tools {tools.length > 0 ? `(${tools.length})` : ''}
              </h2>
            </div>
            {running ? (
              <ToolPlayground deploymentId={deploymentId} tools={tools} />
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  This deployment is {status}. Start it to inspect and run its
                  tools.
                </p>
              </div>
            )}
          </section>
        ) : null}

        {current === 'logs' ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No logs yet. Request logs appear here once the gateway receives
              traffic.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
