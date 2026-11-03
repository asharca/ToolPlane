"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
  DialogField,
} from "@/components/dashboard/dialog";
import type { AdminActionState } from "@/lib/admin/user-actions";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
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
  const [confirmation, setConfirmation] = useState("");
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
            className="flex min-h-0 flex-col"
            aria-labelledby={promptId}
            aria-busy={isPending}
          >
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <DialogHeader
              title={label}
              description={<span id={promptId}>{prompt}</span>}
            />
            <DialogBody>
              {confirmWord ? (
                <DialogField label={confirmWord} dirty={confirmation !== ""}>
                  <Input
                    name="confirm"
                    placeholder={confirmWord}
                    value={confirmation}
                    onChange={setConfirmation}
                    aria-label={`${prompt} ${confirmWord}`}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                  />
                </DialogField>
              ) : null}
              {state.error ? (
                <p className="text-sm text-destructive" role="alert">
                  {state.error}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter cancel={<DialogCancel disabled={isPending} />}>
              <SubmitButton
                error={state.error}
                flash={false}
                pendingLabel={pendingLabel ?? t("saving")}
                variant="primary"
                className={
                  danger
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : undefined
                }
                size="md"
              >
                <Check className="size-4" aria-hidden="true" />
                {t("confirm")}
              </SubmitButton>
            </DialogFooter>
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
