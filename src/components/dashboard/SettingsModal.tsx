'use client';
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal';


import { useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { hasUnsavedWorkspaceChanges } from '@/lib/workspace/navigation';

export function SettingsModal({
  title,
  fallbackHref,
  compact = false,
  children,
}: {
  title: string;
  fallbackHref: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const t = useTranslations('console.common');
  const workspaceT = useTranslations('console.workspaces');
  const returnTo = useSearchParams().get('returnTo');
  const closeHref = (returnTo === '/app?view=workspaces' || returnTo?.startsWith('/app/')) && !returnTo.includes('/settings')
    ? returnTo
    : fallbackHref;
  const close = () => {
    if (hasUnsavedWorkspaceChanges() && !window.confirm(workspaceT('unsavedChanges'))) return;
    setOpen(false);
  };

  return (
    <CenterMorphModal open={open} onOpenChange={(next) => { if (!next) close(); }}>
      
        
        <CenterMorphModalContent ariaLabel={title} closeButtonLabel={t('close')} onExitComplete={() => router.replace(closeHref)} className={`flex flex-col overflow-hidden w-full ${compact ? 'max-w-3xl h-[min(600px,76vh)]' : 'max-w-6xl h-[calc(100dvh-4rem)]'}`}>
          <header className="flex h-14 shrink-0 items-center pl-4 pr-16 sm:pl-6">
            <h2 className="text-sm">{title}</h2>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </CenterMorphModalContent>
      
    </CenterMorphModal>
  );
}
