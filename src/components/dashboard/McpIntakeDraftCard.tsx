"use client";

import { AlertTriangle, Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogField } from "@/components/dashboard/dialog";
import { McpHttpConsent } from "@/components/dashboard/McpHttpConsent";
import { McpNetworkModeControl } from "@/components/dashboard/McpNetworkModeControl";
import {
  type RuntimeFileDraft,
  RuntimeFileDraftsInput,
} from "@/components/dashboard/RuntimeFileDraftsInput";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import type {
  McpIntakeCreateErrorCode,
  McpIntakeDraft,
  McpIntakeErrorCode,
  McpIntakeField,
  McpIntakeFile,
  McpIntakeIssue,
} from "@/lib/workspace/mcp-intake-types";

export type DraftFormState = {
  selected: boolean;
  name: string;
  values: Record<string, string>;
  network: "isolated" | "none";
  runtimeFiles: RuntimeFileDraft[];
  allowUnsafeHttp: boolean;
  authMode: "oauth" | "token";
};

export type IntakeErrorNotice = {
  code: McpIntakeErrorCode | McpIntakeCreateErrorCode;
  issue?: McpIntakeIssue;
  detail?: string;
};

export function useIntakeErrorFormatter() {
  const t = useTranslations("console.mcp");
  return (notice: IntakeErrorNotice) => {
    if (notice.issue)
      return t(`intake.issues.${notice.issue.code}`, {
        value: notice.issue.value ?? "",
      });
    const base = t(`intake.errors.${notice.code}`);
    return notice.detail ? `${base} (${notice.detail})` : base;
  };
}

/** Bind-mounted files from the original launch that still have no content. */
export function missingDraftFiles(
  draft: McpIntakeDraft,
  files: RuntimeFileDraft[],
): McpIntakeFile[] {
  return (draft.files ?? []).filter(
    (required) =>
      !files.some(
        (file) =>
          file.content.length > 0 &&
          (file.path === required.path ||
            file.path.startsWith(`${required.path}/`)),
      ),
  );
}

export function createDraftFormState(draft: McpIntakeDraft): DraftFormState {
  const values: Record<string, string> = {};
  for (const field of draft.fields) {
    values[field.key] = field.default ?? "";
  }
  const authMode: "oauth" | "token" =
    draft.auth.type === "oauth" &&
    (draft.auth.client !== "missing" || draft.fields.length === 0)
      ? "oauth"
      : "token";
  return {
    selected: true,
    name: draft.name,
    values,
    network: draft.network ?? "isolated",
    runtimeFiles: (draft.files ?? []).map((file) => ({
      path: file.path,
      content: "",
    })),
    allowUnsafeHttp: false,
    authMode,
  };
}

export function intakeFieldControlId(
  dialogId: string,
  draftId: string,
  fieldKey: string,
): string {
  return `${dialogId}-field-${draftId}-${fieldKey}`;
}

function isSafeHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function DraftFieldRow({
  controlId,
  field,
  value,
  disabled,
  onChange,
}: {
  controlId: string;
  field: McpIntakeField;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const t = useTranslations("console.mcp");
  const [revealed, setRevealed] = useState(false);
  const descriptionId = field.description ? `${controlId}-desc` : undefined;
  const helpHref = isSafeHttpsUrl(field.helpUrl) ? field.helpUrl : null;
  const displayLabel =
    field.label.trim().toLowerCase() === "authorization"
      ? t("intake.accessToken")
      : field.label;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          htmlFor={controlId}
          className="text-sm font-medium text-foreground"
        >
          {displayLabel}
        </label>
        {helpHref ? (
          <a
            href={helpHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("intake.createCredential")}
          </a>
        ) : null}
      </div>

      {field.choices && field.choices.length > 0 ? (
        <FormSelect
          id={controlId}
          label={displayLabel}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          options={field.choices.map((choice) => ({
            value: choice,
            label: choice,
          }))}
        />
      ) : field.secret ? (
        <Input
          id={controlId}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={onChange}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={descriptionId}
          rightIcon={
            <button
              type="button"
              disabled={disabled}
              onClick={() => setRevealed((current) => !current)}
              aria-label={
                revealed ? t("intake.hideSecret") : t("intake.showSecret")
              }
              className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {revealed ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          }
        />
      ) : (
        <Input
          id={controlId}
          type="text"
          value={value}
          onChange={onChange}
          disabled={disabled}
          spellCheck={false}
          aria-describedby={descriptionId}
        />
      )}

      {field.description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {field.description}
        </p>
      ) : null}
    </div>
  );
}

