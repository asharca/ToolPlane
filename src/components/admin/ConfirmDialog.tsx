'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

// A two-step destructive button. Reveals a form on click; the form posts to a
// useActionState action. When `confirmWord` is set, the user must type it.
export function ConfirmDialog({
  label,
  ariaLabel,
  prompt,
  action,
  hidden,
  confirmWord,
  pendingLabel,
  tone = 'default',
}: {
  label: string;
  ariaLabel?: string;
  prompt: string;
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  hidden: Record<string, string>;
  confirmWord?: string;
  pendingLabel?: string;
  tone?: 'default' | 'danger';
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<AdminActionState, FormData>(action, {});
  const t = useTranslations('admin');
  const confirmationId = useId();
  const promptId = `${confirmationId}-prompt`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const danger = tone === 'danger';
  const TriggerIcon = danger ? AlertTriangle : ShieldCheck;

  function closeConfirmation() {
    if (isPending) return;
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!state.ok) return;
    const frame = requestAnimationFrame(() => {
      setOpen(false);
      triggerRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state]);

  return (
    <div className={open ? 'w-full' : undefined}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        disabled={isPending}
        aria-expanded={open}
        aria-controls={confirmationId}
        aria-label={ariaLabel}
        className={`ui-button-secondary h-11 disabled:cursor-wait disabled:opacity-70 ${danger ? 'ui-button-danger-secondary' : ''}`}
      >
        <TriggerIcon className="size-4" />
        {label}
      </button>
      <form
        id={confirmationId}
        action={formAction}
        hidden={!open}
        className={`mt-3 w-full space-y-3 rounded-md p-3 ${danger ? 'bg-destructive/10' : 'bg-muted/55'}`}
        aria-labelledby={promptId}
        aria-busy={isPending}
      >
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <p id={promptId} className="text-sm font-medium text-foreground">{prompt}</p>
        {confirmWord ? (
          <input
            name="confirm"
            placeholder={confirmWord}
            className="ui-input h-11 font-mono"
            aria-label={`${prompt} ${confirmWord}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SubmitButton
            error={state.error}
            flash={false}
            pendingLabel={pendingLabel ?? t('saving')}
            className={`ui-button-primary h-11 ${danger ? 'ui-button-danger' : ''}`}
          >
            <Check className="size-4" />
            {t('confirm')}
          </SubmitButton>
          <button
            type="button"
            onClick={closeConfirmation}
            disabled={isPending}
            className="ui-button-ghost h-11 disabled:cursor-wait disabled:opacity-50"
          >
            <X className="size-4" />
            {t('cancel')}
          </button>
        </div>
        {state.error ? (
          <p className="text-sm text-destructive-text" role="alert">
            {state.error}
          </p>
        ) : null}
      </form>
      {state.ok && !open ? (
        <p className="mt-2 text-xs font-medium text-accent-foreground" role="status">
          {t('saved')}
        </p>
      ) : null}
    </div>
  );
}
