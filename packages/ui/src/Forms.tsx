'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFormStatus } from 'react-dom';
import { Check, Copy, Loader2 } from 'lucide-react';

export type SubmitButtonProps = {
  children?: ReactNode;
  className?: string;
  pendingLabel?: string;
  savedLabel?: string;
  flash?: boolean;
  error?: string | boolean | null;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
};

export function SubmitButton({
  children = 'Save',
  className,
  pendingLabel = 'Saving…',
  savedLabel = 'Saved',
  flash = true,
  error,
  disabled = false,
  ariaLabel,
  title,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const [justSaved, setJustSaved] = useState(false);
  const wasPending = useRef(pending);

  useEffect(() => {
    if (flash && wasPending.current && !pending && !error) {
      setJustSaved(true);
      const timeout = setTimeout(() => setJustSaved(false), 1600);
      wasPending.current = pending;
      return () => clearTimeout(timeout);
    }
    wasPending.current = pending;
  }, [pending, error, flash]);

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      title={title}
      data-toolplane-ui="submit-button"
      className={`${className ?? ''} disabled:opacity-70 ${pending ? 'cursor-wait' : 'disabled:cursor-not-allowed'}`}
    >
      <span className="inline-flex items-center gap-1.5">
        {pending ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : justSaved ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : null}
        {pending ? pendingLabel : justSaved ? savedLabel : children}
      </span>
    </button>
  );
}

export type ConfirmSubmitButtonProps = {
  triggerLabel: ReactNode;
  triggerAriaLabel?: string;
  triggerTitle?: string;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  prompt: ReactNode;
  pendingLabel?: ReactNode;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  confirmClassName?: string;
  cancelClassName?: string;
  promptClassName?: string;
};

export function ConfirmSubmitButton({
  triggerLabel,
  triggerAriaLabel,
  triggerTitle,
  confirmLabel,
  cancelLabel,
  prompt,
  pendingLabel,
  disabled = false,
  className = 'items-center',
  triggerClassName = 'ui-button-secondary',
  confirmClassName = 'ui-button-primary',
  cancelClassName = 'ui-button-ghost',
  promptClassName = 'text-sm text-muted-foreground',
}: ConfirmSubmitButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const { pending } = useFormStatus();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocus = useRef(false);
  const wasPending = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming]);

  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;

    wasPending.current = false;
    restoreTriggerFocus.current = true;
    setConfirming(false);
  }, [pending]);

  function cancelConfirmation() {
    restoreTriggerFocus.current = true;
    setConfirming(false);
  }

  return (
    <span
      data-toolplane-ui="confirm-submit-button"
      className={`inline-flex flex-wrap gap-2 ${className}`}
    >
      {confirming ? (
        <>
          <span className={promptClassName}>{prompt}</span>
          <button
            ref={confirmRef}
            type="submit"
            disabled={disabled || pending}
            aria-busy={pending}
            data-toolplane-ui="confirm-submit-confirm"
            className={`${confirmClassName} disabled:cursor-wait disabled:opacity-70`}
          >
            {pending ? pendingLabel ?? confirmLabel : confirmLabel}
          </button>
          <button
            type="button"
            disabled={disabled || pending}
            onClick={cancelConfirmation}
            data-toolplane-ui="confirm-submit-cancel"
            className={`${cancelClassName} disabled:cursor-wait disabled:opacity-70`}
          >
            {cancelLabel}
          </button>
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled || pending}
          onClick={() => setConfirming(true)}
          aria-label={triggerAriaLabel}
          title={triggerTitle}
          data-toolplane-ui="confirm-submit-trigger"
          className={`${triggerClassName} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {triggerLabel}
        </button>
      )}
    </span>
  );
}

export type CopyButtonProps = {
  text: string;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  className?: string;
  iconOnly?: boolean;
};

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  failedLabel = 'Copy failed',
  className,
  iconOnly = false,
}: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusLabel = status === 'copied'
    ? copiedLabel
    : status === 'failed'
      ? failedLabel
      : label;

  useEffect(() => () => {
    if (resetTimeout.current) clearTimeout(resetTimeout.current);
  }, []);

  async function copy() {
    let success = false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Clipboard write timed out.')), 500);
        }),
      ]);
      success = true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      success = document.execCommand('copy');
      textarea.remove();
    }

    setStatus(success ? 'copied' : 'failed');
    if (resetTimeout.current) clearTimeout(resetTimeout.current);
    resetTimeout.current = setTimeout(() => setStatus('idle'), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={iconOnly ? statusLabel : undefined}
      title={iconOnly ? statusLabel : undefined}
      data-toolplane-ui="copy-button"
      className={className ?? 'inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800'}
    >
      {status === 'copied' ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
      {iconOnly ? <span className="sr-only" aria-live="polite">{statusLabel}</span> : statusLabel}
    </button>
  );
}