export function McpIntakeDraftCard({
  dialogId,
  draft,
  state,
  onChange,
  multi,
  multiSelected = false,
  allowHttp,
  disabled,
  nameInvalid = false,
  error,
  jsonEditPending = false,
  jsonEditError = null,
  onApplyEditedJson,
}: {
  dialogId: string;
  draft: McpIntakeDraft;
  state: DraftFormState;
  onChange: (patch: Partial<DraftFormState>) => void;
  multi: boolean;
  multiSelected?: boolean;
  allowHttp: boolean;
  disabled: boolean;
  nameInvalid?: boolean;
  error?: IntakeErrorNotice | null;
  jsonEditPending?: boolean;
  jsonEditError?: IntakeErrorNotice | null;
  onApplyEditedJson?: (editedJson: string) => void;
}) {
  const t = useTranslations("console.mcp");
  const config = useMemo(
    () => JSON.stringify(JSON.parse(draft.config), null, 2),
    [draft.config],
  );
  const [jsonText, setJsonText] = useState(config);

  useEffect(() => {
    setJsonText(config);
  }, [config]);

  const nameId = `${dialogId}-name-${draft.id}`;
  const jsonId = `${dialogId}-json-${draft.id}`;
  const isStdio = draft.kind === "stdio";
  const isDocker = isStdio && draft.summary.trimStart().startsWith("docker ");
  const oauthClient = draft.auth.type === "oauth" ? draft.auth.client : null;
  const isOAuth = oauthClient !== null;
  const oauthClientAvailable = isOAuth && oauthClient !== "missing";
  const oauthClientMissing = oauthClient === "missing";
  const usingOAuth = oauthClientAvailable && state.authMode === "oauth";
  const hasTokenFields = draft.fields.length > 0;
  const showFields = hasTokenFields && !usingOAuth;

  const formatError = useIntakeErrorFormatter();
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  const requiredFiles = draft.files ?? [];
  const missingFiles = missingDraftFiles(draft, state.runtimeFiles);
  const jsonEditor =
    !multi && onApplyEditedJson ? (
      <div className="flex min-w-0 flex-col gap-2">
        <label
          htmlFor={jsonId}
          className="block text-sm font-medium text-foreground"
        >
          {t("intake.editJson")}
        </label>
        <textarea
          id={jsonId}
          value={jsonText}
          disabled={disabled || jsonEditPending}
          spellCheck={false}
          aria-invalid={Boolean(jsonEditError) || undefined}
          onChange={(event) => setJsonText(event.target.value)}
          className="min-h-56 w-full flex-1 resize-y rounded-lg border border-border bg-muted/35 p-3 font-mono text-xs leading-5 text-foreground outline-none focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
        />
        {jsonEditError ? (
          <p role="alert" className="text-xs text-destructive">
            {formatError(jsonEditError)}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              disabled ||
              jsonEditPending ||
              !jsonText.trim() ||
              jsonText === config
            }
            onClick={() => onApplyEditedJson(jsonText)}
          >
            {jsonEditPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("intake.applyingJson")}
              </>
            ) : (
              t("intake.applyJson")
            )}
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <section
      className={`rounded-xl border border-border bg-card/50 p-4 transition-opacity ${
        multi && !state.selected ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        {multi ? (
          <input
            type="checkbox"
            checked={state.selected}
            disabled={disabled}
            aria-label={t("intake.selectServer", {
              name: state.name.trim() || draft.name,
            })}
            onChange={(event) => onChange({ selected: event.target.checked })}
            className="mt-1 size-4 shrink-0"
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AnimatedBadge status="neutral" size="sm" showIcon={false}>
              {draft.kind === "remote"
                ? t("intake.kindRemote")
                : t("intake.kindStdio")}
            </AnimatedBadge>
            <AnimatedBadge status="neutral" size="sm" showIcon={false}>
              {t(`intake.origin.${draft.origin}`)}
            </AnimatedBadge>
          </div>
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={draft.summary}
          >
            {draft.summary}
          </p>
        </div>
      </div>

      {!multi || state.selected ? (
        <div className="mt-4 space-y-5">
          <div
            className={jsonEditor ? "grid gap-5 lg:grid-cols-2" : "space-y-4"}
          >
            <div className="min-w-0 space-y-4">
              {draft.reachability === "unreachable" ? (
                <p
                  role="status"
                  className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                >
                  <AlertTriangle
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t("intake.unreachableWarning")}</span>
                </p>
              ) : null}

              {draft.ignoredFields && draft.ignoredFields.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs">
                  <span className="font-medium text-muted-foreground">
                    {t("config.ignoredFieldsLabel")}:
                  </span>
                  {draft.ignoredFields.map((field) => (
                    <code
                      key={field}
                      className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-foreground"
                    >
                      {field}
                    </code>
                  ))}
                </div>
              ) : null}
              <DialogField label={t("serverName")} htmlFor={nameId}>
                <Input
                  id={nameId}
                  value={state.name}
                  disabled={disabled}
                  required={state.selected}
                  error={nameInvalid ? t("intake.nameRequired") : undefined}
                  onChange={(name) => onChange({ name })}
                />
              </DialogField>

              {oauthClientMissing ? (
                <p className="text-xs text-muted-foreground">
                  {t("intake.oauthClientMissingNote")}
                </p>
              ) : null}

              {usingOAuth && multiSelected ? (
                <p className="text-xs text-muted-foreground">
                  {t("intake.oauthSignInAfterAdd")}
                </p>
              ) : null}

              {showFields ? (
                <div className="space-y-3">
                  {draft.fields.map((field) => (
                    <DraftFieldRow
                      key={field.key}
                      controlId={intakeFieldControlId(
                        dialogId,
                        draft.id,
                        field.key,
                      )}
                      field={field}
                      value={state.values[field.key] ?? ""}
                      disabled={disabled}
                      onChange={(nextValue) =>
                        onChange({
                          values: { ...state.values, [field.key]: nextValue },
                        })
                      }
                    />
                  ))}
                </div>
              ) : null}

              {oauthClientAvailable && hasTokenFields ? (
                <div>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      onChange({ authMode: usingOAuth ? "token" : "oauth" })
                    }
                    className="text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    {usingOAuth
                      ? t("intake.useTokenInstead")
                      : t("intake.useOAuthInstead")}
                  </button>
                </div>
              ) : null}

              {draft.insecureHttp && !allowHttp ? (
                <McpHttpConsent
                  required={state.selected}
                  onChange={(checked) => onChange({ allowUnsafeHttp: checked })}
                />
              ) : null}

              {isStdio ? (
                <McpNetworkModeControl
                  value={state.network}
                  disabled={disabled}
                  warnAboutPackageInstall={!isDocker}
                  onChange={(network) => onChange({ network })}
                />
              ) : null}
            </div>

            {jsonEditor}
          </div>

          {isStdio ? (
            <div className="space-y-2">
              {requiredFiles.length ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("intake.mountedFilesHint")}
                  </p>
                  <ul className="space-y-1">
                    {requiredFiles.map((file) => {
                      const missing = missingFiles.includes(file);
                      return (
                        <li
                          key={file.path}
                          className="flex items-center gap-1.5 font-mono text-xs text-foreground"
                        >
                          {missing ? (
                            <AlertTriangle
                              className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                              aria-label={t("intake.fileMissing")}
                            />
                          ) : (
                            <Check
                              className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate" title={file.target}>
                            {file.target}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
              <RuntimeFileDraftsInput
                value={state.runtimeFiles}
                disabled={disabled}
                relativePathArgumentsWork={!isDocker}
                onChange={(runtimeFiles) => onChange({ runtimeFiles })}
              />
            </div>
          ) : null}

          {error ? (
            <p ref={errorRef} role="alert" className="text-xs text-destructive">
              {formatError(error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
