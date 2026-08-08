'use client';

import {
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  Eye,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteDeploymentRuntimeFileAction,
  revealDeploymentRuntimeFileAction,
  upsertDeploymentRuntimeFileAction,
  type RuntimeFileMetadata,
  type RuntimeFilesActionState,
} from '@/lib/workspace/runtime-files-actions';

type Draft = {
  /** A present id means the user explicitly revealed an existing file. */
  fileId?: string;
  path: string;
  content: string;
  source: 'new' | 'upload' | 'revealed';
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function runtimeFilePathKey(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.normalize('NFC').toLocaleLowerCase('en-US') : null;
}

function actionErrorMessage(
  error: RuntimeFilesActionState['error'],
  t: ReturnType<typeof useTranslations>,
): string | null {
  switch (error) {
    case 'invalidFile':
      return t('invalidRuntimeFile');
    case 'notAuthorized':
      return t('runtimeFileNotAuthorized');
    case 'deploymentNotFound':
      return t('deploymentNotFound');
    case 'fileNotFound':
      return t('runtimeFileNotFound');
    case 'saveFailed':
      return t('runtimeFileSaveFailed');
    case 'restartFailed':
      return t('runtimeFileRestartFailed');
    default:
      return null;
  }
}

function removeActionErrorMessage(
  error: RuntimeFilesActionState['error'],
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (error === 'saveFailed') return t('runtimeFileRemoveFailed');
  if (error === 'restartFailed') return t('runtimeFileRemoveRestartFailed');
  return actionErrorMessage(error, t);
}

/**
 * Editor for deployment-scoped text files that are materialized into an MCP
 * runtime. Content is deliberately not part of `initialFiles`: existing
 * content reaches the browser only after an explicit reveal request.
 *
 * `upsertDeploymentRuntimeFileAction` receives `workspace`, `deploymentId`,
 * `path`, and `content`, saves the text file, and submits a runtime restart.
 * `deleteDeploymentRuntimeFileAction` receives `workspace`, `deploymentId`,
 * and `fileId`, removes the file, and submits a runtime restart.
 */
export function RuntimeFilesEditor({
  workspace,
  deploymentId,
  initialFiles,
  relativePathArgumentsWork = true,
}: {
  workspace: string;
  deploymentId: string;
  initialFiles: RuntimeFileMetadata[];
  relativePathArgumentsWork?: boolean;
}) {
  const t = useTranslations('console.mcp');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedFiles, setSavedFiles] = useState<RuntimeFileMetadata[]>([]);
  const [removedFileIds, setRemovedFileIds] = useState<Set<string>>(() => new Set());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'saved' | 'removed' | null>(null);
  const [isRevealing, startReveal] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Props remain the source of truth. These small local overlays make a save
  // or deletion visible immediately while the server action revalidates the
  // page, without copying props into state in an effect.
  const savedByPathKey = new Map<string, RuntimeFileMetadata>();
  for (const file of savedFiles) {
    const key = runtimeFilePathKey(file.path);
    if (key) savedByPathKey.set(key, file);
  }
  const files = [
    ...initialFiles.filter((file) => {
      const key = runtimeFilePathKey(file.path);
      return !removedFileIds.has(file.id) && !(key && savedByPathKey.has(key));
    }),
    ...savedFiles.filter((file) => !removedFileIds.has(file.id)),
  ].sort((left, right) => left.path.localeCompare(right.path));

  const clearMutationFeedback = () => {
    setMutationError(null);
    setNotice(null);
  };

  const error = uploadError ?? revealError ?? mutationError;

  const revealFile = (file: RuntimeFileMetadata) => {
    setRevealError(null);
    setUploadError(null);
    clearMutationFeedback();
    startReveal(async () => {
      try {
        const result = await revealDeploymentRuntimeFileAction({
          workspace,
          deploymentId,
          fileId: file.id,
        });
        if (result.content !== undefined && result.path !== undefined) {
          setDraft({
            fileId: file.id,
            path: result.path,
            content: result.content,
            source: 'revealed',
          });
          return;
        }
        setRevealError(actionErrorMessage(result.error, t) ?? t('runtimeFileRevealFailed'));
      } catch {
        setRevealError(t('runtimeFileRevealFailed'));
      }
    });
  };

  const startNewFile = () => {
    setDraft({ path: '', content: '', source: 'new' });
    setUploadError(null);
    setRevealError(null);
    clearMutationFeedback();
  };

  const pickUpload = () => uploadInputRef.current?.click();

  const readUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately, so selecting the same file after fixing it fires a
    // new change event.
    event.target.value = '';
    if (!file) return;

    setUploadError(null);
    setRevealError(null);
    clearMutationFeedback();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.includes(0)) {
        throw new Error('Selected files must be plain text; binary files are not supported.');
      }
      // File.text() silently substitutes invalid sequences. A fatal decoder
      // keeps the browser-side behavior aligned with the server text-only
      // validation and prevents accidentally uploading a binary file.
      // `ignoreBOM: true` retains a UTF-8 BOM if the user supplied one,
      // rather than silently changing the file while importing it.
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      setDraft({ path: file.name, content, source: 'upload' });
    } catch {
      setUploadError(t('invalidRuntimeTextUpload'));
    }
  };

  const saveFile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMutationError(null);
    setNotice(null);
    startSave(async () => {
      try {
        const result = await upsertDeploymentRuntimeFileAction({}, formData);
        if (result.error || !result.savedAt) {
          setMutationError(actionErrorMessage(result.error, t) ?? t('runtimeFileSaveFailed'));
          return;
        }
        const savedFile = result.file;
        if (savedFile) {
          const fileKey = runtimeFilePathKey(savedFile.path);
          setSavedFiles((current) => {
            const next = [
              ...current.filter((file) => (
                file.id !== savedFile.id
                && (!fileKey || runtimeFilePathKey(file.path) !== fileKey)
              )),
              savedFile,
            ];
            return next.sort((left, right) => left.path.localeCompare(right.path));
          });
        }
        setDraft(null);
        setUploadError(null);
        setRevealError(null);
        setNotice('saved');
      } catch {
        setMutationError(t('runtimeFileSaveFailed'));
      }
    });
  };

  const removeFile = (file: RuntimeFileMetadata) => {
    if (!window.confirm(t('removeRuntimeFileConfirm', { path: file.path }))) return;

    const formData = new FormData();
    formData.set('workspace', workspace);
    formData.set('deploymentId', deploymentId);
    formData.set('fileId', file.id);
    setDeletingFileId(file.id);
    setMutationError(null);
    setNotice(null);
    startDelete(async () => {
      try {
        const result = await deleteDeploymentRuntimeFileAction(formData);
        if (result.error || !result.savedAt) {
          setMutationError(removeActionErrorMessage(result.error, t) ?? t('runtimeFileRemoveFailed'));
          return;
        }
        setRemovedFileIds((current) => new Set([...current, file.id]));
        setSavedFiles((current) => current.filter((candidate) => candidate.id !== file.id));
        setDraft((current) => current?.fileId === file.id ? null : current);
        setNotice('removed');
      } catch {
        setMutationError(t('runtimeFileRemoveFailed'));
      } finally {
        setDeletingFileId(null);
      }
    });
  };

  const draftPathKey = draft ? runtimeFilePathKey(draft.path) : null;
  const draftFileId = draft?.fileId;
  const currentPathAlreadyExists = Boolean(
    draftPathKey && files.some((file) => runtimeFilePathKey(file.path) === draftPathKey && file.id !== draftFileId),
  );

  return (
    <section className="max-w-4xl rounded-lg border border-border" aria-labelledby="runtime-files-heading">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <h2 id="runtime-files-heading" className="text-sm font-semibold text-foreground">
              {t('runtimeFiles')}
            </h2>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {files.length}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('runtimeFilesDescription')}
          </p>
          {relativePathArgumentsWork ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('runtimeFilesRelativeArgumentHint')}
            </p>
          ) : null}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('runtimeFilesAbsolutePathHint')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={pickUpload}
            disabled={isSaving || isRevealing || isDeleting}
            className="ui-button-secondary ui-button-sm disabled:cursor-wait disabled:opacity-70"
          >
            <Upload className="size-3.5" />
            {t('uploadTextFile')}
          </button>
          <button
            type="button"
            onClick={startNewFile}
            disabled={isSaving || isRevealing || isDeleting}
            className="ui-button-primary ui-button-sm disabled:cursor-wait disabled:opacity-70"
          >
            <Plus className="size-3.5" />
            {t('addFile')}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            tabIndex={-1}
            aria-label={t('uploadTextFile')}
            disabled={isSaving || isRevealing || isDeleting}
            onChange={readUpload}
            className="sr-only"
          />
        </div>
      </header>

      <div className="divide-y divide-border">
        {files.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t('noRuntimeFiles')}
          </p>
        ) : (
          files.map((file) => (
            <div key={file.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <code className="block break-all font-mono text-xs text-foreground">{file.path}</code>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                  <span aria-hidden="true"> · </span>
                  <time dateTime={file.updatedAt}>{t('runtimeFileUpdated', { value: formatUpdatedAt(file.updatedAt) })}</time>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => revealFile(file)}
                  disabled={isRevealing || isSaving || isDeleting}
                  aria-busy={isRevealing}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                >
                  {isRevealing ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
                  {isRevealing ? t('revealing') : t('revealAndEdit')}
                </button>
                <button
                  type="button"
                  onClick={() => removeFile(file)}
                  disabled={isSaving || isRevealing || isDeleting}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-600 disabled:cursor-wait disabled:opacity-70 dark:hover:text-red-400"
                >
                  {isDeleting && deletingFileId === file.id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Trash2 className="size-3.5" />}
                  {isDeleting && deletingFileId === file.id ? t('removing') : t('remove')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {draft ? (
        <form onSubmit={saveFile} className="border-t border-border bg-muted/20 px-4 py-4">
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="deploymentId" value={deploymentId} />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {draft.source === 'revealed' ? t('editRuntimeFile') : t('addRuntimeFile')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {draft.source === 'revealed'
                  ? t('revealedRuntimeFileHelp')
                  : t('newRuntimeFileHelp')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setUploadError(null);
                setRevealError(null);
                clearMutationFeedback();
              }}
              disabled={isSaving || isDeleting}
              aria-label={t('closeRuntimeFileEditor')}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-70"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {draft.source === 'revealed' ? (
              <>
                <input type="hidden" name="path" value={draft.path} />
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('filePath')}</p>
                  <code className="mt-1 block break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
                    {draft.path}
                  </code>
                </div>
              </>
            ) : (
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                {t('filePath')}
                <input
                  name="path"
                  value={draft.path}
                  onChange={(event) => setDraft((current) => current && {
                    ...current,
                    path: event.target.value,
                  })}
                  required
                  disabled={isSaving || isDeleting}
                  placeholder="ssh-config.json"
                  spellCheck={false}
                  className="ui-input h-9 w-full font-mono text-xs"
                />
              </label>
            )}

            {currentPathAlreadyExists ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                {t('runtimeFileReplaceWarning', { path: draft.path.trim() })}
              </p>
            ) : null}

            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              {t('textContent')}
              <textarea
                name="content"
                value={draft.content}
                onChange={(event) => setDraft((current) => current && {
                  ...current,
                  content: event.target.value,
                })}
                disabled={isSaving || isDeleting}
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'runtime-file-error' : undefined}
                className="min-h-64 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none focus:ring-2 focus:ring-ring disabled:cursor-wait disabled:opacity-70"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-h-5" aria-live="polite">
              {error ? (
                <p id="runtime-file-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {error}
                </p>
              ) : notice ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
                  {notice === 'saved' ? t('runtimeFileSaved') : t('runtimeFileRemoved')}
                </p>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={isSaving || isDeleting || !draft.path.trim()}
              className="ui-button-primary h-9 disabled:cursor-wait disabled:opacity-70"
            >
              {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {isSaving ? t('savingAndRestarting') : t('saveAndRestart')}
            </button>
          </div>
        </form>
      ) : (
        <div className="min-h-5 px-4 py-3" aria-live="polite">
          {error ? (
            <p id="runtime-file-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : notice ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
              {notice === 'saved' ? t('runtimeFileSaved') : t('runtimeFileRemoved')}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
