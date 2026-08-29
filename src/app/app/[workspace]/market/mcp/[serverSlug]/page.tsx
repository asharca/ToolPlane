import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ExternalLink,
  FileText,
  PackageCheck,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketServer, getWorkspaceForUser } from '@/lib/workspace/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { deployServerAction } from '@/lib/workspace/actions';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { McpToolCatalog } from '@/components/dashboard/McpToolCatalog';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import { ToolPlayground } from '@/components/dashboard/ToolPlayground';
import { MarketDetailHeader } from '@/components/dashboard/market/MarketDetailShell';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export default async function McpMarketDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; serverSlug: string }>;
}) {
  const [{ workspace: slug, serverSlug }, t, mcpT, locale] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('console.mcp'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/mcp/${serverSlug}`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const server = await getMarketServer(serverSlug, workspace.id);
  if (!server) notFound();

  const deploymentHref = server.deploymentId
    ? `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(server.deploymentId)}${
        server.deploymentStatus === 'setup_required' ? '?tab=variables' : ''
      }`
    : null;
  const requiredEnvironmentCount = server.recipe.requiredEnv.length;
  const marketBase = `/app/${encodeURIComponent(slug)}/market/mcp`;
  const marketHref = `${marketBase}${server.mcpKind === 'connector' ? '?type=connector' : ''}`;
  const network = server.recipe.network === 'none' ? t('networkNone') : t('networkIsolated');
  const inspectorRunning = Boolean(
    server.inspectorSandbox
    && effectiveStatus(server.inspectorSandbox.deploymentId, server.inspectorSandbox.status) === 'running',
  );
  const tools = server.mcpKind === 'server' || inspectorRunning ? server.tools : [];
  const inspectorSandboxes = server.mcpKind === 'connector' && server.deploymentId
    ? (await listSandboxes(workspace.id))
      .filter((sandbox) => sandbox.kind === 'docker' || sandbox.kind === 'connector')
      .map((sandbox) => ({
        id: sandbox.id,
        name: sandbox.name,
        kind: sandbox.kind,
        running: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) === 'running',
        networkEnabled: sandbox.network !== 'none',
      }))
    : [];
  const toolCount = tools.length;
  const sourceHref = externalUrl(
    server.sourceUrl ?? (server.recipe.source === 'github' ? server.recipe.ref : ''),
  );
  const sourceLabel = sourceHref && new URL(sourceHref).hostname.toLowerCase() === 'github.com'
    ? 'GitHub'
    : server.recipe.source;
  const toolCatalogLabels = {
    title: mcpT('schemaJson'),
    description: mcpT('toolCatalogDescription'),
    count: mcpT('toolsCount', { count: tools.length }),
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
        backHref={marketHref}
        backLabel={t('backToMcp')}
        iconUrl={server.iconUrl}
        icon={<Box className="size-7" />}
        type={t(server.mcpKind === 'connector' ? 'kindMcpConnector' : 'kindMcp')}
        title={server.name}
        publisher={t('publishedBy', { name: server.author ?? t('unknownPublisher') })}
        summary={server.description ?? t('noDescription')}
        facts={[
          { label: t('popularity'), value: server.stars.toLocaleString(locale) },
          ...(toolCount ? [{ label: t('tools'), value: toolCount }] : []),
          {
            label: t('source'),
            value: sourceHref ? (
              <a
                href={sourceHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {sourceLabel} <ExternalLink className="size-3" />
              </a>
            ) : server.recipe.source,
          },
          ...(server.connector ? [
            { label: t('connectorEndpoint'), value: server.connector.endpointHost },
            {
              label: t('connectorTransport'),
              value: t(server.connector.transport === 'sse' ? 'transportSse' : 'transportStreamableHttp'),
            },
            {
              label: t('connectorAuthentication'),
              value: t(server.connector.authType === 'bearer'
                ? 'authBearer'
                : server.connector.authType === 'headers'
                  ? 'authHeaders'
                  : 'authNone'),
            },
          ] : [{ label: t('network'), value: network }]),
        ]}
        tags={[
          { label: t('verified') },
          ...(server.isOfficial ? [{ label: t('official') }] : []),
          ...server.categories.map((category) => ({
            label: category.name,
            href: `${marketBase}?${server.mcpKind === 'connector' ? 'type=connector&' : ''}category=${encodeURIComponent(category.slug)}`,
          })),
        ]}
      />

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <main className="min-w-0 space-y-10">
          <section>
            <div className="flex items-center gap-2.5">
              <FileText className="size-[18px] text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('about')}</h2>
            </div>
            {server.readme ? (
              <SafeStreamdown className="mt-4 max-w-none text-sm leading-7 text-foreground">
                {server.readme}
              </SafeStreamdown>
            ) : (
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{server.description ?? t('noDescription')}</p>
            )}
          </section>

          {server.mcpKind === 'server' || inspectorRunning ? (
            tools.length ? (
              <McpToolCatalog
                tools={tools}
                labels={toolCatalogLabels}
                hrefForTool={(name) => `${marketBase}/${encodeURIComponent(server.slug)}/tools/${encodeURIComponent(name)}`}
              />
            ) : (
              <section className="rounded-lg bg-muted/25 px-5 py-5">
                <div className="flex items-start gap-2.5">
                  <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{mcpT('schemaJson')}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {mcpT(server.mcpKind === 'server' ? 'mcpReportedNoTools' : 'startMcpToSelectTools')}
                    </p>
                  </div>
                </div>
              </section>
            )
          ) : null}

          {server.mcpKind === 'connector' && server.deploymentId ? (
            <section className="ui-panel overflow-hidden">
              <header className="border-b border-border px-5 py-4">
                <h2 className="text-sm font-semibold text-foreground">{t('inspector')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('inspectorDescription')}</p>
              </header>
              <div className="px-5 py-5">
                <ToolPlayground
                  workspace={slug}
                  deploymentId={server.deploymentId}
                  tools={tools}
                  sandboxes={inspectorSandboxes}
                  connectedSandboxId={server.inspectorSandbox?.id}
                  credentialsRequired={server.deploymentStatus === 'setup_required'}
                />
              </div>
            </section>
          ) : null}
        </main>

        <aside className="space-y-5 xl:sticky xl:top-20 xl:self-start">
          {server.mcpKind === 'connector' ? <section className="rounded-lg bg-muted/35 p-5">
            {deploymentHref ? (
              <>
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{t('alreadyAddedTitle')}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('alreadyAddedDescription')}</p>
                  </div>
                </div>
                <Link href={deploymentHref} className="ui-button-primary mt-5 h-10 w-full">
                  {t('manageDeployment')} <ArrowRight className="size-4" />
                </Link>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-foreground" />
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      {t(server.mcpKind === 'connector' ? 'readyToConnect' : 'readyToDeploy')}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {requiredEnvironmentCount
                        ? t(server.mcpKind === 'connector' ? 'connectorNeedsConfiguration' : 'deploymentNeedsConfiguration', { count: requiredEnvironmentCount })
                        : t(server.mcpKind === 'connector' ? 'connectorNoConfiguration' : 'deploymentNoConfiguration')}
                    </p>
                  </div>
                </div>
                <form action={deployServerAction} className="mt-5">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="serverId" value={server.id} />
                  <SubmitButton
                    flash={false}
                    pendingLabel={t(server.mcpKind === 'connector' ? 'connecting' : 'adding')}
                    className="ui-button-primary h-10 w-full"
                  >
                    {t(server.mcpKind === 'connector' ? 'connectToWorkspace' : 'addToWorkspace')} <ArrowRight className="size-4" />
                  </SubmitButton>
                </form>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {t(server.mcpKind === 'connector' ? 'connectorRedirectHint' : 'deploymentRedirectHint')}
                </p>
              </>
            )}
          </section> : null}

          <section className="px-1 py-2">
            <div className="flex items-center gap-2.5">
              <Wrench className="size-[18px] text-muted-foreground" />
              <h2 className="font-semibold text-foreground">
                {t(server.mcpKind === 'connector' ? 'connectorConfiguration' : 'deploymentRecipe')}
              </h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(server.mcpKind === 'connector' ? 'connectorConfigurationDescription' : 'deploymentRecipeDescription')}
            </p>
            <dl className="mt-5 space-y-4 text-sm">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">{t('source')}</dt>
                <dd className="mt-1.5 font-medium text-foreground">{server.recipe.source}</dd>
              </div>
              {server.connector ? (
                <>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">{t('connectorTransport')}</dt>
                    <dd className="mt-1.5 font-medium text-foreground">
                      {t(server.connector.transport === 'sse' ? 'transportSse' : 'transportStreamableHttp')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">{t('connectorAuthentication')}</dt>
                    <dd className="mt-1.5 font-medium text-foreground">
                      {t(server.connector.authType === 'bearer'
                        ? 'authBearer'
                        : server.connector.authType === 'headers'
                          ? 'authHeaders'
                          : 'authNone')}
                    </dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('network')}</dt>
                  <dd className="mt-1.5 font-medium text-foreground">{network}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  {t(server.mcpKind === 'connector' ? 'connectorEndpoint' : 'packageReference')}
                </dt>
                <dd className="mt-1.5 break-all rounded-md bg-muted/35 px-3 py-2 font-mono text-xs text-foreground">
                  {server.connector?.endpointHost ?? server.recipe.ref}
                </dd>
              </div>
              <div>
                <dt className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <PackageCheck className="size-3.5" /> {t('requiredEnvironment')}
                </dt>
                <dd className="mt-2">
                  {requiredEnvironmentCount ? (
                    <div className="flex flex-wrap gap-1.5">
                      {server.recipe.requiredEnv.map((key) => (
                        <code key={key} className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{key}</code>
                      ))}
                    </div>
                  ) : <span className="text-muted-foreground">{t('none')}</span>}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </DashboardPage>
  );
}
