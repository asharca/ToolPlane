"use client";
import { FormSelect } from "@/components/ui/FormSelect";

import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { Input } from "@/components/motion/input";

import { Bot, MessageSquare, Plus, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { SubmitButton } from "@/components/dashboard/SubmitButton";

import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import type { AdminActionState } from "@/lib/admin/user-actions";

type Category = { id: string; name: string };
type Resource = { id: string; slug: string; name: string };

export type AgentListingFormInitial = {
  id?: string;
  directorySlug?: string;
  name?: string;
  author?: string | null;
  summary?: string | null;
  iconUrl?: string | null;
  tags?: string[];
  curated?: boolean;
  isFeatured?: boolean;
  categoryIds?: string[];
  status?: string;
  systemPrompt?: string | null;
  maxSteps?: number;
  modelFormat?: string | null;
  model?: string | null;
  serverIds?: string[];
  skillIds?: string[];
};

const LABEL_CLASS = "block space-y-1.5 text-sm font-medium text-foreground";

function ResourceChecklist({
  name,
  resources,
  selected,
  emptyLabel,
}: {
  name: string;
  resources: Resource[];
  selected: Set<string>;
  emptyLabel: string;
}) {
  if (resources.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
      {resources.map((resource) => (
        <div
          key={resource.id}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
        >
          <FormCheckbox
            name={name}
            value={resource.id}
            defaultChecked={selected.has(resource.id)}
            label={resource.name}
          />
          <span className="min-w-0">
            <code className="block truncate font-mono text-[11px] text-muted-foreground">
              /{resource.slug}
            </code>
          </span>
        </div>
      ))}
    </div>
  );
}

export function AgentListingForm({
  action,
  initial,
  categories,
  servers,
  skills,
  configEditable = true,
  submitLabel,
  mode = "agent",
}: {
  action: (
    previous: AdminActionState,
    formData: FormData,
  ) => Promise<AdminActionState>;
  initial: AgentListingFormInitial;
  categories: Category[];
  servers: Resource[];
  skills: Resource[];
  configEditable?: boolean;
  submitLabel: string;
  mode?: "agent" | "assistant";
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(
    action,
    {},
  );
  const t = useTranslations("admin");
  const fieldId = useId();
  const selectedCategories = new Set(initial.categoryIds ?? []);
  const selectedServers = new Set(initial.serverIds ?? []);
  const selectedSkills = new Set(initial.skillIds ?? []);
  const SubmitIcon = initial.id ? Save : Plus;
  const assistantMode = mode === "assistant";
  const ConfigIcon = assistantMode ? MessageSquare : Bot;

  return (
    <form action={formAction} className="space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input
        type="hidden"
        name="updateConfig"
        value={configEditable ? "yes" : "no"}
      />

      <AdminPanel
        title={t(
          assistantMode
            ? "assistantDirectoryMetadata"
            : "agentDirectoryMetadata",
        )}
        description={t(
          assistantMode
            ? "assistantDirectoryMetadataDescription"
            : "agentDirectoryMetadataDescription",
        )}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <label htmlFor={`${fieldId}-name`} className={LABEL_CLASS}>
            <span>{t("name")}</span>
            <Input
              id={`${fieldId}-name`}
              name="name"
              defaultValue={initial.name ?? ""}
              maxLength={240}
              required
            />
          </label>
          {initial.id ? (
            <div className={LABEL_CLASS}>
              <span>
                {t(
                  assistantMode
                    ? "assistantTemplateSlug"
                    : "agentDirectorySlug",
                )}
              </span>
              <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/45 px-3">
                <code className="truncate font-mono text-sm text-foreground">
                  {initial.directorySlug}
                </code>
                <AdminBadge tone="neutral">{t("immutable")}</AdminBadge>
              </div>
              <input
                type="hidden"
                name="directorySlug"
                value={initial.directorySlug ?? ""}
              />
            </div>
          ) : (
            <label htmlFor={`${fieldId}-directorySlug`} className={LABEL_CLASS}>
              <span>
                {t(
                  assistantMode
                    ? "assistantTemplateSlug"
                    : "agentDirectorySlug",
                )}
              </span>
              <Input
                id={`${fieldId}-directorySlug`}
                name="directorySlug"
                required
                maxLength={120}
                placeholder="research-assistant"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          )}
          <label htmlFor={`${fieldId}-author`} className={LABEL_CLASS}>
            <span>{t("author")}</span>
            <Input
              id={`${fieldId}-author`}
              name="author"
              defaultValue={initial.author ?? ""}
              maxLength={240}
            />
          </label>
          <div className={LABEL_CLASS}>
            <span>{t("statusColumn")}</span>
            <FormSelect
              name="status"
              defaultValue={initial.status ?? "published"}
              label={t("statusColumn")}
              options={[
                { value: "draft", label: t("agentListingStatusDraft") },
                { value: "published", label: t("agentListingStatusPublished") },
                { value: "disabled", label: t("agentListingStatusDisabled") },
              ]}
            />
          </div>
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            <span>{t("description")}</span>
            <textarea
              name="summary"
              defaultValue={initial.summary ?? ""}
              maxLength={4000}
              rows={4}
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
              maxLength={2000}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label
            htmlFor={`${fieldId}-tags`}
            className={`${LABEL_CLASS} sm:col-span-2`}
          >
            <span>{t("agentListingTags")}</span>
            <Input
              id={`${fieldId}-tags`}
              name="tags"
              defaultValue={(initial.tags ?? []).join(", ")}
              placeholder="research, writing, productivity"
            />
            <span className="block text-xs font-normal leading-5 text-muted-foreground">
              {t("agentListingTagsDescription")}
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:gap-5">
          {initial.id ? (
            <div className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
              <FormCheckbox
                name="curated"
                defaultChecked={initial.curated ?? true}
                label={t("curated")}
              />
            </div>
          ) : (
            <div className="flex min-h-11 items-center gap-2 px-2 text-sm font-medium text-foreground">
              <AdminBadge tone="info">{t("curated")}</AdminBadge>
              <span className="text-xs font-normal text-muted-foreground">
                {t(
                  assistantMode
                    ? "assistantAdminTemplatesAreCurated"
                    : "agentAdminTemplatesAreCurated",
                )}
              </span>
            </div>
          )}
          <div className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
            <FormCheckbox
              name="isFeatured"
              defaultChecked={initial.isFeatured}
              label={t("featured")}
            />
          </div>
        </div>

        <fieldset className="mt-5 border-t border-border pt-5">
          <legend className="pr-3 text-sm font-semibold text-foreground">
            {t("categories")}
          </legend>
          {categories.length > 0 ? (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {categories.map((category) => (
                <div
                  key={category.id}
                  className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
                >
                  <FormCheckbox
                    name="categoryIds"
                    value={category.id}
                    defaultChecked={selectedCategories.has(category.id)}
                    label={category.name}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t("none")}</p>
          )}
        </fieldset>
      </AdminPanel>

      <AdminPanel
        title={t(
          assistantMode
            ? "assistantTemplateConfiguration"
            : "agentTemplateConfiguration",
        )}
        description={
          configEditable
            ? t(
                assistantMode
                  ? "assistantTemplateConfigurationDescription"
                  : "agentTemplateConfigurationDescription",
              )
            : t("agentTemplateConfigurationReadOnly")
        }
        actions={<ConfigIcon className="size-4 text-muted-foreground" />}
      >
        {configEditable ? (
          <div className="space-y-6">
            <label className={LABEL_CLASS}>
              <span>
                {t(
                  assistantMode ? "assistantSystemPrompt" : "agentSystemPrompt",
                )}
              </span>
              <textarea
                name="systemPrompt"
                defaultValue={initial.systemPrompt ?? ""}
                rows={10}
                className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <div className="grid gap-5 sm:grid-cols-3">
              <label htmlFor={`${fieldId}-maxSteps`} className={LABEL_CLASS}>
                <span>{t("agentMaxSteps")}</span>
                <Input
                  id={`${fieldId}-maxSteps`}
                  name="maxSteps"
                  type="number"
                  min={AGENT_STEP_BOUNDS.min}
                  max={AGENT_STEP_BOUNDS.max}
                  defaultValue={String(
                    initial.maxSteps ?? AGENT_STEP_BOUNDS.default,
                  )}
                  required
                />
              </label>
              <div className={LABEL_CLASS}>
                <span>{t("agentModelFormat")}</span>
                <FormSelect
                  name="modelFormat"
                  defaultValue={initial.modelFormat ?? ""}
                  label={t("agentModelFormat")}
                  options={[
                    { value: "", label: t("agentNoModelRequirement") },
                    { value: "openai", label: "OpenAI" },
                    { value: "openai-responses", label: "OpenAI Responses" },
                    ...(assistantMode
                      ? [
                          {
                            value: "openai-compatible",
                            label: "OpenAI Compatible",
                          },
                        ]
                      : []),
                    { value: "anthropic", label: "Anthropic" },
                  ]}
                />
              </div>
              <label htmlFor={`${fieldId}-model`} className={LABEL_CLASS}>
                <span>{t("agentModelId")}</span>
                <Input
                  id={`${fieldId}-model`}
                  name="model"
                  defaultValue={initial.model ?? ""}
                  maxLength={240}
                  placeholder="gpt-5"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            </div>

            <fieldset className="border-t border-border pt-5">
              <legend className="pr-3 text-sm font-semibold text-foreground">
                {t(
                  assistantMode
                    ? "assistantCatalogServers"
                    : "agentCatalogServers",
                )}
              </legend>
              <div className="mt-2">
                <ResourceChecklist
                  name="serverIds"
                  resources={servers}
                  selected={selectedServers}
                  emptyLabel={t("agentNoVerifiedServers")}
                />
              </div>
            </fieldset>

            {!assistantMode ? (
              <fieldset className="border-t border-border pt-5">
                <legend className="pr-3 text-sm font-semibold text-foreground">
                  {t("agentCatalogSkills")}
                </legend>
                <div className="mt-2">
                  <ResourceChecklist
                    name="skillIds"
                    resources={skills}
                    selected={selectedSkills}
                    emptyLabel={t("agentNoCuratedSkills")}
                  />
                </div>
              </fieldset>
            ) : null}
          </div>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            {t("agentComplexReleasePreserved")}
          </p>
        )}
      </AdminPanel>

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
