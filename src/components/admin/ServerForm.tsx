'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Download, Plus, Save } from 'lucide-react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge } from '@/components/admin/AdminUI';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  fetchServerSourceMetadataAction,
  type ServerSourceMetadataActionState,
} from '@/lib/admin/market-actions';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; stars?: number; isOfficial?: boolean; isFeatured?: boolean; categoryIds?: string[];
  readme?: string | null; source?: 'github' | 'npm' | 'pypi'; sourceRef?: string; sourceUrl?: string | null;
};

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';
const TEXTAREA_CLASS = 'ui-input h-auto min-h-28 resize-y py-2.5';
const CHECKBOX_CLASS = 'size-4 shrink-0 accent-brand';

export function ServerForm({
  action, initial, categories, submitLabel, showSourceMetadata = true,
}: {
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  initial: Initial;
  categories: Category[];
  submitLabel: string;
  showSourceMetadata?: boolean;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const [sourceState, sourceAction, sourcePending] = useActionState<ServerSourceMetadataActionState, FormData>(
    fetchServerSourceMetadataAction,
    {},
  );
  const t = useTranslations('admin');
  const sel = new Set(initial.categoryIds ?? []);
  const SubmitIcon = initial.id ? Save : Plus;
  const metadata = sourceState.metadata;
  const source = metadata?.source ?? initial.source ?? 'npm';
  const sourceRef = metadata?.ref ?? initial.sourceRef ?? '';
  const sourceUrl = metadata?.canonicalSourceUrl ?? initial.sourceUrl ?? '';
  const metadataKey = metadata
    ? `${metadata.canonicalSourceUrl}:${metadata.name}:${metadata.readme?.length ?? 0}`
    : 'initial';
  const suggestedSlug = metadata?.name
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ?? '';

  return (
    <form action={formAction} className="max-w-3xl space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      {showSourceMetadata ? <fieldset className="rounded-md bg-muted/35 p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">{t('fetchSourceMetadata')}</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <label className={LABEL_CLASS}>
            <span>{t('metadataSource')}</span>
            <NativeSelect name="sourceMetadataSource" defaultValue={source} className="ui-input h-11">
              <option value="npm">{t('npm')}</option>
              <option value="pypi">{t('pypi')}</option>
              <option value="github">{t('github')}</option>
            </NativeSelect>
          </label>
          <label className={LABEL_CLASS}>
            <span>{t('packageOrGithubRepository')}</span>
            <input
              name="sourceMetadataRef"
              defaultValue={sourceRef}
              placeholder="@modelcontextprotocol/server-memory"
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
          <label className={`${LABEL_CLASS} min-w-0 flex-1`}>
            <span>{t('sourceUrl')}</span>
            <input value={sourceUrl} readOnly className="ui-input h-11 truncate font-mono text-xs" />
          </label>
          <input type="hidden" name="sourceMetadataCanonicalUrl" value={sourceUrl} />
          <button
            type="submit"
            formAction={sourceAction}
            formNoValidate
            disabled={sourcePending}
            className="ui-button-secondary h-11 shrink-0 disabled:cursor-wait disabled:opacity-70"
          >
            <Download className="size-4" />
            {sourcePending ? t('fetchingMetadata') : t('fetchMetadata')}
          </button>
        </div>
        {sourceState.error ? <p className="mt-3 text-sm text-destructive-text" role="alert">{sourceState.error}</p> : null}
        {metadata ? <p className="mt-3 text-sm text-muted-foreground" role="status">{t('metadataFetched')}</p> : null}
      </fieldset> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={LABEL_CLASS}>
          <span>{t('name')}</span>
          <input key={`name-${metadataKey}`} name="name" defaultValue={metadata?.name ?? initial.name ?? ''} required className="ui-input h-11" />
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
              key={`slug-${metadataKey}`}
              defaultValue={initial.slug ?? suggestedSlug}
              placeholder="my-server"
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        )}
        <label className={LABEL_CLASS}>
          <span>{t('author')}</span>
          <input key={`author-${metadataKey}`} name="author" defaultValue={metadata?.author ?? initial.author ?? ''} className="ui-input h-11" />
        </label>
        <label className={LABEL_CLASS}>
          <span>{t('stars')}</span>
          <input key={`stars-${metadataKey}`} name="stars" type="number" defaultValue={metadata?.stars ?? initial.stars ?? 0} className="ui-input h-11" />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('description')}</span>
          <textarea
            name="description"
            key={`description-${metadataKey}`}
            defaultValue={metadata?.description ?? initial.description ?? ''}
            rows={4}
            className={TEXTAREA_CLASS}
          />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t('readme')}</span>
          <textarea
            name="readme"
            key={`readme-${metadataKey}`}
            defaultValue={metadata?.readme ?? initial.readme ?? ''}
            rows={12}
            className={`${TEXTAREA_CLASS} min-h-64 font-mono text-xs leading-5`}
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
