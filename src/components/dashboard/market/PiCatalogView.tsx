import { getTranslations } from 'next-intl/server';
import { ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Button } from '@/components/motion/button';
import { DashboardEmptyState, DashboardPage } from '@/components/dashboard/DashboardUI';
import { Puzzle } from 'lucide-react';
import { listOfficialPiPackages } from '@/lib/market/pi-package-catalog';
import { PiOfficialInstallForm } from '@/components/dashboard/market/PiCatalogForms';

export async function PiCatalogNavigation({ workspace, active }: { workspace: string; active: string }) {
  const t = await getTranslations('console.market.piCatalog');
  const base = `/app/${encodeURIComponent(workspace)}/market`;
  return <nav aria-label={t('navigation')} className="flex flex-wrap gap-2">
    {[['official', `${base}/pi-packages`], ['toolplane', `${base}/pi-packages?view=toolplane`]].map(([view, href]) => <ButtonLink key={view} href={href} variant={active === view ? 'primary' : 'ghost'} size="sm" aria-current={active === view ? 'page' : undefined}>{t(`views.${view}`)}</ButtonLink>)}
    <ButtonLink href={`/app/${encodeURIComponent(workspace)}/toolkits/pi-packages`} variant="secondary" size="sm">{t('compose')}</ButtonLink>
    <ButtonLink href={`${base}/installed`} variant="ghost" size="sm">{t('installed')}</ButtonLink>
  </nav>;
}

export async function PiCatalogView({ workspace, query, page }: {
  workspace: { slug: string }; query: string; page: number;
}) {
  const t = await getTranslations('console.market.piCatalog');
  const base = `/app/${encodeURIComponent(workspace.slug)}/market/pi-packages`;

    const result = await listOfficialPiPackages({ query, page }).catch(() => null);
    return <DashboardPage className="space-y-6">
      <h2 className="text-2xl font-semibold">{t('officialTitle')}</h2>
      <PiCatalogNavigation workspace={workspace.slug} active="official" />
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('officialHelp')}</p>
      <form className="flex flex-wrap gap-2"><input type="hidden" name="view" value="official" /><Input label={t('search')} name="q" defaultValue={query} maxLength={200} className="min-w-0 flex-1" /><Button type="submit" variant="secondary" size="sm">{t('search')}</Button></form>
      {!result ? <p role="alert" className="text-sm text-destructive">{t('discoveryFailed')}</p> : !result.entries.length ? <DashboardEmptyState icon={Puzzle} title={t('empty')} description={t('emptyHelp')} /> : <div className="grid gap-4 md:grid-cols-2">{result.entries.map((entry) => <article key={entry.source} className="min-w-0 space-y-3 rounded-3xl border border-border bg-card p-4">
        <h3 className="break-words font-semibold">{entry.name}</h3>
        <p className="break-words text-sm text-muted-foreground">{entry.description}</p>
        <p className="break-all text-xs text-muted-foreground">{entry.source}{entry.version ? ` · ${entry.version}` : ''}</p>
        <PiOfficialInstallForm workspace={workspace.slug} entry={entry} />
      </article>)}</div>}
      <nav aria-label={t('pagination')} className="flex justify-between gap-3">
        {page > 1 ? <ButtonLink variant="ghost" size="sm" href={`${base}?${new URLSearchParams({ q: query, page: String(page - 1) })}`}>{t('previous')}</ButtonLink> : <span />}
        {result?.hasMore ? <ButtonLink variant="ghost" size="sm" href={`${base}?${new URLSearchParams({ q: query, page: String(page + 1) })}`}>{t('next')}</ButtonLink> : null}
      </nav>
    </DashboardPage>;
}
