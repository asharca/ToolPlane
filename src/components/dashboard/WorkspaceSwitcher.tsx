'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { CreateWorkspaceForm } from './WorkspaceForms';
import { workspaceInitials, workspaceSwitchHref, type WorkspaceSummary } from '@/lib/workspace/navigation';

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
  workspaces: WorkspaceSummary[];
  isAdmin?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations('console.workspaceSwitcher');
  const managementT = useTranslations('console.workspaces');
  const pathname = usePathname() ?? '';
  const [creating, setCreating] = useState(false);
  const wideViewport = useSyncExternalStore(
    subscribeToWideViewport,
    getWideViewportSnapshot,
    () => false,
  );
  const compactDesktop = compact && wideViewport;
  const current = workspaces.find((workspace) => workspace.slug === slug);

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
            {workspaceInitials(workspaceName)}
          </span>
          <span className={`min-w-0 flex-1 ${compact ? 'lg:hidden' : ''}`}>
            <span className="block truncate text-sm font-medium text-foreground">
              {workspaceName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {managementT(current?.role ?? 'member')}
            </span>
          </span>
          <ChevronsUpDown className={`size-4 shrink-0 text-muted-foreground ${compact ? 'lg:hidden' : ''}`} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side={compactDesktop ? 'right' : 'bottom'}
          align="start"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t('workspaces')}
          className={`z-50 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl lg:z-20 ${
            compactDesktop ? 'w-72 max-w-[calc(100vw-2rem)]' : 'w-72 max-w-[calc(100vw-2rem)]'
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
                    href={workspaceSwitchHref(slug, w.slug, pathname)}
                    onClick={(event) => { if (active) event.preventDefault(); }}
                    aria-current={active ? 'page' : undefined}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-foreground ring-1 ring-brand/10">
                      {workspaceInitials(w.name)}
                    </span>
                    <span className="min-w-0 flex-1"><span className="block truncate">{w.name}</span><span className="block text-xs text-muted-foreground">{managementT(w.role ?? 'member')}</span></span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-brand" />
                    ) : null}
                  </Link>
                </Popover.Close>
              );
            })}
          </div>

          <div className="border-t border-border p-1">
            <Popover.Close asChild>
              <Link
                href={`/app/${encodeURIComponent(slug)}/settings?returnTo=${encodeURIComponent(pathname)}`}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-accent"
              >
                <Settings className="size-4" />
                {managementT('settings')}
              </Link>
            </Popover.Close>
            {creating ? (
              <div className="p-3"><CreateWorkspaceForm autoFocus /></div>
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
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
