'use client';

import { useState } from 'react';
import Link from 'next/link';
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
        {isOwner ? <Link href={`/app/${slug}/providers`} className="ui-button-secondary ui-button-sm">{t('configureModels')}</Link> : null}
        <Link href={`/app/${slug}/chat`} className="ui-button-secondary ui-button-sm">{t('startChat')}</Link>
        <Link href={`/app/${slug}/market/agents`} className="ui-button-secondary ui-button-sm">{t('findAgent')}</Link>
        <Link href={`/app/${slug}/market/mcp`} className="ui-button-ghost ui-button-sm">{t('connectTools')}</Link>
      </div>
      <button type="button" onClick={() => setDismissed(true)} aria-label={t('dismiss')} className="ui-button-ghost ui-icon-button absolute right-2 top-2"><X className="size-4" /></button>
    </section>
  );
}
