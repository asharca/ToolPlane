"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  FileCode2,
  KeyRound,
  Loader2,
  Lock,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  previewMcpConfigAction,
  saveMcpConfigAction,
  setMcpVariablesAction,
  updateMcpDependenciesAction,
} from "@/lib/workspace/mcp-config-actions";
import type {
  McpConfigFailure,
  McpConfigPreview,
  McpConfigVariable,
  McpConfigView,
} from "@/lib/workspace/mcp-config-types";
import { notify } from "./Toaster";

type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatMcpConfigError(
  failure: McpConfigFailure,
  t: TranslateFn,
): string {
  if (failure.issue) {
    return t(`intake.issues.${failure.issue.code}`, {
      value: failure.issue.value ?? "",
    });
  }
  return t(`config.errors.${failure.error}`);
}

type PreviewSuccess = Extract<McpConfigPreview, { ok: true }>;

export function McpConfigDocumentEditor({
  workspace,
  deploymentId,
  view,
}: {
  workspace: string;
  deploymentId: string;
  view: McpConfigView;
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const [document, setDocument] = useState(view.document);
  const [preview, setPreview] = useState<PreviewSuccess | null>(null);
  const [missingValues, setMissingValues] = useState<Record<string, string>>(
    {},
  );
  const [revealedMissing, setRevealedMissing] = useState<
    Record<string, boolean>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [isPreviewPending, startPreview] = useTransition();
  const [isSavePending, startSave] = useTransition();

  const activeRevision = useMemo(
    () =>
      view.revisions.find((rev) => rev.id === view.activeRevisionId) ??
      view.revisions.find((rev) => rev.active) ??
      null,
    [view.activeRevisionId, view.revisions],
  );

  const dirty = document !== view.document;
  const busy = isPreviewPending || isSavePending;
  const previewChanges = useMemo(() => {
    if (!preview) return [];
    const seen = new Map<string, number>();
    return preview.changes.map((change) => {
      const signature = `${change.type}:${change.line}`;
      const occurrence = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, occurrence);
      return { ...change, key: `${signature}#${occurrence}` };
    });
  }, [preview]);

  function handlePreview() {
    if (!view.canManage || busy) return;
    setError(null);
    startPreview(async () => {
      try {
        const result = await previewMcpConfigAction({
          workspace,
          deploymentId,
          document,
        });
        if (!result.ok) {
          setPreview(null);
          setError(formatMcpConfigError(result, t));
          return;
        }
        setPreview(result);
        setMissingValues({});
        setRevealedMissing({});
      } catch {
        setPreview(null);
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  function handleConfirmSave() {
    if (!view.canManage || !preview || busy) return;
    setError(null);
    startSave(async () => {
      try {
        const values: Record<string, string> = {};
        for (const [key, val] of Object.entries(missingValues)) {
          if (val.trim().length > 0) {
            values[key] = val;
          }
        }
        const result = await saveMcpConfigAction({
          workspace,
          deploymentId,
          document,
          values: Object.keys(values).length > 0 ? values : undefined,
        });
        if (!result.ok) {
          setError(formatMcpConfigError(result, t));
          return;
        }
        setDocument(preview.document);
        setPreview(null);
        setMissingValues({});
        setRevealedMissing({});
        notify(
          result.status === "setup_required"
            ? t("config.configSavedSetupRequired", {
                revision: result.revision,
              })
            : t("config.configSaved", { revision: result.revision }),
        );
        router.refresh();
      } catch {
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  function handleReset() {
    setDocument(view.document);
    setPreview(null);
    setMissingValues({});
    setRevealedMissing({});
    setError(null);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FileCode2 className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("config.documentTitle")}
            </h2>
            <AnimatedBadge status="neutral" size="sm" showIcon={false}>
              {t(`config.format.${view.format}`)}
            </AnimatedBadge>
            {activeRevision ? (
              <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                {t("config.activeRevisionBadge", {
                  revision: activeRevision.revision,
                })}
              </AnimatedBadge>
            ) : null}
            {!view.canManage ? (
              <AnimatedBadge status="warning" size="sm" showIcon={false}>
                {t("config.readOnlyBadge")}
              </AnimatedBadge>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("config.documentDescription")}
          </p>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        {!view.canManage ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("config.readOnlyNotice")}
          </p>
        ) : null}

        {view.kind === "stdio" && !view.runtime.canUseArbitraryCommands ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("config.arbitraryCommandHint")}
          </p>
        ) : null}

        {view.ignoredFields.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs">
            <span className="font-medium text-muted-foreground">
              {t("config.ignoredFieldsLabel")}:
            </span>
            {view.ignoredFields.map((field) => (
              <code
                key={field}
                className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-foreground"
              >
                {field}
              </code>
            ))}
          </div>
        ) : null}

        <div>
          <textarea
            id="mcp-config-document"
            name="document"
            value={document}
            readOnly={!view.canManage}
            disabled={busy}
            onChange={(event) => {
              setDocument(event.target.value);
              setPreview(null);
              setError(null);
            }}
            spellCheck={false}
            aria-label={t("config.documentTitle")}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "mcp-config-document-error" : undefined}
            className="h-[min(26rem,52dvh)] min-h-44 max-h-[65dvh] w-full resize-y rounded-lg border border-border bg-muted/25 p-3.5 font-mono text-xs leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:cursor-default read-only:bg-muted/15"
          />
        </div>

        {error ? (
          <p
            id="mcp-config-document-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {view.canManage ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty || preview ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={handleReset}
              >
                <RotateCcw className="size-3.5" />
                {t("config.resetButton")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={preview ? "secondary" : "primary"}
              size="sm"
              disabled={busy || document.trim().length === 0}
              onClick={handlePreview}
            >
              {isPreviewPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Eye className="size-3.5" />
              )}
              {isPreviewPending
                ? t("config.previewing")
                : t("config.previewButton")}
            </Button>
          </div>
        ) : null}

        {preview ? (
          <section
            aria-label={t("config.previewTitle")}
            className="space-y-4 rounded-xl border border-border bg-muted/20 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                {t("config.previewTitle")}
              </h3>
              {preview.restartRequired ? (
                <span className="text-xs text-muted-foreground">
                  {t("config.restartRequiredNotice")}
                </span>
              ) : null}
            </div>

            {preview.extractedSecrets.length > 0 ? (
              <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Lock className="size-3.5 text-amber-500" />
                  <span>{t("config.extractedSecretsLabel")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preview.extractedSecrets.map((key) => (
                    <code
                      key={key}
                      className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-xs text-foreground"
                    >
                      {key}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {preview.ignoredFields.length > 0 ? (
              <div className="space-y-1.5 rounded-lg border border-border bg-background/60 px-3 py-2.5">
                <span className="block text-xs font-medium text-muted-foreground">
                  {t("config.ignoredFieldsLabel")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {preview.ignoredFields.map((field) => (
                    <code
                      key={field}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                    >
                      {field}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {preview.missingVariables.length > 0 ? (
              <div className="space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-medium text-foreground">
                      {t("config.missingVariablesLabel")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("config.missingVariablesHint")}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  {preview.missingVariables.map((key) => {
                    const isVisible = Boolean(revealedMissing[key]);
                    return (
                      <div
                        key={key}
                        className="grid gap-2 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)] sm:items-center"
                      >
                        <label
                          htmlFor={`preview-missing-${key}`}
                          className="truncate font-mono text-xs font-medium text-foreground"
                        >
                          {key}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            id={`preview-missing-${key}`}
                            type={isVisible ? "text" : "password"}
                            value={missingValues[key] ?? ""}
                            onChange={(val) =>
                              setMissingValues((prev) => ({
                                ...prev,
                                [key]: val,
                              }))
                            }
                            placeholder={t("config.variableValuePlaceholder")}
                            disabled={busy}
                            className="min-w-0 flex-1 font-mono text-xs"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-label={
                              isVisible
                                ? t("config.hideTypedValue")
                                : t("config.showTypedValue")
                            }
                            onClick={() =>
                              setRevealedMissing((prev) => ({
                                ...prev,
                                [key]: !prev[key],
                              }))
                            }
                          >
                            {isVisible ? (
                              <EyeOff className="size-3.5" />
                            ) : (
                              <Eye className="size-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">
                {t("config.diffLabel")}
              </span>
              {previewChanges.length === 0 ? (
                <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                  {t("config.noDiffChanges")}
                </p>
              ) : (
                <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5">
                  {previewChanges.map((change) => (
                    <div
                      key={change.key}
                      className={
                        change.type === "added"
                          ? "bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300"
                          : "bg-destructive/10 px-1.5 text-destructive"
                      }
                    >
                      <span className="mr-2 select-none">
                        {change.type === "added" ? "+" : "-"}
                      </span>
                      <span>{change.line}</span>
                    </div>
                  ))}
                </pre>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                {t("config.cancelPreviewButton")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={handleConfirmSave}
              >
                {isSavePending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {isSavePending
                  ? t("config.savingConfig")
                  : t("config.confirmSaveButton")}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

type VariableRow = {
  id: number;
  key: string;
  secret: boolean;
  set: boolean;
  required: boolean;
  isNew: boolean;
  value: string;
  visible: boolean;
  removed: boolean;
};

function createVariableRows(variables: McpConfigVariable[]): VariableRow[] {
  return variables.map((v, index) => ({
    id: index,
    key: v.key,
    secret: v.secret,
    set: v.set,
    required: v.required,
    isNew: false,
    value: "",
    visible: false,
    removed: false,
  }));
}

export function McpConfigVariablesPanel({
  workspace,
  deploymentId,
  variables,
  canManage,
}: {
  workspace: string;
  deploymentId: string;
  variables: McpConfigVariable[];
  canManage: boolean;
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const fieldId = useId();
  const [rows, setRows] = useState<VariableRow[]>(() =>
    createVariableRows(variables),
  );
  const nextId = useRef(variables.length);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const changes = useMemo(() => {
    const values: Record<string, string> = {};
    const remove: string[] = [];
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.removed) {
        if (!row.isNew && row.set) remove.push(key);
        continue;
      }
      if (row.value.length > 0) {
        values[key] = row.value;
      }
    }
    return { values, remove };
  }, [rows]);

  const invalidKey = rows.some(
    (row) =>
      !row.removed &&
      Boolean(row.key.trim()) &&
      !ENV_KEY_PATTERN.test(row.key.trim()),
  );
  const activeKeys = rows
    .filter((row) => !row.removed && row.key.trim().length > 0)
    .map((row) => row.key.trim());
  const duplicateKey = new Set(activeKeys).size !== activeKeys.length;
  const incompleteNew = rows.some(
    (row) =>
      row.isNew &&
      !row.removed &&
      Boolean(row.key.trim()) !== Boolean(row.value),
  );
  const hasMutations =
    Object.keys(changes.values).length > 0 || changes.remove.length > 0;
  const canSave =
    canManage &&
    hasMutations &&
    !invalidKey &&
    !duplicateKey &&
    !incompleteNew &&
    !isPending;

  function updateRow(id: number, patch: Partial<VariableRow>) {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    if (!canManage) return;
    setRows((current) => [
      ...current,
      {
        id: nextId.current++,
        key: "",
        secret: true,
        set: false,
        required: false,
        isNew: true,
        value: "",
        visible: false,
        removed: false,
      },
    ]);
  }

  function removeRow(row: VariableRow) {
    if (!canManage) return;
    if (row.isNew) {
      setRows((current) => current.filter((item) => item.id !== row.id));
      return;
    }
    updateRow(row.id, { removed: true, value: "" });
  }

  function handleSaveVariables() {
    if (!canSave) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setMcpVariablesAction({
          workspace,
          deploymentId,
          values: changes.values,
          remove: changes.remove.length > 0 ? changes.remove : undefined,
        });
        if (!result.ok) {
          setError(formatMcpConfigError(result, t));
          return;
        }
        notify(t("config.variablesSaved"));
        router.refresh();
      } catch {
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  return (
    <section
      id="variables"
      className="scroll-mt-6 overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("config.variablesTitle")}
            </h2>
            <AnimatedBadge status="neutral" size="sm" showIcon={false}>
              {
                rows.filter((r) => !r.removed && (r.set || Boolean(r.value)))
                  .length
              }
            </AnimatedBadge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("config.variablesDescription")}
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={addRow}
          >
            <Plus className="size-3.5" />
            {t("config.addVariable")}
          </Button>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          {t("config.noVariables")}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => {
            const keyTrimmed = row.key.trim();
            const keyInvalid =
              Boolean(keyTrimmed) && !ENV_KEY_PATTERN.test(keyTrimmed);
            return (
              <div
                key={row.id}
                className={`space-y-2.5 px-5 py-3.5 ${
                  row.removed ? "bg-muted/25 opacity-75" : ""
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {row.isNew ? (
                      <Input
                        id={`${fieldId}-${row.id}-key`}
                        value={row.key}
                        onChange={(val) => updateRow(row.id, { key: val })}
                        placeholder={t("config.variableKeyPlaceholder")}
                        disabled={!canManage || isPending || row.removed}
                        aria-label={t("variableName")}
                        error={keyInvalid || undefined}
                        className="h-8 w-44 font-mono text-xs"
                      />
                    ) : (
                      <label
                        htmlFor={`${fieldId}-${row.id}-value`}
                        className="font-mono text-xs font-semibold text-foreground"
                      >
                        {row.key}
                      </label>
                    )}

                    {row.required && !row.set && !row.value ? (
                      <AnimatedBadge
                        status="warning"
                        size="sm"
                        showIcon={false}
                      >
                        {t("config.variableRequiredMissing")}
                      </AnimatedBadge>
                    ) : row.required ? (
                      <AnimatedBadge
                        status="neutral"
                        size="sm"
                        showIcon={false}
                      >
                        {t("required")}
                      </AnimatedBadge>
                    ) : null}

                    {row.removed ? (
                      <AnimatedBadge status="danger" size="sm" showIcon={false}>
                        {t("config.markedForRemoval")}
                      </AnimatedBadge>
                    ) : row.set ? (
                      <AnimatedBadge
                        status="success"
                        size="sm"
                        showIcon={false}
                      >
                        {t("config.variableConfigured")}
                      </AnimatedBadge>
                    ) : !row.required ? (
                      <AnimatedBadge
                        status="neutral"
                        size="sm"
                        showIcon={false}
                      >
                        {t("config.variableNotSet")}
                      </AnimatedBadge>
                    ) : null}
                  </div>

                  {canManage ? (
                    row.removed ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={isPending}
                        onClick={() => updateRow(row.id, { removed: false })}
                      >
                        <Undo2 className="size-3.5" />
                        {t("config.undoRemoveVariable")}
                      </Button>
                    ) : row.isNew || row.set ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={isPending}
                        aria-label={t("config.removeVariable")}
                        onClick={() => removeRow(row)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null
                  ) : null}
                </div>

                {canManage && !row.removed ? (
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${fieldId}-${row.id}-value`}
                      type={row.visible ? "text" : "password"}
                      value={row.value}
                      onChange={(val) => updateRow(row.id, { value: val })}
                      placeholder={
                        row.set
                          ? t("config.variableReplacePlaceholder")
                          : t("config.variableValuePlaceholder")
                      }
                      disabled={isPending}
                      className="min-w-0 flex-1 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={isPending}
                      aria-label={
                        row.visible
                          ? t("config.hideTypedValue")
                          : t("config.showTypedValue")
                      }
                      onClick={() =>
                        updateRow(row.id, { visible: !row.visible })
                      }
                    >
                      {row.visible ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {canManage ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <div className="min-h-5">
            {invalidKey ? (
              <p role="alert" className="text-xs text-destructive">
                {t("validEnvironmentVariableName")}
              </p>
            ) : duplicateKey ? (
              <p role="alert" className="text-xs text-destructive">
                {t("duplicateEnvironmentVariable")}
              </p>
            ) : incompleteNew ? (
              <p role="alert" className="text-xs text-destructive">
                {t("enterValueForNewVariable")}
              </p>
            ) : error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("variablesSaveHint")}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={handleSaveVariables}
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {isPending
              ? t("config.savingVariables")
              : t("config.saveVariablesButton")}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

export function McpConfigResolvedPanel({
  workspace,
  deploymentId,
  resolved,
  canManage,
}: {
  workspace: string;
  deploymentId: string;
  resolved: Array<{ label: string; value: string }>;
  canManage: boolean;
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleUpdateDependencies() {
    if (!canManage || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await updateMcpDependenciesAction({
          workspace,
          deploymentId,
        });
        if (!result.ok) {
          setError(formatMcpConfigError(result, t));
          return;
        }
        notify(
          t("config.dependenciesUpdated", {
            revision: result.revision,
          }),
        );
        router.refresh();
      } catch {
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PackageCheck className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("config.resolvedTitle")}
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("config.resolvedDescription")}
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={handleUpdateDependencies}
          >
            <RefreshCw
              className={`size-3.5 ${isPending ? "animate-spin" : ""}`}
            />
            {isPending
              ? t("config.updatingDependencies")
              : t("config.updateDependenciesButton")}
          </Button>
        ) : null}
      </header>

      {error ? (
        <div className="border-b border-border px-5 py-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        </div>
      ) : null}

      {resolved.length === 0 ? (
        <div className="px-5 py-5 text-xs text-muted-foreground">
          {t("config.noResolvedLocks")}
        </div>
      ) : (
        <dl className="divide-y divide-border">
          {resolved.map((item) => (
            <div
              key={`${item.label}:${item.value}`}
              className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3"
            >
              <dt className="text-xs font-medium text-muted-foreground">
                {item.label}
              </dt>
              <dd className="min-w-0 break-all font-mono text-xs text-foreground">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
