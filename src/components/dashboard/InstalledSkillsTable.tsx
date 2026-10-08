'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Brain, MoreHorizontal, Search, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { DashboardEmptyState, DashboardTable } from '@/components/dashboard/DashboardUI';
import { uninstallSkillAction } from '@/lib/workspace/actions';

export type InstalledSkillListItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  marketManaged: boolean;
  iconUrl: string | null;
  createdAt: string;
};

const PAGE_SIZE = 20;

export function InstalledSkillsTable({ slug, skills }: { slug: string; skills: InstalledSkillListItem[] }) {
  const t = useTranslations('console.skills');
  const common = useTranslations('common');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const availableIds = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills]);
  const activeSelectedIds = selectedIds.filter((id) => availableIds.has(id));
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => [skill.name, skill.slug, skill.description ?? ''].some((value) => value.toLocaleLowerCase().includes(term)));
  }, [skills, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const marketHref = `/app/${slug}/market/installed`;

  return <section className="min-w-0 space-y-4">
    <Input value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder={t('searchSkills')} aria-label={t('searchSkills')} leftIcon={<Search className="size-4" />} className="w-full sm:max-w-md" />
    {filtered.length ? <DashboardTable
      selectedRowIds={activeSelectedIds}
      onSelectionChange={setSelectedIds}
      selectionActions={({ selectedRowIds }) => skills.some((skill) => skill.marketManaged && selectedRowIds.includes(skill.id)) ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('managedSelectionHint')}</span>
          <ButtonLink href={marketHref} variant="secondary" size="sm">{t('manageMarketInstall')}</ButtonLink>
        </div>
      ) : (
        <form action={uninstallSkillAction} className="flex items-center gap-2">
          <input type="hidden" name="workspace" value={slug} />
          {selectedRowIds.map((id) => <input key={id} type="hidden" name="installId" value={id} />)}
          <ConfirmSubmitButton triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')} ({selectedRowIds.length})</>} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${t('uninstall')} (${selectedRowIds.length})?`} pendingLabel={`${t('uninstall')}…`} className="items-center" triggerVariant="secondary" triggerSize="sm" confirmVariant="primary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
        </form>
      )}
      headers={[{ label: t('skillColumn') }, { label: t('added') }, { label: t('actions'), align: 'right' }]}
      rows={visible.map((skill) => ({ id: skill.id, cells: [
        <Link key="identity" href={`/app/${slug}/skills/${skill.id}`} aria-label={skill.name} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          {skill.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={skill.iconUrl} alt="" width={32} height={32} className="size-8 shrink-0 rounded object-cover" />
          ) : <Brain className="size-5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0"><span className="block truncate font-medium">{skill.name}</span><span className="block truncate text-xs text-muted-foreground">{skill.description || skill.slug}</span></span>
        </Link>,
        <span key="date" className="text-xs text-muted-foreground">{skill.createdAt}</span>,
        <div key="actions" className="flex items-center justify-end gap-1">
          <ButtonLink href={`/app/${slug}/skills/${skill.id}`} variant="secondary" size="sm">{t('use')}</ButtonLink>
          <Popover align="end">
            <PopoverTrigger><Button type="button" variant="ghost" size="icon" aria-label={`${t('actions')}: ${skill.name}`}><MoreHorizontal className="size-4" /></Button></PopoverTrigger>
            <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-2">
              {skill.marketManaged ? <ButtonLink href={marketHref} variant="ghost" size="sm">{t('manageMarketInstall')}</ButtonLink> : <form action={uninstallSkillAction}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="installId" value={skill.id} />
                <ConfirmSubmitButton triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')}</>} triggerAriaLabel={`${t('uninstall')}: ${skill.name}`} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${t('uninstall')} ${skill.name}?`} pendingLabel={`${t('uninstall')}…`} promptClassName="break-words text-xs text-muted-foreground" className="flex-wrap" triggerVariant="ghost" triggerSize="sm" confirmVariant="primary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
              </form>}
            </PopoverContent>
          </Popover>
        </div>,
      ] }))}
    /> : skills.length ? <DashboardEmptyState title={t('noMatchingSkills')} actions={<Button variant="secondary" onClick={() => { setQuery(''); setPage(1); }}>{t('clearFilters')}</Button>} /> : null}
    {skills.length ? <nav aria-label={common('pagination')} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{currentPage} / {totalPages}</p>
      <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{common('previous')}</Button><Button variant="secondary" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>{common('next')}</Button></div>
    </nav> : null}
  </section>;
}
