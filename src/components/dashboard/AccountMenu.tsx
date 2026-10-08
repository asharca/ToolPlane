'use client';

import { useState } from 'react';
import { LogOut, Settings, Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover';
import { ButtonLink } from '@/components/motion/button/base';
import { Tooltip } from '@/components/motion/tooltip';
import { workspaceInitials } from '@/lib/workspace/navigation';
import { logoutAction } from '@/lib/auth/actions';

export function AccountMenu({ userLabel, workspaceSlug, returnTo, compact = false, isAdmin = false }: { userLabel: string; workspaceSlug?: string; returnTo?: string; compact?: boolean; isAdmin?: boolean }) {
  const t = useTranslations('console.workspaces');
  const sidebar = useTranslations('console.sidebar');
  const switcher = useTranslations('console.workspaceSwitcher');
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen} side="top" align="start" className="w-full">
    <Tooltip content={`${t('account')}: ${userLabel}`} open={compact ? undefined : false} side="right" wrapperClassName="flex w-full">
    <PopoverTrigger><button type="button" aria-label="账户菜单" className="flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg bg-secondary px-1 py-1 text-left outline-none transition-colors hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#d5ff66] text-[11px] font-semibold text-[#172000]">{workspaceInitials(userLabel)}</span>
      {!compact && <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{userLabel}</span>}
    </button></PopoverTrigger>
    </Tooltip>
    <PopoverContent className="w-56 max-w-[calc(100vw-2rem)] p-1.5">
      <p className="truncate px-2.5 pb-1 pt-2 text-xs font-medium text-foreground">{userLabel}</p>
      <ButtonLink href={workspaceSlug ? `/app/${encodeURIComponent(workspaceSlug)}/settings/account?returnTo=${encodeURIComponent(returnTo ?? `/app/${encodeURIComponent(workspaceSlug)}/chat`)}` : '/app?view=account'} variant="ghost" className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground" onClick={() => setOpen(false)}><Settings className="size-3.5 text-muted-foreground" />{t('account')}</ButtonLink>
      {isAdmin ? <ButtonLink href="/admin" variant="ghost" className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground" onClick={() => setOpen(false)}><Shield className="size-3.5 text-muted-foreground" />{sidebar('adminConsole')}</ButtonLink> : null}
      <form action={logoutAction} className="mt-1 border-t border-border pt-1"><button type="submit" className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"><LogOut className="size-3.5 text-muted-foreground" />{switcher('signOut')}</button></form>
    </PopoverContent>
  </Popover>;
}
