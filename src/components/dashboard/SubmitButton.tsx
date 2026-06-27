'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2, Check } from 'lucide-react';

// Drop-in submit button for any `<form action={…}>`. While the action runs it
// disables and shows a spinner + pending label; on a successful completion it
// briefly flashes "Saved" so a click that just revalidates server data still
// gives visible feedback. Pass `error` (e.g. from useActionState) to suppress
// the success flash when the action failed. Caller keeps full control of styling
// via `className`.
export function SubmitButton({
  children = 'Save',
  className,
  pendingLabel = 'Saving…',
  savedLabel = 'Saved',
  flash = true,
  error,
}: {
  children?: ReactNode;
  className?: string;
  pendingLabel?: string;
  savedLabel?: string;
  // Briefly show savedLabel on success. Off for action buttons (start/stop/…)
  // where the page's own state already reflects the result.
  flash?: boolean;
  error?: string | boolean | null;
}) {
  const { pending } = useFormStatus();
  const [justSaved, setJustSaved] = useState(false);
  const wasPending = useRef(pending);

  useEffect(() => {
    // Pending just went true → false. Flash success unless the action errored.
    if (flash && wasPending.current && !pending && !error) {
      setJustSaved(true);
      const t = setTimeout(() => setJustSaved(false), 1600);
      wasPending.current = pending;
      return () => clearTimeout(t);
    }
    wasPending.current = pending;
  }, [pending, error, flash]);

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${className ?? ''} disabled:cursor-wait disabled:opacity-70`}
    >
      <span className="inline-flex items-center gap-1.5">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : justSaved ? (
          <Check className="size-3.5" />
        ) : null}
        {pending ? pendingLabel : justSaved ? savedLabel : children}
      </span>
    </button>
  );
}
