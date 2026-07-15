'use client';

import { useTranslations } from 'next-intl';
import { useState, useRef } from 'react';
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react';
import { setDeploymentEnvAction } from '@/lib/workspace/actions';
import { SubmitButton } from './SubmitButton';

type Row = { id: number; key: string; value: string };

export function VariablesEditor({
  slug,
  deploymentId,
  initial,
}: {
  slug: string;
  deploymentId: string;
  initial: { key: string; value: string }[];
}) {
  const t = useTranslations('console.common');
  const [rows, setRows] = useState<Row[]>(() =>
    (initial.length ? initial : [{ key: '', value: '' }]).map((r, i) => ({ id: i, ...r })),
  );
  const nextId = useRef(rows.length);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const toggleReveal = (id: number) =>
    setRevealed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <form action={setDeploymentEnvAction} className="space-y-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('myCredentials')}</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('environmentVariablesForThisServerRestartToApply')}</p>
      </div>
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="env" value={JSON.stringify(rows.filter((r) => r.key).map(({ key, value }) => ({ key, value })))} />

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="flex gap-2">
            <input
              value={row.key}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
              placeholder="API_KEY"
              className="h-9 w-1/3 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <div className="relative flex-1">
              <input
                type={revealed.has(row.id) ? 'text' : 'password'}
                value={row.value}
                onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                placeholder={t('value')}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 pr-9 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => toggleReveal(row.id)}
                aria-label={revealed.has(row.id) ? t('hideValue') : t('showValue')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                {revealed.has(row.id) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setRows((rs) => [...rs, { id: nextId.current++, key: '', value: '' }])} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Plus className="size-3.5" /> {t('addVariable')}
        </button>
        <SubmitButton className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">{t('save')}</SubmitButton>
      </div>
    </form>
  );
}
