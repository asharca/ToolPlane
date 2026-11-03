"use client";

import { useId, useState } from "react";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "./dialog";

type SidebarGroupDialogProps = {
  initialName: string;
  open: boolean;
  title: string;
  nameLabel: string;
  placeholder: string;
  cancelLabel: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
};

export function SidebarGroupDialog(props: SidebarGroupDialogProps) {
  return (
    <CenterMorphModal
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={props.title}
        closeButtonLabel={props.cancelLabel}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-xl flex-col"
      >
        <SidebarGroupForm
          key={`${props.open}:${props.initialName}`}
          {...props}
        />
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

function SidebarGroupForm({
  initialName,
  title,
  nameLabel,
  placeholder,
  cancelLabel,
  submitLabel,
  onSubmit,
}: SidebarGroupDialogProps) {
  const [name, setName] = useState(initialName);
  const nameId = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
      className="flex min-h-0 flex-col"
    >
      <DialogHeader title={title} />
      <DialogBody>
        <DialogField
          label={nameLabel}
          htmlFor={nameId}
          dirty={name !== initialName}
        >
          <Input
            id={nameId}
            autoFocus
            aria-label={nameLabel}
            value={name}
            onChange={setName}
            maxLength={80}
            name="name"
            placeholder={placeholder}
            required
            className="w-full"
          />
        </DialogField>
      </DialogBody>
      <DialogFooter cancel={<DialogCancel>{cancelLabel}</DialogCancel>}>
        <Button type="submit" variant="primary" size="md">
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
