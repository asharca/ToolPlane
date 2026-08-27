import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Plug, Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments } from '@/lib/workspace/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';
import { McpDeploymentsBrowser } from '@/components/dashboard/McpDeploymentsBrowser';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function formatDate(d: Date, timeZone: string, locale: string): string {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }, locale);
}

export default async function McpServersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ create?: string }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  const [t, locale] = await Promise.all([
    getTranslations('console.mcp'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const deployments = await getDeployments(ws.id);
  const deploymentItems = deployments.map((deployment) => {
    const label = deploymentLabel(deployment);
    return {
      id: deployment.id,
      name: label.name,
      source: label.source,
      reference: deployment.server?.slug ?? label.ref,
      status: effectiveStatus(deployment.id, deployment.status),
      createdAt: formatDate(deployment.createdAt, timeZone, locale),
      iconUrl: deployment.server?.iconUrl ?? null,
    };
  });
  const anyProvisioning = deploymentItems.some((deployment) => deployment.status === 'provisioning');
  const marketHref = `/app/${encodeURIComponent(slug)}/market/mcp`;

  return (
    <>
      <ProvisioningRefresher active={anyProvisioning} />
      <DashboardHeader title={t('title')} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <>
              <Link href={marketHref} className="ui-button-secondary">
                <Store className="size-4" />
                {t('browseToolplane')}
              </Link>
              <DeployCustomMcpDialog slug={slug} defaultOpen={query.create === '1'} />
            </>
          }
        >
          <div>
            <p className="text-sm text-muted-foreground">{t('serversDeployedToYourOrg')}</p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              {t('deploymentCountSummary', { count: deployments.length })}
            </p>
          </div>
        </DashboardToolbar>

        {deployments.length === 0 ? (
          <DashboardEmptyState
            icon={Plug}
            title={t('noServersDeployedYet')}
            description={t('serversDeployedToYourOrg')}
            actions={
              <>
                <Link
                  href={marketHref}
                  className="ui-button-secondary"
                >
                  <Store className="size-4" />
                  {t('browseToolplane')}
                </Link>
                <DeployCustomMcpDialog slug={slug} />
              </>
            }
          />
        ) : (
          <McpDeploymentsBrowser slug={slug} deployments={deploymentItems} />
        )}
      </DashboardPage>
    </>
  );
}
