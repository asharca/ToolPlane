'use client';

import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';

export function SidebarGroupDialog({
  initialName,
  open,
  title,
  nameLabel,
  placeholder,
  cancelLabel,
  submitLabel,
  onClose,
  onSubmit,
}: {
  initialName: string;
  open: boolean;
  title: string;
  nameLabel: string;
  placeholder: string;
  cancelLabel: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent className="!max-w-sm">
          <form
            key={`${open}:${initialName}`}
            onSubmit={(event) => {
              event.preventDefault();
              const name = new FormData(event.currentTarget).get('name');
              if (typeof name === 'string' && name.trim()) onSubmit(name.trim());
            }}
            className="space-y-4"
          >
            <DialogTitle>{title}</DialogTitle>
            <label className="block text-sm font-medium">
              {nameLabel}
              <input
                autoFocus
                aria-label={nameLabel}
                className="ui-input mt-1 w-full"
                defaultValue={initialName}
                maxLength={80}
                name="name"
                placeholder={placeholder}
                required
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="ui-button-secondary h-9 px-3" onClick={onClose}>{cancelLabel}</button>
              <button type="submit" className="ui-button-primary h-9 px-3">{submitLabel}</button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
