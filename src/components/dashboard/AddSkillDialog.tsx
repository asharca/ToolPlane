'use client';
import { Input } from '@/components/motion/input';
import { Button } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalTrigger, CenterMorphModalContent } from '@/components/motion/center-morph-modal';


import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Plus, FileText, GitBranch, Upload } from 'lucide-react';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';
import { DEFAULT_SKILL_IMPORT_SKILLS, MAX_SKILL_FILE_BYTES, MAX_SKILL_IMPORT_BYTES, MAX_SKILL_IMPORT_FILES } from '@/lib/skills/limits';

type Mode = 'menu' | 'create' | 'github' | 'upload';
type FolderSelection = {
  paths: string[];
  skillRoots: string[];
  count: number;
  bytes: number;
  error: string | null;
};

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
      <Input label={t('importFromGithub')} name="repo" required placeholder="https://github.com/org/skills" />
      {state.error ? <p className="text-sm text-destructive dark:text-destructive" role="alert">{state.error}</p> : null}
      <Button type="submit" disabled={isPending} variant="primary" size="md" className="w-full">{isPending ? t('importing') : t('import')}</Button>
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
    <CenterMorphModal open={open} onOpenChange={(nextOpen) => nextOpen ? setOpen(true) : close()}>
      <CenterMorphModalTrigger>
        <Button type="button" variant="primary" size="md"><Plus className="size-4" /> {t('addSkill')}</Button>
      </CenterMorphModalTrigger>

      
        
        <CenterMorphModalContent ariaLabel={t('addASkill')} closeButtonLabel={t('close')} className="w-full max-w-xl p-6">
                <div className="mb-4 flex items-center pr-10">
                  <h2 className="text-lg font-semibold text-foreground">{t('addASkill')}</h2>
                </div>

                {mode === 'menu' ? (
                  <div className="space-y-2">
                    <Button type="button" onClick={() => setMode('github')} variant="secondary" size="lg" className="w-full justify-start text-left"><GitBranch className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('importFromGithub')}</span><span className="block text-xs text-muted-foreground">{t('pullASkillmdFromARepo')}</span></span></Button>
                    <Button type="button" onClick={() => setMode('upload')} variant="secondary" size="md" className="flex w-full items-center text-left"><Upload className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('uploadAFolder')}</span><span className="block text-xs text-muted-foreground">{t('dragInASkillFolder')}</span></span></Button>
                    <Button type="button" onClick={() => setMode('create')} variant="secondary" size="md" className="flex w-full items-center text-left"><FileText className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{t('createNew')}</span><span className="block text-xs text-muted-foreground">{t('startFromABlankSkillmd')}</span></span></Button>
                  </div>
                ) : null}

                {mode === 'create' ? (
                  <form action={createCustomSkillAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <Input label={t('skillName')} name="name" required placeholder={t('myAwesomeSkill')} />
                    <Input label={t('summarizeThisSkillsPurpose')} name="description" placeholder={t('summarizeThisSkillsPurpose')} />
                    <Button type="submit" variant="primary" size="md" className="w-full">{t('createSkill')}</Button>
                  </form>
                ) : null}

                {mode === 'github' ? (
                  <GithubImportForm slug={slug} />
                ) : null}

                {mode === 'upload' ? (
                  <form action={uploadSkillFolderAction} encType="multipart/form-data" className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="filePaths" value={JSON.stringify(folder.paths)} />
                    <Input name="name" disabled={folder.skillRoots.length > 1} placeholder={folder.skillRoots.length > 1 ? t('namesComeFromEachSkillFolder') : t('skillName')} />
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
                    <p className={`text-xs ${folder.error ? 'text-destructive dark:text-destructive' : 'text-muted-foreground'}`}>
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
                    <Button type="submit" disabled={folder.count === 0 || Boolean(folder.error)} variant="primary" size="md" className="w-full">{t('upload')}</Button>
                  </form>
                ) : null}
        </CenterMorphModalContent>
      
    </CenterMorphModal>
  );
}
