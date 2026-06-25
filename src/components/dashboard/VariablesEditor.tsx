'use client';

import { useState, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { setDeploymentEnvAction } from '@/lib/workspace/actions';

type Row = { id: number; key: string; value: string };

export function VariablesEditor({ slug, deploymentId, initial }: { slug: string; deploymentId: string; initial: { key: string; value: string }[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    (initial.length ? initial : [{ key: '', value: '' }]).map((r, i) => ({ id: i, ...r })),
  );
  const nextId = useRef(rows.length);

  return (
    <form action={setDeploymentEnvAction} className="space-y-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">My Credentials</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Environment variables for this server. Restart to apply.</p>
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
            <input
              type="password"
              value={row.value}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
              placeholder="value"
              className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setRows((rs) => [...rs, { id: nextId.current++, key: '', value: '' }])} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          <Plus className="size-3.5" /> Add variable
        </button>
        <button type="submit" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Save</button>
      </div>
    </form>
  );
}
