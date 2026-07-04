import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';
import {
  removeDeploymentAction,
  startDeploymentAction,
  stopDeploymentAction,
  restartDeploymentAction,
} from '@/lib/workspace/actions';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const rowButton =
  'text-xs text-muted-foreground transition-colors hover:text-foreground';

export default async function McpServersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const t = await getTranslations('console.mcp');
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const deployments = await getDeployments(ws.id);
  const anyProvisioning = deployments.some(
    (d) => effectiveStatus(d.id, d.status) === 'provisioning',
  );

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title={t('title')} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <>
              <Link href={`/app/${slug}/mcp/new`} className="ui-button-secondary">
                <Store className="size-4" />
                Browse ToolPlane
              </Link>
              <DeployCustomMcpDialog slug={slug} />
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            Servers deployed to your org. {deployments.length} server{deployments.length === 1 ? '' : 's'} deployed.
          </p>
        </DashboardToolbar>

        {deployments.length === 0 ? (
          <DashboardEmptyState
            description="No servers deployed yet."
            actions={
              <>
                <Link
                  href={`/app/${slug}/mcp/new`}
                  className="ui-button-secondary"
                >
                  <Store className="size-4" />
                  Browse ToolPlane
                </Link>
                <DeployCustomMcpDialog slug={slug} />
              </>
            }
          />
        ) : (
          <DashboardTable
            headers={[
              { label: 'Server' },
              { label: 'Status' },
              { label: 'Created' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {deployments.map((d) => {
              const status = effectiveStatus(d.id, d.status);
              const isUp = status === 'running' || status === 'provisioning';
              const label = deploymentLabel(d);
              return (
                <tr
                  key={d.id}
                  className="transition-colors"
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
                        <span className="size-5 rounded bg-muted" />
                      )}
                      <Link
                        href={`/app/${slug}/mcp/${d.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {label.name}
                      </Link>
                      {label.source !== 'catalog' ? (
                        <span className="inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
                          {label.source}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
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
                        <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DashboardTable>
        )}
      </DashboardPage>
    </>
  );
}
