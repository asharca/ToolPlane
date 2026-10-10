"use client";
import { FormSelect } from "@/components/ui/FormSelect";

import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Download, Plus, Save } from "lucide-react";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge } from "@/components/admin/AdminUI";

import {
  fetchServerSourceMetadataAction,
  type ServerSourceMetadataActionState,
} from "@/lib/admin/market-actions";
import type { AdminActionState } from "@/lib/admin/user-actions";

type Category = { id: string; name: string };
type Initial = {
  id?: string;
  slug?: string;
  name?: string;
  author?: string | null;
  description?: string | null;
  iconUrl?: string | null;
  stars?: number;
  isOfficial?: boolean;
  isFeatured?: boolean;
  categoryIds?: string[];
  readme?: string | null;
  source?: "github" | "npm" | "pypi";
  sourceRef?: string;
  sourceUrl?: string | null;
};

const LABEL_CLASS = "block space-y-1.5 text-sm font-medium text-foreground";

export function ServerForm({
  action,
  initial,
  categories,
  submitLabel,
  showSourceMetadata = true,
}: {
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  initial: Initial;
  categories: Category[];
  submitLabel: string;
  showSourceMetadata?: boolean;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(
    action,
    {},
  );
  const [sourceState, sourceAction, sourcePending] = useActionState<
    ServerSourceMetadataActionState,
    FormData
  >(fetchServerSourceMetadataAction, {});
  const t = useTranslations("admin");
  const fieldId = useId();
  const sel = new Set(initial.categoryIds ?? []);
  const SubmitIcon = initial.id ? Save : Plus;
  const metadata = sourceState.metadata;
  const source = metadata?.source ?? initial.source ?? "npm";
  const sourceRef = metadata?.ref ?? initial.sourceRef ?? "";
  const sourceUrl = metadata?.canonicalSourceUrl ?? initial.sourceUrl ?? "";
  const metadataKey = metadata
    ? `${metadata.canonicalSourceUrl}:${metadata.name}:${metadata.readme?.length ?? 0}`
    : "initial";
  const suggestedSlug =
    metadata?.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ?? "";

  return (
    <form action={formAction} className="max-w-3xl space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      {showSourceMetadata ? (
        <fieldset className="rounded-md bg-muted/35 p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">
            {t("fetchSourceMetadata")}
          </legend>
          <div className="mt-2 grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <div className={LABEL_CLASS}>
              <span>{t("metadataSource")}</span>
              <FormSelect
                name="sourceMetadataSource"
                defaultValue={source}
                label={t("metadataSource")}
                options={[
                  { value: "npm", label: t("npm") },
                  { value: "pypi", label: t("pypi") },
                  { value: "github", label: t("github") },
                ]}
              />
            </div>
            <label
              htmlFor={`${fieldId}-sourceMetadataRef`}
              className={LABEL_CLASS}
            >
              <span>{t("packageOrGithubRepository")}</span>
              <Input
                id={`${fieldId}-sourceMetadataRef`}
                name="sourceMetadataRef"
                defaultValue={sourceRef}
                placeholder="@modelcontextprotocol/server-memory"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
            <label
              htmlFor={`${fieldId}-sourceUrl`}
              className={`${LABEL_CLASS} min-w-0 flex-1`}
            >
              <span>{t("sourceUrl")}</span>
              <Input
                id={`${fieldId}-sourceUrl`}
                value={sourceUrl}
                readOnly
                className="truncate"
              />
            </label>
            <input
              type="hidden"
              name="sourceMetadataCanonicalUrl"
              value={sourceUrl}
            />
            <Button
              type="submit"
              formAction={sourceAction}
              formNoValidate
              disabled={sourcePending}
              variant="secondary"
              size="md"
              className="shrink-0"
            >
              <Download className="size-4" />
              {sourcePending ? t("fetchingMetadata") : t("fetchMetadata")}
            </Button>
          </div>
          {sourceState.error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {sourceState.error}
            </p>
          ) : null}
          {metadata ? (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              {t("metadataFetched")}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label htmlFor={`${fieldId}-name`} className={LABEL_CLASS}>
          <span>{t("name")}</span>
          <Input
            id={`${fieldId}-name`}
            key={`name-${metadataKey}`}
            name="name"
            defaultValue={metadata?.name ?? initial.name ?? ""}
            required
          />
        </label>
        {initial.id ? (
          <div className={LABEL_CLASS}>
            <span>{t("slug")}</span>
            <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/45 px-3">
              <code className="truncate font-mono text-sm text-foreground">
                {initial.slug}
              </code>
              <AdminBadge tone="neutral">{t("immutable")}</AdminBadge>
            </div>
          </div>
        ) : (
          <label htmlFor={`${fieldId}-slug`} className={LABEL_CLASS}>
            <span>{t("slug1")}</span>
            <Input
              id={`${fieldId}-slug`}
              name="slug"
              required
              key={`slug-${metadataKey}`}
              defaultValue={initial.slug ?? suggestedSlug}
              placeholder="my-server"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        )}
        <label htmlFor={`${fieldId}-author`} className={LABEL_CLASS}>
          <span>{t("author")}</span>
          <Input
            id={`${fieldId}-author`}
            key={`author-${metadataKey}`}
            name="author"
            defaultValue={metadata?.author ?? initial.author ?? ""}
          />
        </label>
        <label htmlFor={`${fieldId}-stars`} className={LABEL_CLASS}>
          <span>{t("stars")}</span>
          <Input
            id={`${fieldId}-stars`}
            key={`stars-${metadataKey}`}
            name="stars"
            type="number"
            defaultValue={String(metadata?.stars ?? initial.stars ?? 0)}
          />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t("description")}</span>
          <textarea
            name="description"
            key={`description-${metadataKey}`}
            defaultValue={metadata?.description ?? initial.description ?? ""}
            rows={4}
            className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>
          <span>{t("readme")}</span>
          <textarea
            name="readme"
            key={`readme-${metadataKey}`}
            defaultValue={metadata?.readme ?? initial.readme ?? ""}
            rows={12}
            className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label
          htmlFor={`${fieldId}-iconUrl`}
          className={`${LABEL_CLASS} sm:col-span-2`}
        >
          <span>{t("iconUrl")}</span>
          <Input
            id={`${fieldId}-iconUrl`}
            name="iconUrl"
            defaultValue={initial.iconUrl ?? ""}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:gap-5">
        <div className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
          <FormCheckbox
            name="isOfficial"
            defaultChecked={initial.isOfficial}
            label={t("official")}
          />
        </div>
        <div className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
          <FormCheckbox
            name="isFeatured"
            defaultChecked={initial.isFeatured}
            label={t("featured")}
          />
        </div>
      </div>

      <fieldset className="border-t border-border pt-5">
        <legend className="pr-3 text-sm font-semibold text-foreground">
          {t("categories")}
        </legend>
        {categories.length > 0 ? (
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {categories.map((c) => (
              <div
                key={c.id}
                className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
              >
                <FormCheckbox
                  name="categoryIds"
                  value={c.id}
                  defaultChecked={sel.has(c.id)}
                  label={c.name}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{t("none")}</p>
        )}
      </fieldset>

      <div className="flex flex-col items-start gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <SubmitButton
          error={state.error}
          pendingLabel={t("saving")}
          savedLabel={t("saved")}
          variant="primary"
          size="md"
          className="w-full sm:w-auto"
        >
          <SubmitIcon className="size-4" />
          {submitLabel}
        </SubmitButton>
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
