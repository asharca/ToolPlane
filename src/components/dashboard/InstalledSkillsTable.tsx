'use client';
import { Button } from '@/components/motion/button';
import { Checkbox } from '@/components/motion/checkbox';


import Link from 'next/link';
import { useState } from 'react';
import { Brain, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import { uninstallSkillAction } from '@/lib/workspace/actions';

export type InstalledSkillListItem = {
  id: string;
  name: string;
  iconUrl: string | null;
  createdAt: string;
};

export function InstalledSkillsTable({
  slug,
  skills,
}: {
  slug: string;
  skills: InstalledSkillListItem[];
}) {
  const t = useTranslations('console.skills');
  const agentT = useTranslations('console.agents');
  const common = useTranslations('common');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const availableIds = new Set(skills.map((skill) => skill.id));
  const activeSelected = new Set([...selected].filter((id) => availableIds.has(id)));
  const selectedIds = [...activeSelected];
  const allSelected = skills.length > 0 && activeSelected.size === skills.length;
  const someSelected = activeSelected.size > 0 && !allSelected;


  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(skills.map((skill) => skill.id)));
  }

  function toggleSkill(id: string) {
    setSelected((current) => {
      const next = new Set([...current].filter((selectedId) => availableIds.has(selectedId)));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>{selectedIds.length > 0 ? (
            <form
              action={uninstallSkillAction}
              role="toolbar"
              aria-label={agentT('selectedResources', { count: activeSelected.size })}
              className="flex min-h-8 flex-wrap items-center justify-between gap-2"
            >
              <input type="hidden" name="workspace" value={slug} />
              {selectedIds.map((id) => <input key={id} type="hidden" name="installId" value={id} />)}
              <div className="flex items-center gap-2.5">
                <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary-foreground">
                  {activeSelected.size}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {agentT('selectedResources', { count: activeSelected.size })}
                </span>
                <Button type="button" onClick={() => setSelected(new Set())} aria-label={agentT('clearSelection')} title={agentT('clearSelection')} variant="ghost" size="icon" className="flex items-center justify-center"><X className="size-3.5" /></Button>
              </div>
              <ConfirmSubmitButton triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')} ({activeSelected.size})</>} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${t('uninstall')} (${activeSelected.size})?`} pendingLabel={`${t('uninstall')}...`} className="items-center" triggerVariant="secondary" triggerSize="sm" confirmVariant="primary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
            </form>
          ) : null}<DashboardTable headers={[
        {
          label: (
            <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label={agentT('selectMatches', { count: skills.length })} indeterminate={someSelected && !allSelected} />
          ),
          width: '3rem',
        },
        { label: t('skillColumn') },
        { label: t('added') },
        { label: t('actions'), align: 'right' },
      ]} rows={skills.map((skill) => {
        const isSelected = activeSelected.has(skill.id);
        return (
          {id: skill.id, cells: [<><Checkbox checked={isSelected} onCheckedChange={() => toggleSkill(skill.id)} aria-label={agentT('selectResource', { name: skill.name })} /></>,
<><Link
                href={`/app/${slug}/skills/${skill.id}`}
                className="flex items-center gap-2.5 px-4 py-3 font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              >
                {skill.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={skill.iconUrl}
                    alt=""
                    width={20}
                    height={20}
                    className="size-5 rounded object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-5 items-center justify-center rounded bg-muted text-foreground"
                  >
                    <Brain className="size-3.5" />
                  </span>
                )}
                {skill.name}
              </Link></>,
<>{skill.createdAt}</>,
<><form action={uninstallSkillAction} className="inline-flex">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="installId" value={skill.id} />
                <ConfirmSubmitButton triggerLabel={<Trash2 className="size-3.5" />} triggerAriaLabel={`${t('uninstall')}: ${skill.name}`} triggerTitle={t('uninstall')} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${t('uninstall')} ${skill.name}?`} pendingLabel={`${t('uninstall')}...`} promptClassName="max-w-40 truncate text-xs text-muted-foreground" className="items-center justify-end" triggerVariant="secondary" triggerSize="md" triggerClassName="inline-flex items-center justify-center" confirmVariant="primary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
              </form></>]}
        );
      })} /></>
  );
}
