import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  Bot,
  Boxes,
  CheckCircle2,
  Container,
  KeyRound,
  Network,
  PackageCheck,
  Server,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getAgentMarketListing } from '@/lib/agents/market';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { AgentMarketInstallForm } from '@/components/dashboard/market/AgentMarketInstallForm';
import {
  MarketDetailHeader,
  MarketDetailShell,
} from '@/components/dashboard/market/MarketDetailShell';

export const dynamic = 'force-dynamic';

function avatarLabel(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? 'A';
}

export default async function AgentMarketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; listingId: string }>;
  searchParams: Promise<{ cloneError?: string | string[] }>;
}) {
  const [{ workspace: slug, listingId }, query, t, marketT, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations('agentMarket'),
    getTranslations('console.market'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  const currentPath = `/app/${slug}/market/agents/${listingId}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(currentPath)}`);
  const targetWorkspace = await getWorkspaceForUser(slug, user.id);
  if (!targetWorkspace) redirect('/app');

  const detail = await getAgentMarketListing(listingId);
  if (!detail) notFound();
  const { listing, release, manifest, workspace: publisherWorkspace } = detail;
  const rootAgent = manifest.agents.find((agent) => agent.key === manifest.rootAgentKey);
  if (!rootAgent) notFound();
  const subAgents = manifest.agents.filter((agent) => agent.key !== manifest.rootAgentKey);
  const rawError = Array.isArray(query.cloneError) ? query.cloneError[0] : query.cloneError;
  const cloneError = rawError
    ? rawError === 'release_not_found' || rawError === 'listing_unavailable'
      ? t('releaseUnavailable')
      : t('invalidInstall')
    : null;
  const author = listing.author ?? publisherWorkspace?.name ?? null;
  const marketBase = `/app/${encodeURIComponent(slug)}/market/agents`;
  const updatedAt = release.publishedAt ?? listing.updatedAt;
  const formattedDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(updatedAt);

  return (
    <DashboardPage className="space-y-7">
      <MarketDetailHeader
        backHref={marketBase}
        backLabel={t('market')}
        iconUrl={listing.iconUrl}
        icon={<span className="text-2xl font-bold">{avatarLabel(listing.name)}</span>}
        type={marketT('kindAgent')}
        title={listing.name}
        publisher={author ? t('publishedBy', { name: author }) : null}
        summary={listing.summary}
        facts={[
          { label: marketT('version'), value: `v${release.version}` },
          { label: marketT('usageCount'), value: listing.installCount },
          { label: marketT('lastUpdated'), value: <time dateTime={updatedAt.toISOString()}>{formattedDate}</time> },
        ]}
        tags={[
          ...listing.categories.map((category) => ({
            label: category.name,
            href: `${marketBase}?category=${encodeURIComponent(category.slug)}`,
          })),
          ...listing.tags.map((tag) => ({ label: tag })),
        ]}
      />

      <MarketDetailShell
        navigationLabel={marketT('detailNavigation')}
        tabs={[
          { href: '#overview', label: marketT('overview') },
          { href: '#capabilities', label: marketT('capabilities') },
        ]}
        aside={(
          <>
            <section id="install" className="scroll-mt-24 rounded-lg bg-muted/35 p-5">
              <ShieldCheck className="size-5 text-foreground" />
              <h3 className="mt-3 text-lg font-semibold text-foreground">{t('clonePanelTitle')}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('clonePanelDescription')}</p>
              {cloneError ? <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{cloneError}</p> : null}
              <div className="mt-5">
                <AgentMarketInstallForm
                  workspace={slug}
                  releaseId={release.id}
                  idempotencyKey={randomUUID()}
                  returnTo={currentPath}
                  labels={{ submit: t('cloneAgent'), pending: t('cloningAgent') }}
                />
              </div>
              <div className="mt-5 space-y-3 border-t border-border/60 pt-5 text-xs leading-5 text-muted-foreground">
                <p className="flex gap-2"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('copiesDefinition')}</p>
                <p className="flex gap-2"><Container className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('createsSandboxes', { count: release.summary.agentCount })}</p>
                <p className="flex gap-2"><Settings2 className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('matchesProvider')}</p>
                <p className="flex gap-2"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('neverCopiesSecrets')}</p>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-foreground">{t('configurationSummary')}</h3>
              <dl className="mt-3 divide-y divide-border/60 text-xs">
                {[
                  [t('modelPreference'), rootAgent.modelRequirement?.model ?? t('notSpecified')],
                  [t('maximumSteps'), String(rootAgent.maxSteps)],
                  [t('sandboxes'), String(release.summary.agentCount)],
                  [t('mcp'), String(release.summary.deploymentCount)],
                  [t('skills'), String(release.summary.skillCount)],
                  [t('toolkits'), String(release.summary.toolkitCount)],
                  [t('subAgents'), String(release.summary.subAgentCount)],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4 py-2.5">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="max-w-40 truncate text-right font-medium text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        )}
      >
          <section id="overview" className="scroll-mt-24">
            <div className="flex items-center gap-2.5">
              <Bot className="size-[18px] text-muted-foreground" />
              <h3 className="font-semibold text-foreground">{t('howItWorks')}</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('promptDescription')}</p>
            {rootAgent.systemPrompt ? (
              <pre className="mt-4 max-h-[30rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-4 font-mono text-xs leading-6 text-foreground">
                {rootAgent.systemPrompt}
              </pre>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">{t('noSystemPrompt')}</p>
            )}
          </section>

          <section id="capabilities" className="scroll-mt-24">
            <div className="flex items-center gap-2.5">
              <Boxes className="size-[18px] text-muted-foreground" />
              <h3 className="font-semibold text-foreground">{t('includedTools')}</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('includedToolsDescription')}</p>
            <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
              {manifest.deployments.map((item) => (
                <div key={item.key} className="flex items-center gap-3 py-3.5">
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{item.requiredEnv.length ? t('requiresSetup') : t('automatic')}</span>
                </div>
              ))}
              {manifest.skills.map((item) => (
                <div key={item.key} className="flex items-center gap-3 py-3.5">
                  <PackageCheck className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{t('automatic')}</span>
                </div>
              ))}
              {manifest.toolkits.map((item) => (
                <div key={item.key} className="flex items-center gap-3 py-3.5">
                  <Boxes className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{t('automatic')}</span>
                </div>
              ))}
              {release.summary.resourceCount === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{t('notSpecified')}</p>
              ) : null}
            </div>
          </section>

          {subAgents.length > 0 ? (
            <section>
              <div className="flex items-center gap-2.5">
                <Network className="size-[18px] text-muted-foreground" />
                <h3 className="font-semibold text-foreground">{t('agentStructure')}</h3>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {subAgents.map((agent) => (
                  <div key={agent.key} className="rounded-md bg-muted/35 p-4">
                    <p className="font-medium text-foreground">{agent.name}</p>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{agent.systemPrompt ?? t('noSystemPrompt')}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
      </MarketDetailShell>
    </DashboardPage>
  );
}
