'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

// A two-step destructive button. Reveals a form on click; the form posts to a
// useActionState action. When `confirmWord` is set, the user must type it.
export function ConfirmDialog({
  label,
  prompt,
  action,
  hidden,
  confirmWord,
  pendingLabel,
}: {
  label: string;
  prompt: string;
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  hidden: Record<string, string>;
  confirmWord?: string;
  pendingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const t = useTranslations('admin');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30"
      >
        {label}
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <span className="text-xs text-zinc-600 dark:text-zinc-300">{prompt}</span>
      {confirmWord ? (
        <input
          name="confirm"
          placeholder={confirmWord}
          className="h-8 rounded-md border border-zinc-200 px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
      ) : null}
      <SubmitButton
        error={state.error}
        flash={false}
        pendingLabel={pendingLabel ?? 'Working…'}
        className="inline-flex h-8 items-center rounded-md bg-red-600 px-2.5 text-xs font-medium text-white hover:bg-red-700"
      >
        {t('confirm')}
      </SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        {t('cancel')}
      </button>
      {state.error ? <span className="text-xs text-red-600" role="alert">{state.error}</span> : null}
    </form>
  );
}
