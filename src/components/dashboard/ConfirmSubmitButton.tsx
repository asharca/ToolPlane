'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

type ConfirmSubmitButtonProps = {
  triggerLabel: ReactNode;
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
    <span className={`inline-flex flex-wrap gap-2 ${className}`}>
      {confirming ? (
        <>
          <span className={promptClassName}>{prompt}</span>
          <button
            ref={confirmRef}
            type="submit"
            disabled={disabled || pending}
            aria-busy={pending}
            className={`${confirmClassName} disabled:cursor-wait disabled:opacity-70`}
          >
            {pending ? pendingLabel ?? confirmLabel : confirmLabel}
          </button>
          <button
            type="button"
            disabled={disabled || pending}
            onClick={cancelConfirmation}
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
          className={`${triggerClassName} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {triggerLabel}
        </button>
      )}
    </span>
  );
}
