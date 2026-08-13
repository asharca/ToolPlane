'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronsUpDown, LogOut, Plus } from 'lucide-react';
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
  compact = false,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  compact?: boolean;
}) {
  const t = useTranslations('console.workspaceSwitcher');
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
          className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${compact ? 'lg:justify-center lg:px-0' : ''}`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
            {initialsOf(workspaceName)}
          </span>
          <span className={`min-w-0 flex-1 ${compact ? 'lg:hidden' : ''}`}>
            <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {workspaceName}
            </span>
            <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
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
          className={`z-50 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 lg:z-20 ${
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
                    href={`/app/${w.slug}/mcp`}
                    aria-current={active ? 'page' : undefined}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded bg-zinc-900 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                      {initialsOf(w.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-zinc-900 dark:text-zinc-100" />
                    ) : null}
                  </Link>
                </Popover.Close>
              );
            })}
          </div>

          <div className="border-t border-zinc-200 p-1 dark:border-zinc-700">
            {creating ? (
              <form action={createWorkspaceAction} className="flex gap-1.5 p-1.5">
                <input
                  name="name"
                  autoFocus
                  required
                  maxLength={40}
                  placeholder={t('workspaceName')}
                  className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  className="h-8 shrink-0 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {t('create')}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <Plus className="size-4 shrink-0" />
                {t('createWorkspace')}
              </button>
            )}
            <form action={logoutAction} className="mt-1 border-t border-zinc-100 pt-1 dark:border-zinc-800">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
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
