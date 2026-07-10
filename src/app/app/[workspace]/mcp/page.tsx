import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
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
import { SubmitButton } from '@/components/dashboard/SubmitButton';

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
  const [deployments, sandboxes] = await Promise.all([
    getDeployments(ws.id),
    listSandboxes(ws.id),
  ]);
  const dockerSandboxOptions = sandboxes
    .filter((sandbox) => sandbox.kind === 'docker')
    .map((sandbox) => ({
      id: sandbox.id,
      name: sandbox.name,
      status: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status),
    }));
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
                {t('browseToolplane')}
              </Link>
              <DeployCustomMcpDialog slug={slug} sandboxes={dockerSandboxOptions} />
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t('deploymentCountSummary', { count: deployments.length })}
          </p>
        </DashboardToolbar>

        {deployments.length === 0 ? (
          <DashboardEmptyState
            description={t('noServersDeployedYet')}
            actions={
              <>
                <Link
                  href={`/app/${slug}/mcp/new`}
                  className="ui-button-secondary"
                >
                  <Store className="size-4" />
                  {t('browseToolplane')}
                </Link>
                <DeployCustomMcpDialog slug={slug} sandboxes={dockerSandboxOptions} />
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
                        {t('inspect')}
                      </Link>
                      {isUp ? (
                        <>
                          <form action={stopDeploymentAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="deploymentId" value={d.id} />
                            <SubmitButton flash={false} pendingLabel={t('stopping')} className={rowButton}>
                              {t('stop')}
                            </SubmitButton>
                          </form>
                          <form action={restartDeploymentAction}>
                            <input type="hidden" name="workspace" value={slug} />
                            <input type="hidden" name="deploymentId" value={d.id} />
                            <SubmitButton flash={false} pendingLabel={t('restarting')} className={rowButton}>
                              {t('restart')}
                            </SubmitButton>
                          </form>
                        </>
                      ) : (
                        <form action={startDeploymentAction}>
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="deploymentId" value={d.id} />
                          <SubmitButton flash={false} pendingLabel={t('starting')} className={rowButton}>
                            {t('start')}
                          </SubmitButton>
                        </form>
                      )}
                      <form action={removeDeploymentAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="deploymentId" value={d.id} />
                        <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                          {t('remove')}
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
