'use client';

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { Dialog as Primitive } from 'radix-ui';
import { cn } from './beui/lib/utils';

// beUI center-morph surface; Radix remains the headless focus/portal layer.
// Preserve nested dialogs and application approval/dismissal decisions.
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogPortal = Primitive.Portal;
export const DialogClose = Primitive.Close;
export const DialogOverlay = forwardRef<ElementRef<typeof Primitive.Overlay>, ComponentPropsWithoutRef<typeof Primitive.Overlay>>(function DialogOverlay({ className, ...props }, ref) {
  return <Primitive.Overlay {...props} ref={ref} data-toolplane-ui="dialog-overlay" data-ui-engine="beui" className={cn('beui-dialog-overlay fixed inset-0 z-50 bg-black/25 backdrop-blur-sm', className)} />;
});
export const DialogContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(function DialogContent({ className, ...props }, ref) {
  return <Primitive.Content {...props} ref={ref} data-toolplane-ui="dialog-content" data-ui-engine="beui"
    className={cn('beui-dialog-content fixed inset-x-4 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] -translate-y-1/2 gap-4 overflow-y-auto rounded-3xl border border-border bg-card p-5 text-card-foreground shadow-2xl sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:p-6', className)} />;
});
export const DialogTitle = forwardRef<ElementRef<typeof Primitive.Title>, ComponentPropsWithoutRef<typeof Primitive.Title>>(function DialogTitle({ className, ...props }, ref) {
  return <Primitive.Title {...props} ref={ref} data-toolplane-ui="dialog-title" className={cn('text-lg font-semibold leading-snug tracking-tight', className)} />;
});
export const DialogDescription = forwardRef<ElementRef<typeof Primitive.Description>, ComponentPropsWithoutRef<typeof Primitive.Description>>(function DialogDescription({ className, ...props }, ref) {
  return <Primitive.Description {...props} ref={ref} data-toolplane-ui="dialog-description" className={cn('text-sm leading-relaxed text-muted-foreground', className)} />;
});
