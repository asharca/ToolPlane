'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, FileText, GitBranch, Upload } from 'lucide-react';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_IMPORT_FILES,
  MAX_SKILL_IMPORT_SKILLS,
} from '@/lib/skills/limits';

type Mode = 'menu' | 'create' | 'github' | 'upload';
type FolderSelection = {
  paths: string[];
  skillRoots: string[];
  count: number;
  bytes: number;
  error: string | null;
};

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const emptySelection: FolderSelection = { paths: [], skillRoots: [], count: 0, bytes: 0, error: null };
const directoryInputProps = {
  directory: '',
  webkitdirectory: '',
} as React.InputHTMLAttributes<HTMLInputElement> & { directory: string; webkitdirectory: string };

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function directoryName(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

function previewSkillRoots(paths: string[]): string[] {
  const roots = paths
    .filter((path) => /(^|\/)SKILL\.md$/i.test(path))
    .map(directoryName);
  return Array.from(new Set(roots)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function displaySkillRoots(roots: string[]): string[] {
  if (roots.length === 0) return [];
  if (roots.length === 1) return [roots[0].split('/').filter(Boolean).pop() || 'SKILL.md'];
  const splitRoots = roots.map((root) => root.split('/').filter(Boolean));
  let common = 0;
  while (
    splitRoots.every((parts) => parts.length > common && parts[common] === splitRoots[0][common])
  ) {
    common += 1;
  }
  return splitRoots.map((parts) => parts.slice(common).join('/') || parts.at(-1) || 'SKILL.md');
}

export function AddSkillDialog({ slug }: { slug: string }) {
  const t = useTranslations('console.skills');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [folder, setFolder] = useState<FolderSelection>(emptySelection);
  const close = () => { setOpen(false); setMode('menu'); setFolder(emptySelection); };

  function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    const paths = list.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    const bytes = list.reduce((total, file) => total + file.size, 0);
    const skillRoots = previewSkillRoots(paths);
    let error: string | null = null;
    if (list.length > MAX_SKILL_IMPORT_FILES) {
      error = t('selectedFolderTooLarge');
    } else if (list.some((file) => file.size > MAX_SKILL_FILE_BYTES)) {
      error = t('selectedFolderTooLarge');
    } else if (bytes > MAX_SKILL_IMPORT_BYTES) {
      error = t('selectedFolderTooLarge');
    } else if (skillRoots.length > MAX_SKILL_IMPORT_SKILLS) {
      error = t('selectedFolderTooLarge');
    } else if (list.length > 0 && skillRoots.length === 0) {
      error = t('folderMustContainSkillmd');
    }
    setFolder({ paths, skillRoots, count: list.length, bytes, error });
  }

  const displayedSkillRoots = displaySkillRoots(folder.skillRoots);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
        <Plus className="size-4" /> {t('addSkill')}
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
              <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('addASkill')}</h2>
                  <button type="button" onClick={close} className="text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
                </div>

                {mode === 'menu' ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setMode('github')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <GitBranch className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('importFromGithub')}</span><span className="block text-xs text-muted-foreground">{t('pullASkillmdFromARepo')}</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('upload')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <Upload className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('uploadAFolder')}</span><span className="block text-xs text-muted-foreground">{t('dragInASkillFolder')}</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('create')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <FileText className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('createNew')}</span><span className="block text-xs text-muted-foreground">{t('startFromABlankSkillmd')}</span></span>
                    </button>
                  </div>
                ) : null}

                {mode === 'create' ? (
                  <form action={createCustomSkillAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="name" required placeholder={t('myAwesomeSkill')} className={field} />
                    <input name="description" placeholder={t('summarizeThisSkillsPurpose')} className={field} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{t('createSkill')}</button>
                  </form>
                ) : null}

                {mode === 'github' ? (
                  <form action={importSkillFromGithubAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="repo" required placeholder="https://github.com/org/skill" className={`${field} font-mono`} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{t('import')}</button>
                  </form>
                ) : null}

                {mode === 'upload' ? (
                  <form action={uploadSkillFolderAction} encType="multipart/form-data" className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="filePaths" value={JSON.stringify(folder.paths)} />
                    <input
                      name="name"
                      disabled={folder.skillRoots.length > 1}
                      placeholder={folder.skillRoots.length > 1 ? t('namesComeFromEachSkillFolder') : t('skillName')}
                      className={`${field} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 dark:disabled:bg-zinc-900 dark:disabled:text-zinc-500`}
                    />
                    <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-5 text-center transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
                      <Upload className="size-5 text-muted-foreground" />
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('uploadAFolder')}</span>
                      <span className="text-xs text-muted-foreground">{t('dragInASkillFolder')}</span>
                      <input
                        {...directoryInputProps}
                        name="folderFiles"
                        type="file"
                        multiple
                        onChange={onPickFolder}
                        className="sr-only"
                      />
                    </label>
                    <p className={`text-xs ${folder.error ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground'}`}>
                      {folder.error ?? `${folder.count} ${t('filesSelected')} · ${formatBytes(folder.bytes)}`}
                    </p>
                    {displayedSkillRoots.length > 0 ? (
                      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
                        <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          {t('willImportSkills', { count: displayedSkillRoots.length })}
                        </p>
                        <ul className="mt-2 max-h-36 space-y-1 overflow-auto">
                          {displayedSkillRoots.slice(0, 8).map((root) => (
                            <li key={root} className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                              {root}
                            </li>
                          ))}
                        </ul>
                        {displayedSkillRoots.length > 8 ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t('moreSkills', { count: displayedSkillRoots.length - 8 })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <button type="submit" disabled={folder.count === 0 || Boolean(folder.error)} className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">{t('upload')}</button>
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
