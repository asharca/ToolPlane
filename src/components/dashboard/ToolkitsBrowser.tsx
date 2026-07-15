'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { Plus, Lock, Globe, Settings, Store, Wrench, X } from 'lucide-react';
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

function CreateToolkitToggle({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  const t = useTranslations('console.toolkits');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-controls="toolkit-create-form"
      aria-expanded={expanded}
      className={expanded ? 'ui-button-secondary' : 'ui-button-primary'}
    >
      {expanded ? <X className="size-4" /> : <Plus className="size-4" />}
      {expanded ? t('cancel') : t('newToolkit')}
    </button>
  );
}

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
  const toggleCreateForm = () => setCreating((value) => !value);

  return (
    <DashboardPage>
      <DashboardToolbar
        actions={
          <>
            <Link href={`/app/${slug}/toolkits/new`} className="ui-button-secondary">
              <Store className="size-4" />
              {t('browseMarket')}
            </Link>
            <CreateToolkitToggle expanded={creating} onClick={toggleCreateForm} />
          </>
        }
      >
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('bundleToolsIntoASingleEndpoint')}
        </p>
      </DashboardToolbar>

      {creating ? (
        <form
          id="toolkit-create-form"
          action={createToolkitAction}
          className="ui-panel grid gap-3 p-4 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end"
        >
          <input type="hidden" name="workspace" value={slug} />
          <label htmlFor="toolkit-create-name" className="block text-xs font-medium text-muted-foreground">
            {t('toolkitName')}
            <input
              id="toolkit-create-name"
              name="name"
              autoFocus
              required
              maxLength={60}
              placeholder={t('egResearchStack')}
              className="ui-input mt-1.5 h-9"
            />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="ui-button-secondary"
            >
              {t('cancel')}
            </button>
            <button className="ui-button-primary">
              {t('createToolkit')}
            </button>
          </div>
        </form>
      ) : null}

      {toolkits.length === 0 ? (
        <DashboardEmptyState
          icon={Wrench}
          description={t('noToolkitsYet')}
          actions={!creating ? (
            <CreateToolkitToggle expanded={creating} onClick={toggleCreateForm} />
          ) : undefined}
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
              description={t('noToolkitsMatch', { query: query.trim() })}
              className="min-h-64 rounded-none border-0 shadow-none"
            />
          ) : (
            <DashboardTable
              headers={[
                { label: t('toolkitColumn') },
                { label: t('status') },
                { label: t('tools') },
                { label: t('created') },
                { label: t('settings'), align: 'right' },
              ]}
              panel={false}
            >
              {filtered.map((toolkit) => (
                <tr key={toolkit.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Link
                        href={`/app/${slug}/toolkits/${toolkit.slug}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {toolkit.name}
                      </Link>
                      <span className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
                        {toolkit.visibility === 'public' ? (
                          <Globe className="size-3" />
                        ) : (
                          <Lock className="size-3" />
                        )}
                        {toolkit.visibility === 'public' ? t('public') : t('private')}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <span
                        className={`size-2 rounded-full ${
                          toolkit.enabled ? 'bg-emerald-500' : 'bg-zinc-400'
                        }`}
                      />
                      {toolkit.enabled ? t('enabled') : t('disabled')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {toolkit.toolCount}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {toolkit.created}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/app/${slug}/toolkits/${toolkit.slug}?tab=settings`}
                      aria-label={`${toolkit.name}: ${t('settings')}`}
                      title={t('settings')}
                      className="ui-button-ghost ui-icon-button ml-auto size-8 min-h-8"
                    >
                      <Settings className="size-4" />
                    </Link>
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
