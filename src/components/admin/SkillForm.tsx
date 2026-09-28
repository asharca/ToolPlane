'use client';
import { Input } from '@/components/motion/input';
import { FormCheckbox } from '@/components/ui/FormCheckbox';


import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Plus, Save } from 'lucide-react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge } from '@/components/admin/AdminUI';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; githubSource?: string | null; score?: number; categoryIds?: string[];
};

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';

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
  const sel = new Set(initial.categoryIds ?? []);
  const SubmitIcon = initial.id ? Save : Plus;

  return (
    <form action={formAction} className="max-w-3xl space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={LABEL_CLASS}>
          <span>{t('name')}</span>
          <Input name="name" defaultValue={initial.name ?? ''} required />
        </label>
        {initial.id ? (
          <div className={LABEL_CLASS}>
            <span>{t('slug')}</span>
            <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/45 px-3">
              <code className="truncate font-mono text-sm text-foreground">{initial.slug}</code>
              <AdminBadge tone="neutral">{t('immutable')}</AdminBadge>
            </div>
          </div>
        ) : (
          <label className={LABEL_CLASS}>
            <span>{t('slug2')}</span>
            <Input name="slug" required placeholder="my-skill" autoCapitalize="none" spellCheck={false} />
          </label>
        )}
        <label className={LABEL_CLASS}>
          <span>{t('author')}</span>
          <Input name="author" defaultValue={initial.author ?? ''} />
        </label>
        <label className={LABEL_CLASS}>
          <span>{t('score')}</span>
          <Input name="score" type="number" defaultValue={String(initial.score ?? 0)} />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('description')}</span>
          <textarea name="description" defaultValue={initial.description ?? ''} rows={4} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('iconUrl')}</span>
          <Input name="iconUrl" defaultValue={initial.iconUrl ?? ''} inputMode="url" autoCapitalize="none" spellCheck={false} />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('githubSource')}</span>
          <Input name="githubSource" defaultValue={initial.githubSource ?? ''} placeholder="owner/repo or owner/repo/path/to/skill" autoCapitalize="none" spellCheck={false} />
          <span className="block text-xs font-normal leading-5 text-muted-foreground">
            {t('usedToGenerate')} <code className="font-mono text-foreground">npx skillfish add</code> {t('installCommand')}
          </span>
        </label>
      </div>

      <fieldset className="border-t border-border pt-5">
        <legend className="pr-3 text-sm font-semibold text-foreground">{t('categories')}</legend>
        {categories.length > 0 ? (
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {categories.map((c) => (
              <div
                key={c.id}
                className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
              >
                <FormCheckbox name="categoryIds" value={c.id} defaultChecked={sel.has(c.id)} label={c.name} />
                
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{t('none')}</p>
        )}
      </fieldset>

      <div className="flex flex-col items-start gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <SubmitButton
          error={state.error}
          pendingLabel={t('saving')}
          savedLabel={t('saved')}
          variant="primary" size="md" className="w-full sm:w-auto"
        >
          <SubmitIcon className="size-4" />
          {submitLabel}
        </SubmitButton>
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
