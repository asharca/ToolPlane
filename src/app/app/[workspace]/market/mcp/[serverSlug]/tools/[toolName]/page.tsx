import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Box, ChevronRight } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketServer, getWorkspaceForUser } from '@/lib/workspace/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import {
  MarketDetailHeader,
  MarketDetailShell,
} from '@/components/dashboard/market/MarketDetailShell';

export const dynamic = 'force-dynamic';

export default async function McpMarketToolPage({
  params,
}: {
  params: Promise<{ workspace: string; serverSlug: string; toolName: string }>;
}) {
  const [{ workspace: slug, serverSlug, toolName }, t, mcpT] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('console.mcp'),
  ]);
  const user = await getCurrentUser();
  const requestedPath = `/app/${slug}/market/mcp/${serverSlug}/tools/${toolName}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(requestedPath)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const server = await getMarketServer(serverSlug, workspace.id);
  if (
    !server
    || (server.mcpKind === 'connector' && (
      !server.inspectorSandbox
      || effectiveStatus(server.inspectorSandbox.deploymentId, server.inspectorSandbox.status) !== 'running'
    ))
  ) notFound();
  const tools = server.tools;
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) notFound();

  const serverHref = `/app/${encodeURIComponent(slug)}/market/mcp/${encodeURIComponent(server.slug)}`;
  const marketBase = `/app/${encodeURIComponent(slug)}/market/mcp`;
  const network = server.recipe.network === 'none' ? t('networkNone') : t('networkIsolated');
  const labels = {
    title: mcpT('toolCatalog'),
    description: mcpT('toolCatalogDescription'),
    count: mcpT('toolsCount', { count: 1 }),
    instructions: mcpT('instructions'),
    inputSchema: mcpT('inputSchema'),
    schemaJson: mcpT('schemaJson'),
    parameter: mcpT('parameter'),
    type: mcpT('type'),
    descriptionColumn: mcpT('descriptionColumn'),
    required: mcpT('required'),
    defaultValue: mcpT('defaultValue'),
    noDescription: mcpT('noDescription'),
    noArguments: mcpT('noArguments'),
  };

  return (
    <DashboardPage className="space-y-7">
      <MarketDetailHeader
        backHref={serverHref}
        backLabel={server.name}
        iconUrl={server.iconUrl}
        icon={<Box className="size-7" />}
        type={t(server.mcpKind === 'connector' ? 'kindMcpConnector' : 'kindMcp')}
        title={tool.title ?? tool.annotations?.title ?? tool.name}
        publisher={server.name}
        summary={tool.description ?? mcpT('noDescription')}
        facts={[
          { label: t('source'), value: server.recipe.source },
          ...(server.connector
            ? [
                { label: t('connectorEndpoint'), value: server.connector.endpointHost },
                {
                  label: t('connectorTransport'),
                  value: t(server.connector.transport === 'sse' ? 'transportSse' : 'transportStreamableHttp'),
                },
              ]
            : [{ label: t('network'), value: network }]),
          { label: t('tools'), value: tools.length || server.verifiedTools || 0 },
        ]}
        tags={server.categories.map((category) => ({
          label: category.name,
          href: `${marketBase}?${server.mcpKind === 'connector' ? 'type=connector&' : ''}category=${encodeURIComponent(category.slug)}`,
        }))}
      />

      <MarketDetailShell
        navigationLabel={t('detailNavigation')}
        tabs={[{ href: '#tool', label: tool.name }]}
        aside={(
          <section className="rounded-lg bg-muted/30 p-5">
            <h2 className="text-sm font-semibold text-foreground">{t('tools')}</h2>
            <div className="mt-3 space-y-1">
              {tools.filter((candidate) => candidate.name !== tool.name).slice(0, 12).map((candidate) => (
                <Link
                  key={candidate.name}
                  href={`${serverHref}/tools/${encodeURIComponent(candidate.name)}`}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <code className="min-w-0 flex-1 truncate font-mono">{candidate.name}</code>
                  <ChevronRight className="size-3.5 shrink-0" />
                </Link>
              ))}
            </div>
            <Link href={serverHref} className="ui-button-secondary mt-4 h-9 w-full">
              {t('viewDetails')}
            </Link>
          </section>
        )}
      >
        <div id="tool" className="scroll-mt-24">
          <McpToolCatalog tools={[tool]} labels={labels} />
        </div>
      </MarketDetailShell>
    </DashboardPage>
  );
}
