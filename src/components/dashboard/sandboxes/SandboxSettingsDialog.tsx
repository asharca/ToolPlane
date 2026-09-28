'use client';

import { Button } from '@/components/motion/button';

import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from '@/components/motion/center-morph-modal';

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
      <CenterMorphModalContent ariaLabel={title} closeButtonLabel={closeLabel} className="max-w-3xl">
        <header className="mb-5">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </header>
        {children}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
