'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; githubSource?: string | null; score?: number; categoryIds?: string[];
};

export function SkillForm({
  action, initial, categories, submitLabel,
}: {
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  initial: Initial;
  categories: Category[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const t = useTranslations('admin');
  const input = 'h-9 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const lbl = 'block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300';
  const sel = new Set(initial.categoryIds ?? []);

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <label className={lbl}>{t('name')}<input name="name" defaultValue={initial.name ?? ''} required className={input} /></label>
      {initial.id ? (
        <p className="text-xs text-zinc-500">{t('slug')} <span className="font-mono">{initial.slug}</span> {t('immutable')}</p>
      ) : (
        <label className={lbl}>{t('slug2')}<input name="slug" required placeholder="my-skill" className={`${input} font-mono`} /></label>
      )}
      <label className={lbl}>{t('author')}<input name="author" defaultValue={initial.author ?? ''} className={input} /></label>
      <label className={lbl}>{t('description')}<textarea name="description" defaultValue={initial.description ?? ''} rows={3} className="w-full rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
      <label className={lbl}>{t('iconUrl')}<input name="iconUrl" defaultValue={initial.iconUrl ?? ''} className={input} /></label>
      <label className={lbl}>
        {t('githubSource')}
        <input name="githubSource" defaultValue={initial.githubSource ?? ''} placeholder="owner/repo or owner/repo/path/to/skill" className={`${input} font-mono`} />
        <span className="text-xs font-normal text-zinc-400">{t('usedToGenerate')} <code className="font-mono">npx skillfish add</code> {t('installCommand')}</span>
      </label>
      <label className={lbl}>{t('score')}<input name="score" type="number" defaultValue={initial.score ?? 0} className={input} /></label>
      <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-semibold uppercase text-zinc-500">{t('categories')}</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={sel.has(c.id)} className="size-4" /> {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <SubmitButton error={state.error} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{submitLabel}</SubmitButton>
        {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
      </div>
    </form>
  );
}
