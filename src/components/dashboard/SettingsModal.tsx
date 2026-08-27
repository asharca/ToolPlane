'use client';

import type { ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';

export function SettingsModal({ title, fallbackHref, children }: { title: string; fallbackHref: string; children: ReactNode }) {
  const router = useRouter();
  const returnTo = useSearchParams().get('returnTo');
  const closeHref = returnTo?.startsWith('/app/') && !returnTo.includes('/settings')
    ? returnTo
    : fallbackHref;
  const close = () => router.replace(closeHref);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent
          aria-describedby={undefined}
          className="ui-panel !inset-0 !flex !h-full !w-full !max-h-none !max-w-none !translate-y-0 !flex-col !gap-0 !overflow-hidden !rounded-none !p-0 !shadow-2xl sm:!inset-auto sm:!left-1/2 sm:!top-1/2 sm:!h-[calc(100dvh-2rem)] sm:!w-[calc(100vw-2rem)] sm:!max-w-6xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!rounded-2xl sm:!p-0"
        >
          <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogClose asChild>
              <button type="button" aria-label="Close" className="ui-button-ghost ui-icon-button">
                <X className="size-4" />
              </button>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
