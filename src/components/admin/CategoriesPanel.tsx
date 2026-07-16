'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Plus } from 'lucide-react';
import { createCategoryAction, deleteCategoryAction } from '@/lib/admin/category-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Row = { id: string; slug: string; name: string; _count: { servers: number; skills: number; clients: number } };

export function CategoriesPanel({ categories }: { categories: Row[] }) {
  const t = useTranslations('admin');
  const [state, action] = useActionState<AdminActionState, FormData>(createCategoryAction, {});

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
      <AdminPanel title={t('add')}>
        <form action={action} className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            <span>{t('name')}</span>
            <input name="name" placeholder={t('name')} className="ui-input h-11" required />
          </label>
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            <span>{t('slug3')}</span>
            <input
              name="slug"
              placeholder={t('slug3')}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          <SubmitButton
            error={state.error}
            pendingLabel={t('adding')}
            savedLabel={t('added')}
            className="ui-button-primary h-11 w-full sm:w-auto"
          >
            <Plus className="size-4" />
            {t('add')}
          </SubmitButton>
          {state.error ? (
            <p className="text-sm text-destructive-text" role="alert">
              {state.error}
            </p>
          ) : null}
        </form>
      </AdminPanel>

      <AdminPanel
        title={t('categories')}
        actions={<AdminBadge tone="neutral">{categories.length}</AdminBadge>}
        padded={false}
      >
        {categories.length > 0 ? (
          <ul className="divide-y divide-border">
            {categories.map((category) => {
              const itemCount = category._count.servers + category._count.skills + category._count.clients;

              return (
                <li
                  key={category.id}
                  className="flex min-w-0 flex-col gap-3 px-5 py-3 sm:min-h-16 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{category.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <code className="font-mono">/{category.slug}</code>
                      <span aria-hidden="true">·</span>
                      <span>{itemCount} {t('items')}</span>
                    </p>
                  </div>
                  <div className="shrink-0">
                    <ConfirmDialog
                      label={t('delete')}
                      ariaLabel={t('deleteCategoryLabel', { name: category.name })}
                      prompt={t('deleteCategoryConfirm', { name: category.name })}
                      action={deleteCategoryAction}
                      hidden={{ categoryId: category.id }}
                      pendingLabel={t('deleting')}
                      tone="danger"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t('none')}</p>
        )}
      </AdminPanel>
    </div>
  );
}
