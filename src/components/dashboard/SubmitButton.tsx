'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { StatefulButton, type StatefulButtonProps } from '@/components/motion/button/stateful';

export type SubmitButtonProps = Omit<StatefulButtonProps, 'state' | 'type'> & {
  pendingLabel?: string;
  savedLabel?: string;
  flash?: boolean;
  error?: string | boolean | null;
  ariaLabel?: string;
};

export function SubmitButton({ children, pendingLabel = 'Saving…', savedLabel = 'Saved', flash = true, error, disabled, ariaLabel, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const [saved, setSaved] = useState(false);
  const wasPending = useRef(false);
  useEffect(() => {
    const completed = wasPending.current && !pending;
    wasPending.current = pending;
    if (pending || error || !flash) {
      // The flash state mirrors the form action lifecycle.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSaved(false);
      return;
    }
    if (completed) {
      setSaved(true);
      const timer = setTimeout(() => setSaved(false), 1600);
      return () => clearTimeout(timer);
    }
  }, [pending, error, flash]);

  return <StatefulButton {...props} type="submit" disabled={pending || disabled} aria-busy={pending || undefined} aria-label={ariaLabel ?? props['aria-label']}
    state={pending ? 'loading' : saved ? 'success' : 'idle'} loadingText={pendingLabel} successText={savedLabel}>{children}</StatefulButton>;
}
