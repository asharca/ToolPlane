'use client';
import { Button as BeuiButton } from '@/components/ui/Controls';


import Link from 'next/link';
import { Popover } from '@/components/ui/primitives';
import { LogOut, Settings, Shield, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { logoutAction } from '@/lib/auth/actions';

export function AccountMenu({ userLabel, workspaceSlug, returnTo, compact = false, isAdmin = false }: { userLabel: string; workspaceSlug?: string; returnTo?: string; compact?: boolean; isAdmin?: boolean }) {
  const t = useTranslations('console.workspaces');
  const sidebar = useTranslations('console.sidebar');
  const switcher = useTranslations('console.workspaceSwitcher');
  return (
    <Popover.Root>
      <Popover.Trigger asChild><BeuiButton nativeButton unstyled type="button" className={`ui-button-ghost w-full min-w-0 ${compact ? 'lg:justify-center lg:px-0' : 'justify-start'}`} aria-label={`${t('account')}: ${userLabel}`} title={compact ? userLabel : undefined}><UserRound className="size-[18px] shrink-0" /><span className={`truncate ${compact ? 'lg:hidden' : ''}`}>{userLabel}</span></BeuiButton></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={8} className="z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
          <p className="truncate px-3 py-2 text-xs text-muted-foreground">{userLabel}</p>
          <Popover.Close asChild><Link href={workspaceSlug ? `/app/${encodeURIComponent(workspaceSlug)}/settings/account?returnTo=${encodeURIComponent(returnTo ?? `/app/${encodeURIComponent(workspaceSlug)}/chat`)}` : '/app?view=account'} className="ui-button-ghost w-full justify-start"><Settings className="size-4" />{t('account')}</Link></Popover.Close>
          {isAdmin ? <Popover.Close asChild><Link href="/admin" className="ui-button-ghost w-full justify-start"><Shield className="size-4" />{sidebar('adminConsole')}</Link></Popover.Close> : null}
          <form action={logoutAction} className="mt-1 border-t border-border pt-1"><BeuiButton nativeButton unstyled type="submit" className="ui-button-ghost w-full justify-start text-destructive"><LogOut className="size-4" />{switcher('signOut')}</BeuiButton></form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
