'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, AlertTriangle, Box } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';
import { SubmitButton } from './SubmitButton';

const SOURCES = [
  { key: 'npm', label: 'npm', field: 'npm Package', placeholder: '@modelcontextprotocol/server-filesystem' },
  { key: 'pypi', label: 'PyPI', field: 'PyPI Package', placeholder: 'mcp-server-fetch' },
  { key: 'github', label: 'GitHub', field: 'GitHub Repository', placeholder: 'https://github.com/org/mcp-server' },
  { key: 'docker', label: 'Docker', field: 'Docker Image', placeholder: 'mcp/slack' },
];

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground';

type SandboxOption = { id: string; name: string; status: string };

export function DeployCustomMcpDialog({ slug, sandboxes = [] }: { slug: string; sandboxes?: SandboxOption[] }) {
  const t = useTranslations('console.mcp');
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('npm');
  const [name, setName] = useState('');
  const [runInSandbox, setRunInSandbox] = useState(false);
  const current = SOURCES.find((s) => s.key === source) ?? SOURCES[0];
  const slugPreview =
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server';
  const canRunInSandbox = sandboxes.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ui-button-primary"
      >
        <Plus className="size-4" />
        {t('addCustomMcp')}
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
              <div
                className="w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('deployCustomMcp')}</h2>
                  <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                    <X className="size-5" />
                  </button>
                </div>
                <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{t('deployCustomMcp')}</p>

                <div className="mb-5 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{t('mcpCanAccessYourDataAndExecuteArbitraryCodeOnlyInstallSourcesYouTrust')}</span>
                </div>

                <form action={deployCustomServerAction} className="space-y-5">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="source" value={source} />

                  <div>
                    <p className={labelCls}>{t('source')}</p>
                    <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
                      {SOURCES.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setSource(s.key)}
                          className={`flex-1 rounded px-2 py-1.5 text-sm transition-colors ${
                            source === s.key ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="ref" className={labelCls}>{current.field}</label>
                    <input id="ref" name="ref" required placeholder={current.placeholder} className={`${field} font-mono`} />
                  </div>

                  {source === 'docker' ? (
                    <div>
                      <label htmlFor="startCommand" className={labelCls}>{t('startCommand')}</label>
                      <input id="startCommand" name="startCommand" placeholder="node dist/index.js" className={`${field} font-mono`} />
                    </div>
                  ) : null}

                  <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 size-4 rounded border-zinc-300"
                        checked={runInSandbox}
                        disabled={!canRunInSandbox}
                        onChange={(e) => setRunInSandbox(e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <Box className="size-4" />
                          {t('runInsideSandbox')}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {canRunInSandbox ? t('runInsideSandboxDescription') : t('noDockerSandboxesAvailable')}
                        </span>
                      </span>
                    </label>
                    {runInSandbox && canRunInSandbox ? (
                      <div className="mt-3">
                        <label htmlFor="sandboxId" className={labelCls}>{t('sandbox')}</label>
                        <select id="sandboxId" name="sandboxId" required className={field} defaultValue={sandboxes[0]?.id ?? ''}>
                          {sandboxes.map((sandbox) => (
                            <option key={sandbox.id} value={sandbox.id}>
                              {sandbox.name} ({sandbox.status})
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <label htmlFor="name" className={labelCls}>{t('serverName')}</label>
                    <input id="name" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('weatherApi')} className={field} />
                    <p className="mt-1 font-mono text-xs text-muted-foreground">/{slug}{t('mcp')}{slugPreview}</p>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setOpen(false)} className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">{t('cancel')}</button>
                    <SubmitButton pendingLabel={t('deploying')} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">{t('deploy')}</SubmitButton>
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
