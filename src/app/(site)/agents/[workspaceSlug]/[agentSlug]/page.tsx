import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
  Sparkles,
} from 'lucide-react';
import { AgentMarketCloneForm } from '@/components/agents/AgentMarketCloneForm';
import { formatCount } from '@/components/cards/EntityCard';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getPublicAgentListing } from '@/lib/agents/market';
import { listWorkspacesForUser } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

function avatarLabel(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? 'A';
}

function cloneErrorMessage(
  t: Awaited<ReturnType<typeof getTranslations<'agentMarket'>>>,
  error?: string,
) {
  if (!error) return null;
  if (error === 'release_not_found' || error === 'listing_unavailable') return t('releaseUnavailable');
  return t('invalidInstall');
}

export default async function PublicAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; agentSlug: string }>;
  searchParams: Promise<{ cloneError?: string }>;
}) {
  const [{ workspaceSlug, agentSlug }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('agentMarket'),
  ]);
  const detail = await getPublicAgentListing(workspaceSlug, agentSlug);
  if (!detail) notFound();

  const user = await getCurrentUser();
  const workspaces = user ? await listWorkspacesForUser(user.id) : [];
  const { listing, release, manifest, workspace } = detail;
  const rootAgent = manifest.agents.find((agent) => agent.key === manifest.rootAgentKey);
  if (!rootAgent) notFound();

  const subAgents = manifest.agents.filter((agent) => agent.key !== manifest.rootAgentKey);
  const returnTo = `/agents/${encodeURIComponent(workspace.slug)}/${encodeURIComponent(listing.slug)}`;
  const cloneError = cloneErrorMessage(t, query.cloneError);
  const preferredModel = rootAgent.modelRequirement?.model ?? t('notSpecified');
  const runtime = rootAgent.runtime?.kind === 'hermes'
    ? t('hermesRuntime')
    : t('nativeRuntime');
  const contract = [
    [CheckCircle2, t('copiesDefinition')],
    [Settings2, t('matchesProvider')],
    [KeyRound, t('neverCopiesSecrets')],
  ] as const;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-8 sm:px-6 sm:pt-10 lg:px-8 lg:pb-24">
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> {t('market')}
      </Link>

      <header className="mt-8 border-b border-border pb-9 sm:pb-11">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-foreground text-2xl font-bold text-background sm:size-20">
            {avatarLabel(listing.name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-2 py-1 text-[11px] font-semibold text-accent-foreground">
                <Sparkles className="size-3" /> {t('version', { version: release.version })}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Copy className="size-3.5" /> {t('cloneCount', { count: listing.installCount })}
              </span>
            </div>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
              {listing.name}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">{t('publishedBy', { name: workspace.name })}</p>
            {listing.summary ? (
              <p className="mt-5 max-w-3xl text-pretty text-base leading-7 text-muted-foreground">{listing.summary}</p>
            ) : null}
            {listing.tags.length > 0 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {listing.tags.map((tag) => (
                  <span key={tag} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid gap-10 pt-9 lg:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.65fr)] lg:gap-14">
        <main className="min-w-0 space-y-10">
          <section>
            <div className="flex items-center gap-2.5">
              <Bot className="size-[18px] text-muted-foreground" />
              <h2 className="text-base font-semibold text-foreground">{t('howItWorks')}</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('promptDescription')}</p>
            <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
              {rootAgent.systemPrompt ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-6 text-foreground sm:p-6">
                  {rootAgent.systemPrompt}
                </pre>
              ) : (
                <p className="p-5 text-sm text-muted-foreground">{t('noSystemPrompt')}</p>
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2.5">
              <Boxes className="size-[18px] text-muted-foreground" />
              <h2 className="text-base font-semibold text-foreground">{t('includedTools')}</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('includedToolsDescription')}</p>
            <div className="mt-4 divide-y divide-border border-y border-border">
              {manifest.deployments.map((deployment) => (
                <div key={deployment.key} className="grid gap-2 py-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-center">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Server className="size-4" /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{deployment.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('catalogMcp')}</p>
                  </div>
                  <span className={`text-xs font-medium ${deployment.requiredEnv.length ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                    {deployment.requiredEnv.length ? t('requiresSetup') : t('automatic')}
                  </span>
                </div>
              ))}
              {manifest.skills.map((skill) => (
                <div key={skill.key} className="grid gap-2 py-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-center">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><PackageCheck className="size-4" /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{skill.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('customSkill')}</p>
                  </div>
                  <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{t('automatic')}</span>
                </div>
              ))}
              {manifest.toolkits.map((toolkit) => (
                <div key={toolkit.key} className="grid gap-2 py-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-center">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Boxes className="size-4" /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{toolkit.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('toolkitBundle')}</p>
                  </div>
                  <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{t('automatic')}</span>
                </div>
              ))}
              {manifest.deployments.length + manifest.skills.length + manifest.toolkits.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">{t('notSpecified')}</p>
              ) : null}
            </div>
          </section>

          {subAgents.length > 0 ? (
            <section>
              <div className="flex items-center gap-2.5">
                <Network className="size-[18px] text-muted-foreground" />
                <h2 className="text-base font-semibold text-foreground">{t('agentStructure')}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('agentStructureDescription')}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {subAgents.map((agent) => (
                  <div key={agent.key} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-brand-soft font-semibold text-accent-foreground">
                        {avatarLabel(agent.name)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t('subAgentDefinition')}</p>
                      </div>
                    </div>
                    <p className="mt-4 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {agent.systemPrompt ?? t('noSystemPrompt')}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </main>

        <aside className="order-first space-y-4 lg:order-last lg:sticky lg:top-24 lg:self-start">
          <section className="rounded-xl bg-foreground p-5 text-background sm:p-6">
            <ShieldCheck className="size-5" />
            <h2 className="mt-4 text-lg font-semibold text-background">{t('clonePanelTitle')}</h2>
            <p className="mt-2 text-sm leading-6 text-background/65">{t('clonePanelDescription')}</p>
            {cloneError ? (
              <p role="alert" className="mt-4 rounded-md bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-200">{cloneError}</p>
            ) : null}
            <div className="mt-5 border-t border-background/15 pt-5 [&_.ui-input]:border-background/20 [&_.ui-input]:bg-background/10 [&_.ui-input]:text-background [&_label_span]:text-background/70">
              {!user ? (
                <Link href={`/app/login?next=${encodeURIComponent(returnTo)}`} className="inline-flex h-11 w-full items-center justify-center rounded-md bg-background px-4 text-sm font-semibold text-foreground hover:bg-background/90">
                  {t('signInToClone')}
                </Link>
              ) : workspaces.length > 0 ? (
                <AgentMarketCloneForm
                  releaseId={release.id}
                  idempotencyKey={randomUUID()}
                  returnTo={returnTo}
                  workspaces={workspaces}
                  labels={{ workspace: t('selectWorkspace'), submit: t('cloneAgent'), pending: t('cloningAgent') }}
                />
              ) : (
                <div>
                  <h3 className="text-sm font-semibold text-background">{t('noWorkspaceTitle')}</h3>
                  <p className="mt-1 text-xs leading-5 text-background/60">{t('noWorkspaceDescription')}</p>
                  <Link href="/app" className="mt-4 inline-flex text-sm font-semibold text-background hover:underline">{t('openDashboard')}</Link>
                </div>
              )}
            </div>
            <div className="mt-5 space-y-3 border-t border-background/15 pt-5">
              {contract.map(([Icon, text]) => (
                <div key={text} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 text-xs leading-5 text-background/65">
                  <Icon className="mt-0.5 size-3.5 text-background" />
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-foreground">{t('configurationSummary')}</h2>
            <dl className="mt-4 divide-y divide-border text-xs">
              {[
                [t('runtime'), runtime],
                [t('modelPreference'), preferredModel],
                [t('maximumSteps'), String(rootAgent.maxSteps)],
                [t('mcp'), String(release.summary.deploymentCount)],
                [t('skills'), String(release.summary.skillCount)],
                [t('toolkits'), String(release.summary.toolkitCount)],
                [t('subAgents'), String(release.summary.subAgentCount)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="max-w-40 truncate text-right font-semibold text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="border-t border-foreground pt-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRound className="size-4" /> {t('safetyBoundary')}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('safetyBoundaryDescription')}</p>
            <p className="mt-3 font-mono text-[10px] text-muted-foreground">sha256:{release.checksum.slice(0, 12)} · {formatCount(release.summary.resourceCount)}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
