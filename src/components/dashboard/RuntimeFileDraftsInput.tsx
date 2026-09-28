'use client';
import { AnimatedBadge } from '@/components/motion/animated-badge';

import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';


import { useId, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Plus, Trash2, Upload } from 'lucide-react';

export type RuntimeFileDraft = {
  path: string;
  content: string;
};

function replaceOrAppendDrafts(
  current: RuntimeFileDraft[],
  incoming: RuntimeFileDraft[],
): RuntimeFileDraft[] {
  const next = [...current];
  for (const draft of incoming) {
    const key = runtimeFilePathKey(draft.path);
    // Keep incomplete blank rows independent so a user can add several files
    // before naming them. Non-empty paths mirror the server's portable key.
    const existingIndex = key
      ? next.findIndex((entry) => runtimeFilePathKey(entry.path) === key)
      : -1;
    if (existingIndex === -1) next.push(draft);
    else next[existingIndex] = draft;
  }
  return next;
}

export function runtimeFilePathKey(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.normalize('NFC').toLocaleLowerCase('en-US') : null;
}

async function readPlainTextFile(file: File): Promise<RuntimeFileDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) {
    throw new Error('Selected files must be plain text; binary files are not supported.');
  }
  // File.text() replaces malformed UTF-8 sequences. A fatal decoder ensures
  // that a binary file cannot become an apparently valid text configuration.
  // `ignoreBOM: true` preserves a user-supplied UTF-8 BOM exactly.
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path: file.name, content };
}

/**
 * Controlled input for files that will be created alongside a new MCP
 * deployment. It intentionally accepts every filename and extension; the
 * only client-side content restriction is valid UTF-8 text with no NUL bytes.
 */
export function RuntimeFileDraftsInput({
  value,
  onChange,
  disabled = false,
  relativePathArgumentsWork = true,
}: {
  value: RuntimeFileDraft[];
  onChange: (value: RuntimeFileDraft[]) => void;
  disabled?: boolean;
  relativePathArgumentsWork?: boolean;
}) {
  const t = useTranslations('console.mcp');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const addFile = () => {
    setUploadError(null);
    onChange([...value, { path: '', content: '' }]);
  };

  const updateFile = (index: number, update: Partial<RuntimeFileDraft>) => {
    onChange(value.map((file, currentIndex) => (
      currentIndex === index ? { ...file, ...update } : file
    )));
  };

  const removeFile = (index: number) => {
    setUploadError(null);
    onChange(value.filter((_, currentIndex) => currentIndex !== index));
  };

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Allow the same file to be selected again after the user fixes it.
    event.target.value = '';
    if (files.length === 0) return;

    setUploadError(null);
    try {
      const drafts = await Promise.all(files.map(readPlainTextFile));
      onChange(replaceOrAppendDrafts(value, drafts));
    } catch {
      setUploadError(t('invalidRuntimeTextUpload'));
    }
  };

  return (
    <section className="rounded-lg border border-border" aria-labelledby={`${id}-heading`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <h3 id={`${id}-heading`} className="text-sm font-semibold text-foreground">
              {t('runtimeFiles')}
            </h3>
            <AnimatedBadge  status="neutral" size="sm" showIcon={false}>
              {value.length}
            </AnimatedBadge>
          </div>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            {t('runtimeFilesCreateDescription')}
          </p>
          {relativePathArgumentsWork ? (
            <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
              {t('runtimeFilesRelativeArgumentHint')}
            </p>
          ) : null}
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            {t('runtimeFilesAbsolutePathHint')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} variant="secondary" size="sm"><Upload className="size-3.5" />
          {t('uploadTextFiles')}</Button>
          <Button type="button" disabled={disabled} onClick={addFile} variant="secondary" size="sm"><Plus className="size-3.5" />
          {t('addFile')}</Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            tabIndex={-1}
            aria-label={t('uploadTextFiles')}
            disabled={disabled}
            onChange={uploadFiles}
            className="sr-only"
          />
        </div>
      </header>

      {value.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noRuntimeFilesToCreate')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {value.map((file, index) => (
            <div key={index} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <label className="min-w-0 flex-1 space-y-1.5 text-xs font-medium text-muted-foreground">
                  {t('relativeFilePath')}
                  <Input value={file.path} onChange={(value) => updateFile(index, { path: value })} disabled={disabled} placeholder="ssh-config.json" spellCheck={false} />
                </label>
                <Button type="button" disabled={disabled} onClick={() => removeFile(index)} variant="ghost" size="sm" className="inline-flex items-center"><Trash2 className="size-3.5" />
                {t('remove')}</Button>
              </div>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                {t('textContent')}
                <textarea value={file.content} onChange={(event) => updateFile(index, { content: event.target.value })} disabled={disabled} spellCheck={false} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-44" />
              </label>
            </div>
          ))}
        </div>
      )}

      {uploadError ? (
        <p className="border-t border-border px-4 py-3 text-xs text-destructive dark:text-destructive" role="alert">
          {uploadError}
        </p>
      ) : null}
    </section>
  );
}
