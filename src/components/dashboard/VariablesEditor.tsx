'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  KeyRound,
  Plus,
  Trash2,
  Undo2,
} from 'lucide-react';
import { setDeploymentEnvAction } from '@/lib/workspace/actions';
import { SubmitButton } from './SubmitButton';

type InitialVariable = {
  key: string;
  configured: boolean;
  required: boolean;
};

type Row = InitialVariable & {
  id: number;
  isNew: boolean;
  value: string;
  removed: boolean;
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rowsFromInitial(initial: InitialVariable[]): Row[] {
  return initial.map((row, index) => ({
    ...row,
    id: index,
    isNew: false,
    value: '',
    removed: false,
  }));
}

type VariablesEditorProps = {
  slug: string;
  deploymentId: string;
  initial: InitialVariable[];
};

export function VariablesEditor(props: VariablesEditorProps) {
  // A route revalidation after save supplies new metadata. Remounting the
  // editor only when that metadata changes keeps local edits intact otherwise
  // and avoids synchronously mirroring props into state.
  return <VariablesEditorForm key={JSON.stringify(props.initial)} {...props} />;
}

function VariablesEditorForm({
  slug,
  deploymentId,
  initial,
}: VariablesEditorProps) {
  // Metadata only — secret values never cross the server/client boundary.
  const t = useTranslations('console.mcp');
  const common = useTranslations('console.common');
  const [rows, setRows] = useState<Row[]>(() => rowsFromInitial(initial));
  const nextId = useRef(initial.length);

  const changes = useMemo(() => {
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.removed) {
        if (!row.isNew) remove.push(key);
        continue;
      }
      // An empty value on an existing configured row means "keep it". The
      // browser never receives that value, so clearing is always explicit.
      if (row.value) set[key] = row.value;
    }
    return { set, remove };
  }, [rows]);

  const invalidKey = rows.some((row) => Boolean(row.key.trim()) && !ENV_KEY.test(row.key.trim()));
  const keys = rows
    .filter((row) => !row.removed && row.key.trim())
    .map((row) => row.key.trim());
  const duplicateKey = new Set(keys).size !== keys.length;
  const incompleteNewVariable = rows.some((row) => (
    row.isNew
    && !row.removed
    && (Boolean(row.key.trim()) !== Boolean(row.value))
  ));
  const missingRequiredValue = rows.some((row) => (
    !row.isNew
    && !row.removed
    && row.required
    && !row.configured
    && !row.value
  ));
  const canSave = !invalidKey && !duplicateKey && !incompleteNewVariable && !missingRequiredValue;
  const configuredCount = rows.filter((row) => !row.removed && (row.configured || Boolean(row.value))).length;

  function updateRow(id: number, update: Partial<Row>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...update } : row));
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        id: nextId.current++,
        key: '',
        configured: false,
        required: false,
        isNew: true,
        value: '',
        removed: false,
      },
    ]);
  }

  function removeRow(row: Row) {
    if (row.isNew) {
      setRows((current) => current.filter((candidate) => candidate.id !== row.id));
      return;
    }
    updateRow(row.id, { removed: true, value: '' });
  }

  return (
    <form action={setDeploymentEnvAction} className="ui-panel max-w-5xl overflow-hidden">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="changes" value={JSON.stringify(changes)} />

      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">{t('variables')}</h2>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
              {t('configuredVariableCount', { count: configuredCount })}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t('environmentVariablesDescription')}
          </p>
        </div>
        <button type="button" onClick={addRow} className="ui-button-secondary ui-button-sm shrink-0">
          <Plus className="size-3.5" />
          {t('addVariable')}
        </button>
      </header>

      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <KeyRound className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">{t('noEnvironmentVariables')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('environmentVariablesDescription')}</p>
          <button type="button" onClick={addRow} className="ui-button-secondary ui-button-sm mt-4">
            <Plus className="size-3.5" />
            {t('addVariable')}
          </button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => {
            const key = row.key.trim();
            const rowInvalid = Boolean(key) && !ENV_KEY.test(key);
            const valueRequired = row.isNew && Boolean(key);
            return (
              <div key={row.id} className={`px-5 py-4 ${row.removed ? 'bg-muted/25' : ''}`}>
                <div className="grid gap-3 lg:grid-cols-[minmax(10rem,0.8fr)_minmax(16rem,1.2fr)_auto] lg:items-start">
                  <label className="min-w-0 space-y-1.5">
                    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      {t('variableName')}
                      {row.required ? (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                          {t('required')}
                        </span>
                      ) : null}
                    </span>
                    <input
                      value={row.key}
                      onChange={(event) => updateRow(row.id, { key: event.target.value })}
                      placeholder="API_KEY"
                      disabled={row.removed || !row.isNew}
                      required={row.isNew && Boolean(row.key.trim())}
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      title={t('validEnvironmentVariableName')}
                      aria-invalid={rowInvalid || undefined}
                      className="ui-input h-9 font-mono text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
                    />
                    {!row.isNew ? (
                      <p className="text-[11px] text-muted-foreground">{t('variableNameCannotBeChanged')}</p>
                    ) : null}
                  </label>

                  <label className="min-w-0 space-y-1.5">
                    <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                      {common('value')}
                      {!row.removed ? (
                        row.configured && !row.value ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="size-3.5" />
                            {t('configured')}
                          </span>
                        ) : row.value ? (
                          <span className="text-amber-700 dark:text-amber-300">{t('willReplaceOnSave')}</span>
                        ) : row.required ? (
                          <span className="text-amber-700 dark:text-amber-300">{t('valueRequired')}</span>
                        ) : null
                      ) : null}
                    </span>
                    {row.removed ? (
                      <p className="flex h-9 items-center rounded-md border border-dashed border-border bg-background px-3 text-xs text-muted-foreground">
                        {t('variableWillBeRemoved')}
                      </p>
                    ) : (
                      <input
                        type="password"
                        value={row.value}
                        onChange={(event) => updateRow(row.id, { value: event.target.value })}
                        autoComplete="new-password"
                        placeholder={row.configured ? t('replaceValue') : common('value')}
                        required={valueRequired}
                        disabled={row.removed}
                        className="ui-input h-9 font-mono text-xs"
                      />
                    )}
                    {row.configured && !row.removed ? (
                      <p className="text-[11px] text-muted-foreground">{t('existingValueNeverShown')}</p>
                    ) : null}
                  </label>

                  <div className="flex items-end gap-2 lg:justify-end lg:pb-0.5">
                    {row.removed ? (
                      <button
                        type="button"
                        onClick={() => updateRow(row.id, { removed: false })}
                        className="ui-button-secondary h-9 text-xs"
                      >
                        <Undo2 className="size-3.5" />
                        {t('undo')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => removeRow(row)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400"
                      >
                        <Trash2 className="size-3.5" />
                        {row.isNew ? t('discardVariable') : t('remove')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-4">
        <div className="text-xs text-muted-foreground" aria-live="polite">
          {invalidKey
            ? t('validEnvironmentVariableName')
            : duplicateKey
              ? t('duplicateEnvironmentVariable')
              : incompleteNewVariable
                ? t('enterValueForNewVariable')
                : missingRequiredValue
                  ? t('enterRequiredVariableValue')
                  : t('variablesSaveHint')}
        </div>
        <SubmitButton
          pendingLabel={t('savingVariables')}
          savedLabel={t('variablesSaved')}
          disabled={!canSave}
          className="ui-button-primary h-9"
        >
          {common('save')}
        </SubmitButton>
      </footer>
    </form>
  );
}
