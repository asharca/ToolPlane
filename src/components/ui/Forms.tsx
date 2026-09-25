'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Check, Copy } from 'lucide-react';
import { Button } from './Controls';

export type SubmitButtonProps = {
  children?: ReactNode; className?: string; pendingLabel?: string; savedLabel?: string;
  flash?: boolean; error?: string | boolean | null; disabled?: boolean; ariaLabel?: string; title?: string;
};
export function SubmitButton({ children = 'Save', className, pendingLabel = 'Saving…', savedLabel = 'Saved', flash = true, error, disabled = false, ariaLabel, title }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const previous = useRef(pending);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const completed = previous.current && !pending;
    previous.current = pending;
    if (!completed || !flash || error) return;
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [pending, flash, error]);
  return <Button type="submit" variant="primary" className={className} disabled={disabled} loading={pending}
    loadingLabel={pendingLabel} aria-label={ariaLabel} title={title} data-toolplane-ui="submit-button">
    {saved && !error ? <><Check aria-hidden="true" className="size-3.5" />{savedLabel}</> : children}
  </Button>;
}
export type ConfirmSubmitButtonProps = {
  triggerLabel: ReactNode; triggerAriaLabel?: string; triggerTitle?: string;
  confirmLabel: ReactNode; cancelLabel: ReactNode; prompt: ReactNode; pendingLabel?: ReactNode;
  disabled?: boolean; className?: string; triggerClassName?: string; confirmClassName?: string;
  cancelClassName?: string; promptClassName?: string;
};
export function ConfirmSubmitButton({ triggerLabel, triggerAriaLabel, triggerTitle, confirmLabel, cancelLabel, prompt, pendingLabel, disabled = false,
  className = 'items-center', triggerClassName = 'ui-button-secondary', confirmClassName = 'ui-button-primary', cancelClassName = 'ui-button-ghost', promptClassName = 'text-sm text-muted-foreground' }: ConfirmSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  const wasPending = useRef(false);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
    else if (restore.current) { restore.current = false; trigger.current?.focus(); }
  }, [confirming]);
  useEffect(() => {
    if (pending) { wasPending.current = true; return; }
    if (wasPending.current) { wasPending.current = false; restore.current = true; setConfirming(false); }
  }, [pending]);
  return <span data-toolplane-ui="confirm-submit-button" className={`inline-flex flex-wrap gap-2 ${className}`}>
    {confirming ? <>
      <span className={promptClassName}>{prompt}</span>
      <Button ref={confirm} type="submit" disabled={disabled || pending} aria-busy={pending} variant="primary" className={confirmClassName} data-toolplane-ui="confirm-submit-confirm">{pending ? pendingLabel ?? confirmLabel : confirmLabel}</Button>
      <Button type="button" disabled={disabled || pending} variant="ghost" className={cancelClassName} data-toolplane-ui="confirm-submit-cancel" onClick={() => { restore.current = true; setConfirming(false); }}>{cancelLabel}</Button>
    </> : <Button ref={trigger} type="button" disabled={disabled || pending} aria-label={triggerAriaLabel} title={triggerTitle} className={triggerClassName} data-toolplane-ui="confirm-submit-trigger" onClick={() => setConfirming(true)}>{triggerLabel}</Button>}
  </span>;
}
export type CopyButtonProps = { text: string; label?: string; copiedLabel?: string; failedLabel?: string; className?: string; iconOnly?: boolean };
export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', failedLabel = 'Copy failed', className, iconOnly = false }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const statusLabel = status === 'copied' ? copiedLabel : status === 'failed' ? failedLabel : label;
  async function copy() {
    if (pending) return;
    setPending(true);
    let success = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Clipboard timed out')), 500); }),
      ]);
      success = true;
    } catch {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const field = document.createElement('textarea');
      field.value = text; field.readOnly = true;
      Object.assign(field.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
      try {
        document.body.appendChild(field); field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
        success = typeof document.execCommand === 'function' && document.execCommand('copy');
      } catch { success = false; }
      finally { field.remove(); active?.focus(); }
    } finally { if (timeout) clearTimeout(timeout); }
    if (!mounted.current) return;
    setPending(false); setStatus(success ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 1500);
  }
  return <Button type="button" onClick={copy} disabled={pending} aria-label={iconOnly ? statusLabel : undefined} title={iconOnly ? statusLabel : undefined}
    className={className} data-toolplane-ui="copy-button">
    {status === 'copied' ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
    <span className={iconOnly ? 'sr-only' : undefined} aria-live="polite">{statusLabel}</span>
  </Button>;
}
