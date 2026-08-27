'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronsUpDown, LogOut, Plus, Shield } from 'lucide-react';
import { logoutAction } from '@/lib/auth/actions';
import { createWorkspaceAction } from '@/lib/workspace/actions';

type Workspace = { id: string; slug: string; name: string };
const WIDE_VIEWPORT_QUERY = '(min-width: 1024px)';

function subscribeToWideViewport(onChange: () => void) {
  const media = window.matchMedia?.(WIDE_VIEWPORT_QUERY);
  if (!media) return () => undefined;
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getWideViewportSnapshot() {
  return window.matchMedia?.(WIDE_VIEWPORT_QUERY).matches ?? false;
}

function initialsOf(name: string): string {
  return (name.match(/\b\w/g) ?? ['W']).slice(0, 2).join('').toUpperCase();
}

export function WorkspaceSwitcher({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
  compact = false,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations('console.workspaceSwitcher');
  const sidebarT = useTranslations('console.sidebar');
  const [creating, setCreating] = useState(false);
  const wideViewport = useSyncExternalStore(
    subscribeToWideViewport,
    getWideViewportSnapshot,
    () => false,
  );
  const compactDesktop = compact && wideViewport;

  return (
    <Popover.Root onOpenChange={(nextOpen) => !nextOpen && setCreating(false)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={compact ? `${workspaceName} · ${userLabel}` : undefined}
          title={compact ? workspaceName : undefined}
          className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent/70 ${compact ? 'lg:justify-center lg:px-0' : ''}`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-foreground shadow-sm ring-1 ring-brand/20">
            {initialsOf(compact ? userLabel : workspaceName)}
          </span>
          <span className={`min-w-0 flex-1 ${compact ? 'lg:hidden' : ''}`}>
            <span className="block truncate text-sm font-medium text-foreground">
              {workspaceName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {userLabel}
            </span>
          </span>
          <ChevronsUpDown className={`size-4 shrink-0 text-muted-foreground ${compact ? 'lg:hidden' : ''}`} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side={compactDesktop ? 'right' : 'top'}
          align={compactDesktop ? 'end' : 'start'}
          sideOffset={8}
          collisionPadding={8}
          aria-label={t('workspaces')}
          className={`z-50 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl lg:z-20 ${
            compactDesktop ? 'w-64' : 'w-[var(--radix-popover-trigger-width)]'
          }`}
        >
          <div className="max-h-64 overflow-y-auto py-1">
            <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('workspaces')}
            </p>
            {workspaces.map((w) => {
              const active = w.slug === slug;
              return (
                <Popover.Close key={w.id} asChild>
                  <Link
                    href={`/app/${w.slug}/chat`}
                    aria-current={active ? 'page' : undefined}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-foreground ring-1 ring-brand/10">
                      {initialsOf(w.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-brand" />
                    ) : null}
                  </Link>
                </Popover.Close>
              );
            })}
          </div>

          <div className="border-t border-border p-1">
            {creating ? (
              <form action={createWorkspaceAction} className="flex gap-1.5 p-1.5">
                <input
                  name="name"
                  autoFocus
                  required
                  maxLength={40}
                  placeholder={t('workspaceName')}
                  className="ui-input h-8 min-w-0 flex-1"
                />
                <button
                  type="submit"
                  className="ui-button-primary h-8 shrink-0 px-3 text-xs"
                >
                  {t('create')}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Plus className="size-4 shrink-0" />
                {t('createWorkspace')}
              </button>
            )}
            {isAdmin ? (
              <Popover.Close asChild>
                <Link
                  href="/admin"
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <Shield className="size-4 shrink-0" />
                  {sidebarT('adminConsole')}
                </Link>
              </Popover.Close>
            ) : null}
            <form action={logoutAction} className="mt-1 border-t border-border pt-1">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              >
                <LogOut className="size-4 shrink-0" />
                {t('signOut')}
              </button>
            </form>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
