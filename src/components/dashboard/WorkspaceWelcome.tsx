'use client';
import { ButtonLink, Button } from '@/components/motion/button';


import { useState } from 'react';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function WorkspaceWelcome({ slug, name, isOwner }: { slug: string; name: string; isOwner: boolean }) {
  const t = useTranslations('console.workspaces');
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <section aria-label={t('welcome', { name })} className="relative mx-4 my-3 shrink-0 rounded-xl border border-border bg-background p-4 pr-10">
      <h2 className="break-words text-sm font-semibold">{t('welcome', { name })}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(isOwner ? 'welcomeHint' : 'sharedHint')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {isOwner ? <ButtonLink href={`/app/${slug}/providers`} variant="secondary" size="sm">{t('configureModels')}</ButtonLink> : null}
        <ButtonLink href={`/app/${slug}/chat`} variant="secondary" size="sm">{t('startChat')}</ButtonLink>
        <ButtonLink href={`/app/${slug}/market/agents`} variant="secondary" size="sm">{t('findAgent')}</ButtonLink>
        <ButtonLink href={`/app/${slug}/market/mcp`} variant="ghost" size="sm">{t('connectTools')}</ButtonLink>
      </div>
      <Button type="button" onClick={() => setDismissed(true)} aria-label={t('dismiss')} variant="ghost" size="icon" className="absolute right-2 top-2"><X className="size-4" /></Button>
    </section>
  );
}
