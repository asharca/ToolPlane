'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { Plus, Lock, Globe, Store, Wrench } from 'lucide-react';
import { createToolkitAction } from '@/lib/toolkits/actions';
import {
  DashboardEmptyState,
  DashboardFilterInput,
  DashboardPage,
  DashboardTable,
  DashboardToolbar,
} from './DashboardUI';

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
  const t = useTranslations('console.toolkits');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const filtered = toolkits.filter((t) =>
    t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <DashboardPage>
      <DashboardToolbar
        actions={
          <>
            <Link href={`/app/${slug}/toolkits/new`} className="ui-button-secondary">
              <Store className="size-4" />
              {t('browseMarket')}
            </Link>
            <div className="relative">
              <button
                type="button"
                onClick={() => setCreating((v) => !v)}
                className="ui-button-primary"
              >
                <Plus className="size-4" />
                {t('newToolkit')}
              </button>
              {creating ? (
                <div className="ui-panel absolute right-0 top-11 z-20 w-72 p-3">
                  <form action={createToolkitAction} className="space-y-2">
                    <input type="hidden" name="workspace" value={slug} />
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('toolkitName')}
                    </label>
                    <input
                      name="name"
                      autoFocus
                      required
                      maxLength={60}
                      placeholder={t('egResearchStack')}
                      className="ui-input h-9"
                    />
                    <button className="ui-button-primary w-full">
                      {t('createToolkit')}
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          </>
        }
      >
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('bundleToolsIntoASingleEndpoint')}
        </p>
      </DashboardToolbar>

      {toolkits.length === 0 ? (
        <DashboardEmptyState
          icon={Wrench}
          description={t('noToolkitsYet')}
          actions={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="ui-button-primary"
            >
              <Plus className="size-4" />
              {t('newToolkit')}
            </button>
          }
        />
      ) : (
        <div className="ui-panel overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
            <DashboardFilterInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchToolkits')}
            />
            <span className="shrink-0 text-sm text-muted-foreground">
              {t('toolkitCount', { count: filtered.length })}
            </span>
          </div>

          {filtered.length === 0 ? (
            <DashboardEmptyState
              description={`No toolkits match "${query.trim()}".`}
              className="min-h-64 rounded-none border-0 shadow-none"
            />
          ) : (
            <DashboardTable
              headers={[
                { label: 'Toolkit' },
                { label: 'Status' },
                { label: 'Tools' },
                { label: 'Created' },
              ]}
              panel={false}
            >
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Link
                        href={`/app/${slug}/toolkits/${t.slug}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {t.name}
                      </Link>
                      <span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
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
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <span
                        className={`size-2 rounded-full ${
                          t.enabled ? 'bg-emerald-500' : 'bg-zinc-400'
                        }`}
                      />
                      {t.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {t.toolCount}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {t.created}
                  </td>
                </tr>
              ))}
            </DashboardTable>
          )}
        </div>
      )}
    </DashboardPage>
  );
}
