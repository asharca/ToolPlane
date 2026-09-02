'use client';

import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      {...props}
      ref={ref}
      data-toolplane-ui="dialog-overlay"
      className={`fixed inset-0 z-50 bg-black/50 ${className ?? ''}`.trim()}
    />
  );
});

export const DialogContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Content
      {...props}
      ref={ref}
      data-toolplane-ui="dialog-content"
      className={`fixed inset-x-4 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-card p-5 text-card-foreground shadow-xl sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:p-6 ${className ?? ''}`.trim()}
    />
  );
});

export const DialogTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      {...props}
      ref={ref}
      data-toolplane-ui="dialog-title"
      className={`text-lg font-semibold leading-none tracking-tight ${className ?? ''}`.trim()}
    />
  );
});

export const DialogDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      {...props}
      ref={ref}
      data-toolplane-ui="dialog-description"
      className={`text-sm text-muted-foreground ${className ?? ''}`.trim()}
    />
  );
});
