'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, LogOut, Plus } from 'lucide-react';
import { logoutAction } from '@/lib/auth/actions';
import { createWorkspaceAction } from '@/lib/workspace/actions';

type Workspace = { id: string; slug: string; name: string };

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
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    setCreating(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function menuItems(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.matches('input, textarea, select') || target.isContentEditable)
    ) {
      return;
    }

    const items = menuItems();
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | undefined;

    switch (event.key) {
      case 'ArrowDown':
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
        break;
      case 'ArrowUp':
        nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    items[nextIndex].focus();
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      setCreating(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || creating) return;
    const items = menuItems();
    const currentItem = items.find((item) => item.getAttribute('aria-current') === 'page');
    (currentItem ?? items[0])?.focus();
  }, [open, creating]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) {
            closeMenu();
          } else {
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
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

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className={`absolute z-20 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${
            compact
              ? 'bottom-full left-0 mb-2 w-full lg:bottom-0 lg:left-full lg:mb-0 lg:ml-2 lg:w-64'
              : 'bottom-full left-0 mb-2 w-full'
          }`}
        >
          <div className="max-h-64 overflow-y-auto py-1">
            <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('workspaces')}
            </p>
            {workspaces.map((w) => {
              const active = w.slug === slug;
              return (
                <Link
                  key={w.id}
                  href={`/app/${w.slug}/mcp`}
                  role="menuitem"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => closeMenu()}
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
                role="menuitem"
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
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                <LogOut className="size-4 shrink-0" />
                {t('signOut')}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
