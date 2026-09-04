'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
  const selectAllRef = useRef<HTMLInputElement>(null);
  const availableIds = new Set(skills.map((skill) => skill.id));
  const activeSelected = new Set([...selected].filter((id) => availableIds.has(id)));
  const selectedIds = [...activeSelected];
  const allSelected = skills.length > 0 && activeSelected.size === skills.length;
  const someSelected = activeSelected.size > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

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
    <DashboardTable
      headers={selectedIds.length > 0 ? [
        {
          label: (
            <form
              action={uninstallSkillAction}
              role="toolbar"
              aria-label={agentT('selectedResources', { count: activeSelected.size })}
              className="flex min-h-8 flex-wrap items-center justify-between gap-2"
            >
              <input type="hidden" name="workspace" value={slug} />
              {selectedIds.map((id) => <input key={id} type="hidden" name="installId" value={id} />)}
              <div className="flex items-center gap-2.5">
                <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-brand px-1.5 py-0.5 text-xs font-semibold tabular-nums text-brand-foreground">
                  {activeSelected.size}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {agentT('selectedResources', { count: activeSelected.size })}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  aria-label={agentT('clearSelection')}
                  title={agentT('clearSelection')}
                  className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <ConfirmSubmitButton
                triggerLabel={<><Trash2 className="size-3.5" />{t('uninstall')} ({activeSelected.size})</>}
                confirmLabel={common('confirm')}
                cancelLabel={common('cancel')}
                prompt={`${t('uninstall')} (${activeSelected.size})?`}
                pendingLabel={`${t('uninstall')}...`}
                className="items-center"
                triggerClassName="ui-button-secondary ui-button-sm border-red-200 bg-background text-red-700 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-800 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                confirmClassName="ui-button-primary ui-button-sm bg-red-600 hover:bg-red-700"
                cancelClassName="ui-button-ghost ui-button-sm"
              />
            </form>
          ),
          colSpan: 4,
          className: 'bg-brand-soft/35',
        },
      ] : [
        {
          label: (
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label={agentT('selectMatches', { count: skills.length })}
              className="size-4 accent-brand"
            />
          ),
          className: 'w-12',
        },
        { label: t('skillColumn') },
        { label: t('added') },
        { label: t('actions'), align: 'right' },
      ]}
    >
      {skills.map((skill) => {
        const isSelected = activeSelected.has(skill.id);
        return (
          <tr key={skill.id} className={isSelected ? 'bg-muted/35' : undefined}>
            <td className="px-4 py-3">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSkill(skill.id)}
                aria-label={agentT('selectResource', { name: skill.name })}
                className="size-4 accent-brand"
              />
            </td>
            <td className="p-0">
              <Link
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
                    className="flex size-5 items-center justify-center rounded bg-brand-soft text-foreground"
                  >
                    <Brain className="size-3.5" />
                  </span>
                )}
                {skill.name}
              </Link>
            </td>
            <td className="px-4 py-3 text-muted-foreground">
              {skill.createdAt}
            </td>
            <td className="px-4 py-3 text-right">
              <form action={uninstallSkillAction} className="inline-flex">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="installId" value={skill.id} />
                <ConfirmSubmitButton
                  triggerLabel={<Trash2 className="size-3.5" />}
                  triggerAriaLabel={`${t('uninstall')}: ${skill.name}`}
                  triggerTitle={t('uninstall')}
                  confirmLabel={common('confirm')}
                  cancelLabel={common('cancel')}
                  prompt={`${t('uninstall')} ${skill.name}?`}
                  pendingLabel={`${t('uninstall')}...`}
                  className="items-center justify-end"
                  triggerClassName="inline-flex size-8 items-center justify-center rounded-md text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                  confirmClassName="ui-button-primary ui-button-sm bg-red-600 hover:bg-red-700"
                  cancelClassName="ui-button-ghost ui-button-sm"
                  promptClassName="max-w-40 truncate text-xs text-muted-foreground"
                />
              </form>
            </td>
          </tr>
        );
      })}
    </DashboardTable>
  );
}
