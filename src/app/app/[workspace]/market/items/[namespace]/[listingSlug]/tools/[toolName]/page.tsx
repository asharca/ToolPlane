import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Box, ChevronRight } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getMarketListing } from '@/lib/market/listings';
import { parseMcpMarketManifest } from '@/lib/market/resources';
import { effectiveStatus } from '@/lib/process/supervisor';
import { hasVerifiedMcpToolCatalog, readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';
import { readMcpInspectorConnection } from '@/lib/workspace/inspector-connection';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import {
  MarketDetailHeader,
  MarketDetailShell,
} from '@/components/dashboard/market/MarketDetailShell';

export const dynamic = 'force-dynamic';

export default async function MarketItemToolPage({
  params,
}: {
  params: Promise<{ workspace: string; namespace: string; listingSlug: string; toolName: string }>;
}) {
  const [{ workspace: workspaceSlug, namespace, listingSlug, toolName }, t, mcpT] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('console.mcp'),
  ]);
  const itemHref = `/app/${encodeURIComponent(workspaceSlug)}/market/items/${encodeURIComponent(namespace)}/${encodeURIComponent(listingSlug)}`;
  const currentPath = `${itemHref}/tools/${encodeURIComponent(toolName)}`;
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(currentPath)}`);
  const workspace = await getWorkspaceForUser(workspaceSlug, user.id);
  if (!workspace) redirect('/app');

  const listing = await getMarketListing(namespace, listingSlug);
  if (!listing?.latestRelease || listing.kind !== 'mcp') notFound();
  const manifest = parseMcpMarketManifest(
    listing.latestRelease.manifest,
    listing.latestRelease.checksum,
  ).mcp;
  const connector = manifest.recipe.source === 'remote';
  let tools;
  if (connector) {
    const install = await db.marketInstall.findUnique({
      where: {
        targetWorkspaceId_listingId: {
          targetWorkspaceId: workspace.id,
          listingId: listing.id,
        },
      },
      select: { deployment: { select: { workspaceId: true, installCfg: true } } },
    });
    const deployment = install?.deployment?.workspaceId === workspace.id ? install.deployment : null;
    const connection = readMcpInspectorConnection(deployment?.installCfg);
    const sandbox = connection ? await db.sandbox.findFirst({
      where: { id: connection.sandboxId, workspaceId: workspace.id },
      select: { deployment: { select: { id: true, status: true } } },
    }) : null;
    if (!sandbox || effectiveStatus(sandbox.deployment.id, sandbox.deployment.status) !== 'running') notFound();
    tools = readMcpToolCatalog(deployment?.installCfg);
  } else {
    const server = (await db.marketListing.findUnique({
      where: { id: listing.id },
      select: {
        sourceServer: { select: { installCfg: true, verifiedAt: true, verifiedTools: true } },
      },
    }))?.sourceServer;
    if (!server || !hasVerifiedMcpToolCatalog(server)) notFound();
    tools = readMcpToolCatalog(server.installCfg);
  }
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) notFound();

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
        backHref={itemHref}
        backLabel={listing.name}
        iconUrl={listing.iconUrl}
        icon={<Box className="size-7" />}
        type={t(connector ? 'kindMcpConnector' : 'kindMcp')}
        title={tool.title ?? tool.annotations?.title ?? tool.name}
        publisher={listing.namespace}
        summary={tool.description ?? mcpT('noDescription')}
        facts={[
          { label: t('source'), value: manifest.recipe.source },
          { label: t('version'), value: `v${listing.latestRelease.version}` },
          { label: t('tools'), value: tools.length },
        ]}
        tags={listing.categories.map((category) => ({
          label: category.name,
          href: `/app/${encodeURIComponent(workspaceSlug)}/market/mcp?${connector ? 'type=connector&' : ''}category=${encodeURIComponent(category.slug)}`,
        }))}
      />

      <MarketDetailShell
        navigationLabel={t('detailNavigation')}
        tabs={[{ href: '#tool', label: tool.name }]}
        aside={tools.length > 1 ? (
          <section className="rounded-lg bg-muted/30 p-5">
            <h2 className="text-sm font-semibold text-foreground">{t('tools')}</h2>
            <div className="mt-3 space-y-1">
              {tools.filter((candidate) => candidate.name !== tool.name).slice(0, 12).map((candidate) => (
                <Link
                  key={candidate.name}
                  href={`${itemHref}/tools/${encodeURIComponent(candidate.name)}`}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <code className="min-w-0 flex-1 truncate font-mono">{candidate.name}</code>
                  <ChevronRight className="size-3.5 shrink-0" />
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      >
        <div id="tool" className="scroll-mt-24">
          <McpToolCatalog tools={[tool]} labels={labels} />
        </div>
      </MarketDetailShell>
    </DashboardPage>
  );
}
