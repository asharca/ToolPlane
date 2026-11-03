"use client";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";

import { useId, useRef, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
  useDirtyFields,
} from "@/components/dashboard/dialog";

export function SandboxSettingsDialog({
  title,
  subtitle,
  triggerLabel,
  closeLabel,
  children,
}: {
  title: string;
  subtitle: string;
  triggerLabel: string;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <CenterMorphModal>
      <CenterMorphModalTrigger>
        <Button type="button" variant="secondary" size="sm">
          <Settings className="size-4" />
          {triggerLabel}
        </Button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={title}
        closeButtonLabel={closeLabel}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col"
      >
        <DialogHeader title={title} description={subtitle} />
        <DialogBody className="border-t border-border">{children}</DialogBody>
        <DialogFooter cancel={<DialogCancel>{closeLabel}</DialogCancel>} />
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

/** Section form that highlights edited native fields until the saved values return. */
export function SandboxSettingsForm({
  action,
  className,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  className?: string;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useDirtyFields(formRef);
  return (
    <form ref={formRef} action={action} className={className}>
      {children}
    </form>
  );
}

export function SandboxNameField({
  label,
  defaultValue,
}: {
  label: string;
  defaultValue: string;
}) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const [savedValue, setSavedValue] = useState(defaultValue);
  if (savedValue !== defaultValue) {
    setSavedValue(defaultValue);
    setValue(defaultValue);
  }
  return (
    <DialogField
      label={label}
      htmlFor={id}
      dirty={value !== defaultValue}
      className="min-w-0 flex-1"
    >
      <Input
        id={id}
        name="name"
        value={value}
        onChange={setValue}
        maxLength={80}
        className="min-w-0"
      />
    </DialogField>
  );
}
