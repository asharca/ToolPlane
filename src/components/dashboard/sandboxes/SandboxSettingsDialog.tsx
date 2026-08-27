'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Settings, X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';

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
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="ui-button-secondary h-9 text-sm">
          <Settings className="size-4" />
          {triggerLabel}
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay className="!bg-background/70 backdrop-blur-sm" />
        <DialogContent className="ui-panel !inset-0 !flex !h-full !w-full !max-h-none !translate-y-0 !flex-col !gap-0 !overflow-hidden !rounded-none !p-0 !shadow-[0_1px_2px_hsl(var(--foreground)_/_0.04)] sm:!inset-auto sm:!left-1/2 sm:!top-1/2 sm:!h-[calc(100dvh-2rem)] sm:!w-[calc(100%_-_2rem)] sm:!max-w-3xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!rounded-md">
          <header className="flex shrink-0 items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <DialogTitle className="truncate !text-base !leading-normal !tracking-normal text-foreground">{title}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate !text-xs">{subtitle}</DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label={closeLabel}
                title={closeLabel}
                className="ui-button-ghost ui-icon-button shrink-0"
              >
                <X className="size-4" />
              </button>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
