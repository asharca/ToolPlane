import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, ChevronRight, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { listMcpTools } from '@/lib/process/mcp-client';
import { hasMcpToolCatalog, readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';
import { effectiveStatus } from '@/lib/process/supervisor';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { usesDefaultRemoteRuntime } from '@/lib/workspace/deployment-provenance';
import { readMcpInspectorConnection } from '@/lib/workspace/inspector-connection';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';

export const dynamic = 'force-dynamic';

export default async function DeploymentToolPage({
  params,
}: {
  params: Promise<{ workspace: string; deploymentId: string; toolName: string }>;
}) {
  const [{ workspace: slug, deploymentId, toolName }, t] = await Promise.all([
    params,
    getTranslations('console.mcp'),
  ]);
  const user = await getCurrentUser();
  const requestedPath = `/app/${slug}/mcp/${deploymentId}/tools/${toolName}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(requestedPath)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const deployment = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: workspace.id,
      OR: [{ source: null }, { source: { not: 'sandbox' } }],
    },
    select: {
      id: true,
      name: true,
      source: true,
      sourceRef: true,
      installCfg: true,
      status: true,
      serverId: true,
      server: { select: { name: true, slug: true, installCfg: true } },
      marketInstall: { select: { id: true } },
      toolkitLinks: {
        where: { toolkit: { marketInstall: { isNot: null } } },
        select: { toolkitId: true },
        take: 1,
      },
    },
  });
  if (!deployment) notFound();

  const base = `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(deployment.id)}`;
  const inspectorConnection = readMcpInspectorConnection(deployment.installCfg);
  const defaultRemoteRuntime = usesDefaultRemoteRuntime(deployment);
  if (deployment.source === 'remote' && !defaultRemoteRuntime) {
    if (!inspectorConnection) redirect(`${base}?tab=tools`);
    const sandbox = await db.sandbox.findFirst({
      where: {
        id: inspectorConnection.sandboxId,
        workspaceId: workspace.id,
        kind: { in: ['docker', 'connector'] },
        network: { not: 'none' },
      },
      select: { deploymentId: true, deployment: { select: { status: true } } },
    });
    if (!sandbox
      || effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !== 'running') {
      redirect(`${base}?tab=tools`);
    }
  }

  const running = effectiveStatus(deployment.id, deployment.status) === 'running';
  const savedTools = hasMcpToolCatalog(deployment.installCfg)
    ? readMcpToolCatalog(deployment.installCfg)
    : deployment.source === 'remote' && !defaultRemoteRuntime
      ? []
      : readMcpToolCatalog(deployment.server?.installCfg);
  const readsLiveTools = deployment.source !== 'remote' || defaultRemoteRuntime;
  const liveTools = readsLiveTools && running ? await listMcpTools(deployment.id) : [];
  const refreshedConfig = readsLiveTools && running && liveTools.length === 0
    ? await db.deployment.findFirst({
        where: { id: deployment.id, workspaceId: workspace.id },
        select: { installCfg: true },
      })
    : null;
  const tools = readsLiveTools && running
    ? liveTools.length
      ? liveTools
      : hasMcpToolCatalog(refreshedConfig?.installCfg)
        ? readMcpToolCatalog(refreshedConfig?.installCfg)
        : savedTools
    : savedTools;
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) notFound();

  const label = deploymentLabel(deployment);
  const labels = {
    title: t('toolCatalog'),
    description: t('toolCatalogDescription'),
    count: t('toolsCount', { count: 1 }),
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
      <DashboardHeader breadcrumb={[
        { label: 'MCP', href: `/app/${encodeURIComponent(slug)}/mcp` },
        { label: label.name, href: `${base}?tab=tools` },
        { label: tool.name },
      ]} />
      <DashboardPage className="space-y-6">
        <header>
          <Link
            href={`${base}?tab=tools`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> {t('tools')}
          </Link>
          <div className="mt-4 flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Wrench className="size-5" />
            </span>
            <div className="min-w-0">
              <h1 className="break-all text-2xl font-semibold text-foreground">
                {tool.title ?? tool.annotations?.title ?? tool.name}
              </h1>
              <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">{tool.name}</code>
              {tool.description ? <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{tool.description}</p> : null}
            </div>
          </div>
        </header>

        <McpToolCatalog tools={[tool]} labels={labels} />

        {tools.length > 1 ? (
          <section className="ui-panel p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-foreground">{t('tools')}</h2>
            <div className="mt-3 grid gap-1 sm:grid-cols-2">
              {tools.filter((candidate) => candidate.name !== tool.name).map((candidate) => (
                <Link
                  key={candidate.name}
                  href={`${base}/tools/${encodeURIComponent(candidate.name)}`}
                  className="flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted/35 hover:text-foreground"
                >
                  <code className="min-w-0 flex-1 truncate font-mono">{candidate.name}</code>
                  <ChevronRight className="size-3.5 shrink-0" />
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </DashboardPage>
    </>
  );
}
