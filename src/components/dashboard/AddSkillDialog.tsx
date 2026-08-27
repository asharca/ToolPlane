'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Plus, X, FileText, GitBranch, Upload } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';
import {
  DEFAULT_SKILL_IMPORT_SKILLS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_IMPORT_FILES,
} from '@/lib/skills/limits';

type Mode = 'menu' | 'create' | 'github' | 'upload';
type FolderSelection = {
  paths: string[];
  skillRoots: string[];
  count: number;
  bytes: number;
  error: string | null;
};

const field = 'ui-input';
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

function GithubImportForm({ slug }: { slug: string }) {
  const t = useTranslations('console.skills');
  const [state, formAction, isPending] = useActionState(importSkillFromGithubAction, {});
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="workspace" value={slug} />
      <input name="repo" required placeholder="https://github.com/org/skills" className={`${field} font-mono`} />
      {state.error ? <p className="text-sm text-red-600 dark:text-red-300" role="alert">{state.error}</p> : null}
      <button type="submit" disabled={isPending} className="ui-button-primary w-full disabled:cursor-wait disabled:opacity-70">
        {isPending ? t('importing') : t('import')}
      </button>
    </form>
  );
}

export function AddSkillDialog({
  slug,
  maxSkillImportSkills = DEFAULT_SKILL_IMPORT_SKILLS,
  defaultOpen = false,
}: {
  slug: string;
  maxSkillImportSkills?: number;
  defaultOpen?: boolean;
}) {
  const t = useTranslations('console.skills');
  const [open, setOpen] = useState(defaultOpen);
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
    } else if (skillRoots.length > maxSkillImportSkills) {
      error = t('selectedFolderTooLarge');
    } else if (list.length > 0 && skillRoots.length === 0) {
      error = t('folderMustContainSkillmd');
    }
    setFolder({ paths, skillRoots, count: list.length, bytes, error });
  }

  const displayedSkillRoots = displaySkillRoots(folder.skillRoots);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => nextOpen ? setOpen(true) : close()}>
      <DialogTrigger asChild>
        <button type="button" className="ui-button-primary">
          <Plus className="size-4" /> {t('addSkill')}
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent aria-describedby={undefined} className="ui-panel !block !gap-0 w-full max-w-md !p-6">
                <div className="mb-4 flex items-center justify-between">
                  <DialogTitle className="text-lg font-semibold text-foreground">{t('addASkill')}</DialogTitle>
                  <DialogClose asChild>
                    <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={t('close')}><X className="size-5" /></button>
                  </DialogClose>
                </div>

                {mode === 'menu' ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setMode('github')} className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted">
                      <GitBranch className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('importFromGithub')}</span><span className="block text-xs text-muted-foreground">{t('pullASkillmdFromARepo')}</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('upload')} className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted">
                      <Upload className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('uploadAFolder')}</span><span className="block text-xs text-muted-foreground">{t('dragInASkillFolder')}</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('create')} className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted">
                      <FileText className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('createNew')}</span><span className="block text-xs text-muted-foreground">{t('startFromABlankSkillmd')}</span></span>
                    </button>
                  </div>
                ) : null}

                {mode === 'create' ? (
                  <form action={createCustomSkillAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="name" required placeholder={t('myAwesomeSkill')} className={field} />
                    <input name="description" placeholder={t('summarizeThisSkillsPurpose')} className={field} />
                    <button type="submit" className="ui-button-primary w-full">{t('createSkill')}</button>
                  </form>
                ) : null}

                {mode === 'github' ? (
                  <GithubImportForm slug={slug} />
                ) : null}

                {mode === 'upload' ? (
                  <form action={uploadSkillFolderAction} encType="multipart/form-data" className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="filePaths" value={JSON.stringify(folder.paths)} />
                    <input
                      name="name"
                      disabled={folder.skillRoots.length > 1}
                      placeholder={folder.skillRoots.length > 1 ? t('namesComeFromEachSkillFolder') : t('skillName')}
                      className={`${field} disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground`}
                    />
                    <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-4 py-5 text-center transition-colors hover:bg-muted">
                      <Upload className="size-5 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{t('uploadAFolder')}</span>
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
                      <div className="rounded-lg border border-border bg-muted/50 p-3">
                        <p className="text-xs font-medium text-foreground">
                          {t('willImportSkills', { count: displayedSkillRoots.length })}
                        </p>
                        <ul className="mt-2 max-h-36 space-y-1 overflow-auto">
                          {displayedSkillRoots.slice(0, 8).map((root) => (
                            <li key={root} className="truncate font-mono text-xs text-muted-foreground">
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
                    <button type="submit" disabled={folder.count === 0 || Boolean(folder.error)} className="ui-button-primary w-full disabled:opacity-50">{t('upload')}</button>
                  </form>
                ) : null}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
