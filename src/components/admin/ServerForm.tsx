'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Plus, Save } from 'lucide-react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge } from '@/components/admin/AdminUI';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; stars?: number; isOfficial?: boolean; isFeatured?: boolean; categoryIds?: string[];
};

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';
const TEXTAREA_CLASS = 'ui-input h-auto min-h-28 resize-y py-2.5';
const CHECKBOX_CLASS = 'size-4 shrink-0 accent-brand';

export function ServerForm({
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
          <input name="name" defaultValue={initial.name ?? ''} required className="ui-input h-11" />
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
            <span>{t('slug1')}</span>
            <input
              name="slug"
              required
              placeholder="my-server"
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        )}
        <label className={LABEL_CLASS}>
          <span>{t('author')}</span>
          <input name="author" defaultValue={initial.author ?? ''} className="ui-input h-11" />
        </label>
        <label className={LABEL_CLASS}>
          <span>{t('stars')}</span>
          <input name="stars" type="number" defaultValue={initial.stars ?? 0} className="ui-input h-11" />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('description')}</span>
          <textarea
            name="description"
            defaultValue={initial.description ?? ''}
            rows={4}
            className={TEXTAREA_CLASS}
          />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('iconUrl')}</span>
          <input
            name="iconUrl"
            defaultValue={initial.iconUrl ?? ''}
            className="ui-input h-11"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:gap-5">
        <label className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
          <input
            type="checkbox"
            name="isOfficial"
            defaultChecked={initial.isOfficial}
            className={CHECKBOX_CLASS}
          />
          {t('official')}
        </label>
        <label className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
          <input
            type="checkbox"
            name="isFeatured"
            defaultChecked={initial.isFeatured}
            className={CHECKBOX_CLASS}
          />
          {t('featured')}
        </label>
      </div>

      <fieldset className="border-t border-border pt-5">
        <legend className="pr-3 text-sm font-semibold text-foreground">{t('categories')}</legend>
        {categories.length > 0 ? (
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {categories.map((c) => (
              <label
                key={c.id}
                className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  name="categoryIds"
                  value={c.id}
                  defaultChecked={sel.has(c.id)}
                  className={CHECKBOX_CLASS}
                />
                {c.name}
              </label>
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
          className="ui-button-primary h-11 w-full sm:w-auto"
        >
          <SubmitIcon className="size-4" />
          {submitLabel}
        </SubmitButton>
        {state.error ? (
          <p className="text-sm text-destructive-text" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
