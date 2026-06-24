'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Lock, Globe, Search } from 'lucide-react';
import { createToolkitAction } from '@/lib/toolkits/actions';

export type ToolkitRow = {
  id: string;
  name: string;
  slug: string;
  visibility: string;
  enabled: boolean;
  toolCount: number;
  created: string;
};

export function ToolkitsBrowser({
  slug,
  toolkits,
}: {
  slug: string;
  toolkits: ToolkitRow[];
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const filtered = toolkits.filter((t) =>
    t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="px-8 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Bundle tools into a single endpoint.
        </p>
        <div className="relative">
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Plus className="size-4" />
            New Toolkit
          </button>
          {creating ? (
            <div className="absolute right-0 top-11 z-20 w-72 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
              <form action={createToolkitAction} className="space-y-2">
                <input type="hidden" name="workspace" value={slug} />
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Toolkit name
                </label>
                <input
                  name="name"
                  autoFocus
                  required
                  maxLength={60}
                  placeholder="e.g. Research stack"
                  className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
                <button className="inline-flex h-9 w-full items-center justify-center rounded-md bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
                  Create toolkit
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search toolkits..."
              className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </div>
          <span className="shrink-0 text-sm text-zinc-400">
            {filtered.length} toolkit{filtered.length === 1 ? '' : 's'}
          </span>
        </div>

        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Toolkit</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Tools</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((t) => (
              <tr
                key={t.id}
                className="transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Link
                      href={`/app/${slug}/toolkits/${t.slug}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {t.name}
                    </Link>
                    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] font-medium capitalize text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                      {t.visibility === 'public' ? (
                        <Globe className="size-3" />
                      ) : (
                        <Lock className="size-3" />
                      )}
                      {t.visibility}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                    <span
                      className={`size-2 rounded-full ${
                        t.enabled ? 'bg-emerald-500' : 'bg-zinc-400'
                      }`}
                    />
                    {t.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                  {t.toolCount}
                </td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                  {t.created}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
