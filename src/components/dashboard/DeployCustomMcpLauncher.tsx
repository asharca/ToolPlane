'use client';

import { useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Trash2, AlertTriangle } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';

const SOURCES = [
  { key: 'npm', label: 'npm', enabled: true },
  { key: 'pypi', label: 'PyPI', enabled: false },
  { key: 'github', label: 'GitHub', enabled: false },
  { key: 'docker', label: 'Docker', enabled: false },
];

type EnvRow = { key: string; value: string };

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500';

export function DeployCustomMcpLauncher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('npm');
  const [name, setName] = useState('');
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [pending, startTransition] = useTransition();

  const slugPreview =
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <Plus className="size-4" />
        Deploy custom MCP
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <div
            className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Deploy custom MCP</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-700">
                <X className="size-5" />
              </button>
            </div>

            <div className="mb-5 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                MCP servers can access your data and execute arbitrary code. Only install servers from sources you trust.
              </span>
            </div>

            <form
              action={(fd) =>
                startTransition(async () => {
                  await deployCustomServerAction(fd);
                  setOpen(false);
                  setName('');
                  setEnv([]);
                })
              }
              className="space-y-5"
            >
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="source" value={source} />
              <input type="hidden" name="env" value={JSON.stringify(env)} />

              <div>
                <p className={labelCls}>Source</p>
                <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
                  {SOURCES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      disabled={!s.enabled}
                      onClick={() => s.enabled && setSource(s.key)}
                      title={s.enabled ? undefined : 'Coming soon'}
                      className={`flex-1 rounded px-2 py-1.5 text-sm transition-colors ${
                        source === s.key
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                          : 'text-zinc-600 dark:text-zinc-300'
                      } ${s.enabled ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'cursor-not-allowed opacity-40'}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="packageRef" className={labelCls}>NPM package</label>
                <input
                  id="packageRef"
                  name="packageRef"
                  required
                  placeholder="@modelcontextprotocol/server-everything"
                  className={`${field} font-mono`}
                />
              </div>

              <div>
                <label htmlFor="server-name" className={labelCls}>Server name</label>
                <input
                  id="server-name"
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Weather API"
                  className={field}
                />
                <p className="mt-1 font-mono text-xs text-zinc-400">
                  /{slug}/mcp/{slugPreview}
                </p>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Environment variables</span>
                  <button
                    type="button"
                    onClick={() => setEnv((rows) => [...rows, { key: '', value: '' }])}
                    className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    + Add
                  </button>
                </div>
                <div className="space-y-2">
                  {env.map((row, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={row.key}
                        onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                        placeholder="KEY"
                        className={`${field} w-1/3 font-mono text-xs`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        placeholder="value"
                        className={`${field} flex-1 font-mono text-xs`}
                      />
                      <button
                        type="button"
                        onClick={() => setEnv((rows) => rows.filter((_, j) => j !== i))}
                        className="text-zinc-400 hover:text-red-600"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="args" className={labelCls}>Arguments</label>
                <input id="args" name="args" placeholder="--port 3000" className={`${field} font-mono`} />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {pending ? 'Deploying…' : 'Deploy'}
                </button>
              </div>
            </form>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
