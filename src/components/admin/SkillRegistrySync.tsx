"use client";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";

import { useActionState, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, GitBranch, RotateCcw } from "lucide-react";
import {
  syncSkillRegistryAction,
  type SkillRegistrySyncActionState,
} from "@/lib/admin/market-actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminPanel } from "@/components/admin/AdminUI";
import { FilePathTree } from "@/components/dashboard/FilePathTree";

type Source = {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
  slugPrefix: string;
};

export function SkillRegistrySync({ source }: { source: Source }) {
  const t = useTranslations("admin");
  const fieldId = useId();
  const ops = useTranslations("adminOps");
  const [state, formAction, pending] = useActionState<
    SkillRegistrySyncActionState,
    FormData
  >(syncSkillRegistryAction, {});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const failure =
    state.failures?.find((entry) => entry.path === selectedPath) ??
    state.failures?.[0];

  return (
    <AdminPanel
      title={t("syncTpSkills")}
      description={t("syncTpSkillsDescription")}
    >
      <form action={formAction} className="space-y-4">
        <fieldset
          disabled={pending}
          className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-6"
        >
          <label
            htmlFor={`${fieldId}-owner`}
            className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2"
          >
            <span>{t("owner")}</span>
            <Input
              id={`${fieldId}-owner`}
              name="owner"
              defaultValue={source.owner}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label
            htmlFor={`${fieldId}-repo`}
            className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2"
          >
            <span>{t("repo")}</span>
            <Input
              id={`${fieldId}-repo`}
              name="repo"
              defaultValue={source.repo}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label
            htmlFor={`${fieldId}-ref`}
            className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2"
          >
            <span>{t("ref")}</span>
            <Input
              id={`${fieldId}-ref`}
              name="ref"
              defaultValue={source.ref}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label
            htmlFor={`${fieldId}-rootPath`}
            className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-3"
          >
            <span>{t("root")}</span>
            <Input
              id={`${fieldId}-rootPath`}
              name="rootPath"
              defaultValue={source.rootPath}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label
            htmlFor={`${fieldId}-slugPrefix`}
            className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-1"
          >
            <span>{t("prefix")}</span>
            <Input
              id={`${fieldId}-slugPrefix`}
              name="slugPrefix"
              defaultValue={source.slugPrefix}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <SubmitButton
            pendingLabel={t("syncing")}
            savedLabel={t("synced")}
            error={state.error && !state.ok}
            variant="primary"
            size="md"
            className="w-full self-end lg:col-span-2"
          >
            <GitBranch className="size-4" />
            {t("syncTpSkills")}
          </SubmitButton>
        </fieldset>
        {state.ok ? (
          <p
            className="flex items-start gap-2 text-sm text-accent-foreground"
            aria-live="polite"
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              {t("syncTpSkillsResult", {
                found: state.found ?? 0,
                created: state.created ?? 0,
                updated: state.updated ?? 0,
                failed: state.failed ?? 0,
              })}
            </span>
          </p>
        ) : null}
        {state.error ? (
          <p
            className="flex items-start gap-2 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}
        {state.failures?.length ? (
          <section className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">
                {ops("failedFiles")} ({state.failures.length})
              </h3>
              <Button
                type="submit"
                name="intent"
                value="retry"
                disabled={pending}
                variant="secondary"
                size="md"
              >
                <RotateCcw className="size-4" />
                {pending ? t("syncing") : ops("retryFailed")}
              </Button>
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {state.source?.owner}/{state.source?.repo} @ {state.source?.ref}
            </p>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="max-h-80 min-w-0 overflow-auto">
                <FilePathTree
                  files={state.failures.map((entry) => ({
                    path: entry.path,
                    value: entry.path,
                  }))}
                  ariaLabel={ops("failedFiles")}
                  value={failure?.path ?? null}
                  onSelect={setSelectedPath}
                  disabled={pending}
                />
              </div>
              {failure ? (
                <div className="min-w-0 p-2">
                  <code className="block break-all text-xs font-medium">
                    {failure.path}
                  </code>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">
                    {failure.error}
                  </p>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </form>
    </AdminPanel>
  );
}
