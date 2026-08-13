'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      {...props}
      className={`fixed inset-0 z-50 bg-black/50 ${className ?? ''}`.trim()}
    />
  );
}

export function DialogContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Content
      {...props}
      className={`fixed inset-x-4 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-card p-5 text-card-foreground shadow-xl sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:p-6 ${className ?? ''}`.trim()}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      {...props}
      className={`text-lg font-semibold leading-none tracking-tight ${className ?? ''}`.trim()}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      {...props}
      className={`text-sm text-muted-foreground ${className ?? ''}`.trim()}
    />
  );
}
