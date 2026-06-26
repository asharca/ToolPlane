'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, FileText, GitBranch, Upload } from 'lucide-react';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';

type Mode = 'menu' | 'create' | 'github' | 'upload';
const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export function AddSkillDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const close = () => { setOpen(false); setMode('menu'); setFiles([]); };

  async function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []).slice(0, 20);
    const read = await Promise.all(
      list.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: (await f.text()).slice(0, 256_000) })),
    );
    setFiles(read);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
        <Plus className="size-4" /> Add skill
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
              <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Add a skill</h2>
                  <button type="button" onClick={close} className="text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
                </div>

                {mode === 'menu' ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setMode('github')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <GitBranch className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">Import from GitHub</span><span className="block text-xs text-muted-foreground">Pull a SKILL.md from a repo.</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('upload')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <Upload className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">Upload a folder</span><span className="block text-xs text-muted-foreground">Drag in a skill folder.</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('create')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <FileText className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">Create new</span><span className="block text-xs text-muted-foreground">Start from a blank SKILL.md.</span></span>
                    </button>
                  </div>
                ) : null}

                {mode === 'create' ? (
                  <form action={createCustomSkillAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="name" required placeholder="My awesome skill" className={field} />
                    <input name="description" placeholder="Summarize this skill's purpose" className={field} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Create skill</button>
                  </form>
                ) : null}

                {mode === 'github' ? (
                  <form action={importSkillFromGithubAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="repo" required placeholder="https://github.com/org/skill" className={`${field} font-mono`} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Import</button>
                  </form>
                ) : null}

                {mode === 'upload' ? (
                  <form action={uploadSkillFolderAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="files" value={JSON.stringify(files)} />
                    <input name="name" placeholder="Skill name" className={field} />
                    {/* @ts-expect-error webkitdirectory is a non-standard attribute */}
                    <input type="file" webkitdirectory="" multiple onChange={onPickFolder} className="block w-full text-xs" />
                    <p className="text-xs text-muted-foreground">{files.length} file(s) selected</p>
                    <button type="submit" disabled={files.length === 0} className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">Upload</button>
                  </form>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
