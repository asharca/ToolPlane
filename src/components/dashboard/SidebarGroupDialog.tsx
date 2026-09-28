'use client';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalClose } from '@/components/motion/center-morph-modal';
import { Input } from '@/components/motion/input';
import { Button } from '@/components/motion/button';

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
    <CenterMorphModal open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      
        
        <CenterMorphModalContent ariaLabel={title} closeButtonLabel={cancelLabel} className="w-full max-w-xl p-6">
          <form
            key={`${open}:${initialName}`}
            onSubmit={(event) => {
              event.preventDefault();
              const name = new FormData(event.currentTarget).get('name');
              if (typeof name === 'string' && name.trim()) onSubmit(name.trim());
            }}
            className="space-y-4"
          >
            <h2 className="pr-10">{title}</h2>
            <label className="block text-sm font-medium">
              {nameLabel}
              <Input autoFocus aria-label={nameLabel} defaultValue={initialName} maxLength={80} name="name" placeholder={placeholder} required className="mt-1 w-full" />
            </label>
            <div className="flex justify-end gap-2">
              <CenterMorphModalClose><Button type="button" variant="secondary" size="sm">{cancelLabel}</Button></CenterMorphModalClose>
              <Button type="submit" variant="primary" size="sm">{submitLabel}</Button>
            </div>
          </form>
        </CenterMorphModalContent>
      
    </CenterMorphModal>
  );
}
