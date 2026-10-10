"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  Button,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/motion/button/base";
import { StatefulButton } from "@/components/motion/button/stateful";
import { Tooltip } from "@/components/motion/tooltip";

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
  triggerVariant?: ButtonVariant;
  confirmVariant?: ButtonVariant;
  cancelVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  confirmSize?: ButtonSize;
  cancelSize?: ButtonSize;
};

export function ConfirmSubmitButton({
  triggerLabel,
  triggerAriaLabel,
  triggerTitle,
  confirmLabel,
  cancelLabel,
  prompt,
  pendingLabel,
  disabled,
  className,
  triggerClassName,
  confirmClassName,
  cancelClassName,
  promptClassName = "text-sm text-muted-foreground",
  triggerVariant = "secondary",
  confirmVariant = "primary",
  cancelVariant = "ghost",
  triggerSize = "md",
  confirmSize = "md",
  cancelSize = "md",
}: ConfirmSubmitButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const { pending } = useFormStatus();
  const promptId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  const wasPending = useRef(false);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
    else if (restore.current) {
      restore.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (wasPending.current) {
      wasPending.current = false;
      restore.current = true;
      setConfirming(false);
    }
  }, [pending]);
  const cancel = () => {
    if (!pending) {
      restore.current = true;
      setConfirming(false);
    }
  };
  const triggerButton = (
    <Button
      ref={trigger}
      type="button"
      disabled={disabled || pending}
      onClick={() => setConfirming(true)}
      aria-label={triggerAriaLabel}
      variant={triggerVariant}
      size={triggerSize}
      className={triggerClassName}
    >
      {triggerLabel}
    </Button>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: Inline confirmation groups must remain valid inside phrasing-content parents.
    <span
      role="group"
      className={`inline-flex flex-wrap items-center gap-2 ${className ?? ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && confirming && !pending) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {confirming ? (
        <>
          <span id={promptId} className={promptClassName}>
            {prompt}
          </span>
          <StatefulButton
            ref={confirm}
            type="submit"
            disabled={disabled || pending}
            aria-busy={pending || undefined}
            aria-describedby={promptId}
            variant={confirmVariant}
            size={confirmSize}
            className={confirmClassName}
            state={pending ? "loading" : "idle"}
            loadingText={pendingLabel ?? confirmLabel}
          >
            {confirmLabel}
          </StatefulButton>
          <Button
            type="button"
            disabled={disabled || pending}
            onClick={cancel}
            variant={cancelVariant}
            size={cancelSize}
            className={cancelClassName}
          >
            {cancelLabel}
          </Button>
        </>
      ) : triggerSize === "icon" ? (
        <Tooltip content={triggerTitle ?? triggerAriaLabel ?? triggerLabel}>
          {triggerButton}
        </Tooltip>
      ) : (
        triggerButton
      )}
    </span>
  );
}
