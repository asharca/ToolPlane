'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { createCategoryAction, deleteCategoryAction } from '@/lib/admin/category-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Row = { id: string; slug: string; name: string; _count: { servers: number; skills: number; clients: number } };

export function CategoriesPanel({ categories }: { categories: Row[] }) {
  const t = useTranslations('admin');
  const [state, action] = useActionState<AdminActionState, FormData>(createCategoryAction, {});
  const [delState, delAction] = useActionState<AdminActionState, FormData>(deleteCategoryAction, {});
  const input = 'h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <>
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input name="name" placeholder={t('name')} className={input} />
        <input name="slug" placeholder={t('slug3')} className={`${input} font-mono`} />
        <SubmitButton error={state.error} pendingLabel={t('adding')} savedLabel={t('added')} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{t('add')}</SubmitButton>
        {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
      </form>
      {delState.error ? <p className="text-sm text-red-600" role="alert">{delState.error}</p> : null}
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">{c.name} <span className="font-mono text-xs text-zinc-400">/{c.slug}</span> <span className="text-xs text-zinc-400">· {c._count.servers + c._count.skills + c._count.clients} {t('items')}</span></span>
            <form action={delAction}>
              <input type="hidden" name="categoryId" value={c.id} />
              <button className="text-xs text-red-600 hover:underline">{t('delete')}</button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
