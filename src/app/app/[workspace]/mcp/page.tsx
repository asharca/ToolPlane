import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import {
  removeDeploymentAction,
  startDeploymentAction,
  stopDeploymentAction,
  restartDeploymentAction,
} from '@/lib/workspace/actions';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { DeployCustomMcpLauncher } from '@/components/dashboard/DeployCustomMcpLauncher';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';

export const dynamic = 'force-dynamic';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Reconcile DB status with the live process table: if the DB still says a
// deployment is up but no supervised process exists (e.g. after a server
// restart), surface it as stopped rather than lying.
function displayStatus(id: string, dbStatus: string): string {
  const live = liveStatus(id);
  if (live) return live;
  return dbStatus === 'running' || dbStatus === 'provisioning'
    ? 'stopped'
    : dbStatus;
}

const rowButton =
  'text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';

export default async function McpServersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const deployments = await getDeployments(ws.id);
  const anyProvisioning = deployments.some(
    (d) => displayStatus(d.id, d.status) === 'provisioning',
  );

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader
        title="MCP Servers"
        actions={
          <div className="flex items-center gap-2">
            <DeployCustomMcpLauncher slug={slug} />
            <Link
              href={`/app/${slug}/mcp/new`}
              className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Browse MCPs
            </Link>
          </div>
        }
      />
      <div className="px-8 py-6">
        <div className="mb-6 flex items-center justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Servers deployed to your org.
          </p>
          <span className="text-sm text-zinc-400">
            {deployments.length} server{deployments.length === 1 ? '' : 's'}
          </span>
        </div>

        {deployments.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 py-20 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No servers deployed yet.
            </p>
            <Link
              href={`/app/${slug}/mcp/new`}
              className="mt-4 inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Browse MCPs
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Server</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {deployments.map((d) => {
                  const status = displayStatus(d.id, d.status);
                  const isUp = status === 'running' || status === 'provisioning';
                  const label = deploymentLabel(d);
                  return (
                    <tr
                      key={d.id}
                      className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {d.server?.iconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={d.server.iconUrl}
                              alt=""
                              width={20}
                              height={20}
                              className="size-5 rounded object-cover"
                            />
                          ) : (
                            <span className="size-5 rounded bg-zinc-200 dark:bg-zinc-700" />
                          )}
                          <Link
                            href={`/app/${slug}/mcp/${d.id}`}
                            className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                          >
                            {label.name}
                          </Link>
                          {label.source !== 'catalog' ? (
                            <span className="inline-flex items-center rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                              {label.source}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                        {formatDate(d.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-3">
                          <Link href={`/app/${slug}/mcp/${d.id}`} className={rowButton}>
                            Inspect
                          </Link>
                          {isUp ? (
                            <>
                              <form action={stopDeploymentAction}>
                                <input type="hidden" name="workspace" value={slug} />
                                <input type="hidden" name="deploymentId" value={d.id} />
                                <button className={rowButton}>Stop</button>
                              </form>
                              <form action={restartDeploymentAction}>
                                <input type="hidden" name="workspace" value={slug} />
                                <input type="hidden" name="deploymentId" value={d.id} />
                                <button className={rowButton}>Restart</button>
                              </form>
                            </>
                          ) : (
                            <form action={startDeploymentAction}>
                              <input type="hidden" name="workspace" value={slug} />
                              <input type="hidden" name="deploymentId" value={d.id} />
                              <button className={rowButton}>Start</button>
                            </form>
                          )}
                          <form action={removeDeploymentAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="deploymentId" value={d.id} />
                            <button className="text-xs text-zinc-400 transition-colors hover:text-red-600">
                              Remove
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
