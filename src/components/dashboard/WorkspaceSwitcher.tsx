'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
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
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setCreating(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
          {initialsOf(workspaceName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {workspaceName}
          </span>
          <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
            {userLabel}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="max-h-64 overflow-y-auto py-1">
            <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Workspaces
            </p>
            {workspaces.map((w) => {
              const active = w.slug === slug;
              return (
                <Link
                  key={w.id}
                  href={`/app/${w.slug}/mcp`}
                  role="menuitem"
                  onClick={() => setOpen(false)}
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
                  placeholder="Workspace name"
                  className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  className="h-8 shrink-0 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  Create
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <Plus className="size-4 shrink-0" />
                Create workspace
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
