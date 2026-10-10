"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import type { AdminActionState } from "@/lib/admin/user-actions";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
  CenterMorphModalClose,
} from "@/components/motion/center-morph-modal";

// Destructive submissions retain their typed confirmation and server validation.
export function ConfirmDialog({
  label,
  ariaLabel,
  prompt,
  action,
  hidden,
  confirmWord,
  pendingLabel,
  tone = "default",
}: {
  label: string;
  ariaLabel?: string;
  prompt: string;
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  hidden: Record<string, string>;
  confirmWord?: string;
  pendingLabel?: string;
  tone?: "default" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<
    AdminActionState,
    FormData
  >(action, {});
  const t = useTranslations("admin");
  const confirmationId = useId();
  const promptId = `${confirmationId}-prompt`;
  const danger = tone === "danger";
  const TriggerIcon = danger ? AlertTriangle : ShieldCheck;

  useEffect(() => {
    if (!state.ok) return;
    const frame = requestAnimationFrame(() => {
      setOpen(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [state]);

  return (
    <div>
      <CenterMorphModal
        open={open}
        onOpenChange={(next) => {
          if (!isPending) setOpen(next);
        }}
      >
        <CenterMorphModalTrigger>
          <Button
            type="button"
            variant="secondary"
            disabled={isPending}
            aria-label={ariaLabel}
          >
            <TriggerIcon className="size-4" aria-hidden="true" />
            {label}
          </Button>
        </CenterMorphModalTrigger>
        <CenterMorphModalContent
          ariaLabel={label}
          ariaDescribedBy={promptId}
          dismissible={!isPending}
          showCloseButton={!isPending}
          closeButtonLabel={t("cancel")}
        >
          <form
            id={confirmationId}
            action={formAction}
            className="space-y-4 p-6"
            aria-labelledby={promptId}
            aria-busy={isPending}
          >
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <p id={promptId} className="pr-10 text-sm font-medium">
              {prompt}
            </p>
            {confirmWord ? (
              <Input
                name="confirm"
                placeholder={confirmWord}
                aria-label={`${prompt} ${confirmWord}`}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton
                error={state.error}
                flash={false}
                pendingLabel={pendingLabel ?? t("saving")}
              >
                <Check className="size-4" aria-hidden="true" />
                {t("confirm")}
              </SubmitButton>
              <CenterMorphModalClose>
                <Button type="button" variant="ghost" disabled={isPending}>
                  <X className="size-4" aria-hidden="true" />
                  {t("cancel")}
                </Button>
              </CenterMorphModalClose>
            </div>
            {state.error ? (
              <p className="text-sm text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
          </form>
        </CenterMorphModalContent>
      </CenterMorphModal>
      {state.ok && !open ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {t("saved")}
        </p>
      ) : null}
    </div>
  );
}
