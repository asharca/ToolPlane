"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import {
  StatefulButton,
  type StatefulButtonProps,
} from "@/components/motion/button/stateful";

export type SubmitButtonProps = Omit<StatefulButtonProps, "state" | "type"> & {
  pendingLabel?: string;
  savedLabel?: string;
  flash?: boolean;
  error?: string | boolean | null;
  ariaLabel?: string;
};

export function SubmitButton({
  children,
  pendingLabel,
  savedLabel,
  flash = true,
  error,
  disabled,
  ariaLabel,
  ...props
}: SubmitButtonProps) {
  const common = useTranslations("common");
  const { pending } = useFormStatus();
  const [saved, setSaved] = useState(false);
  const wasPending = useRef(false);
  useEffect(() => {
    const completed = wasPending.current && !pending;
    wasPending.current = pending;
    if (pending || error || !flash) {
      // The flash state mirrors the form action lifecycle.
      setSaved(false);
      return;
    }
    if (completed) {
      setSaved(true);
      const timer = setTimeout(() => setSaved(false), 1600);
      return () => clearTimeout(timer);
    }
  }, [pending, error, flash]);

  return (
    <StatefulButton
      {...props}
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      aria-label={ariaLabel ?? props["aria-label"]}
      state={pending ? "loading" : saved ? "success" : "idle"}
      loadingText={pendingLabel ?? common("saving")}
      successText={savedLabel ?? common("saved")}
    >
      {children}
    </StatefulButton>
  );
}
