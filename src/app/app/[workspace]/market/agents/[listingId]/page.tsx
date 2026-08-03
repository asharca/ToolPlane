import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ArrowLeft,
  Bot,
  Boxes,
  CheckCircle2,
  Copy,
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
  const [{ workspace: slug, listingId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('agentMarket'),
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

  return (
    <DashboardPage className="space-y-6">
      <Link href={marketBase} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> {t('market')}
      </Link>

      <header className="rounded-xl border border-border bg-card p-5 sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {listing.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={listing.iconUrl} alt="" width={72} height={72} className="size-[4.5rem] rounded-xl object-cover" />
          ) : (
            <span className="flex size-[4.5rem] shrink-0 items-center justify-center rounded-xl bg-brand-soft text-2xl font-bold text-accent-foreground">
              {avatarLabel(listing.name)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded bg-brand-soft px-2 py-1 font-semibold text-accent-foreground">
                {t('version', { version: release.version })}
              </span>
              <span className="inline-flex items-center gap-1"><Copy className="size-3.5" />{t('cloneCount', { count: listing.installCount })}</span>
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{listing.name}</h1>
            {author ? <p className="mt-2 text-sm text-muted-foreground">{t('publishedBy', { name: author })}</p> : null}
            {listing.summary ? <p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground">{listing.summary}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {listing.categories.map((category) => (
                <Link
                  key={category.slug}
                  href={`${marketBase}?category=${encodeURIComponent(category.slug)}`}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {category.name}
                </Link>
              ))}
              {listing.tags.map((tag) => (
                <span key={tag} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">{tag}</span>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-w-0 space-y-6">
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2.5">
              <Bot className="size-[18px] text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('howItWorks')}</h2>
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

          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2.5">
              <Boxes className="size-[18px] text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('includedTools')}</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('includedToolsDescription')}</p>
            <div className="mt-4 divide-y divide-border border-y border-border">
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
            <section className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2.5">
                <Network className="size-[18px] text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('agentStructure')}</h2>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {subAgents.map((agent) => (
                  <div key={agent.key} className="rounded-md border border-border p-4">
                    <p className="font-medium text-foreground">{agent.name}</p>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{agent.systemPrompt ?? t('noSystemPrompt')}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <section className="rounded-xl border border-border bg-card p-5">
            <ShieldCheck className="size-5 text-foreground" />
            <h2 className="mt-3 text-lg font-semibold text-foreground">{t('clonePanelTitle')}</h2>
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
            <div className="mt-5 space-y-3 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">
              <p className="flex gap-2"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('copiesDefinition')}</p>
              <p className="flex gap-2"><Settings2 className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('matchesProvider')}</p>
              <p className="flex gap-2"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-foreground" />{t('neverCopiesSecrets')}</p>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-foreground">{t('configurationSummary')}</h2>
            <dl className="mt-3 divide-y divide-border text-xs">
              {[
                [t('modelPreference'), rootAgent.modelRequirement?.model ?? t('notSpecified')],
                [t('maximumSteps'), String(rootAgent.maxSteps)],
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
        </aside>
      </div>
    </DashboardPage>
  );
}
