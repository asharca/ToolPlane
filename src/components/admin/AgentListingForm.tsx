'use client';

import { Bot, Plus, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import type { AdminActionState } from '@/lib/admin/user-actions';

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

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';
const CHECKBOX_CLASS = 'size-4 shrink-0 accent-brand';

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
        <label
          key={resource.id}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
        >
          <input
            type="checkbox"
            name={name}
            value={resource.id}
            defaultChecked={selected.has(resource.id)}
            className={CHECKBOX_CLASS}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{resource.name}</span>
            <code className="block truncate font-mono text-[11px] text-muted-foreground">/{resource.slug}</code>
          </span>
        </label>
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
}: {
  action: (previous: AdminActionState, formData: FormData) => Promise<AdminActionState>;
  initial: AgentListingFormInitial;
  categories: Category[];
  servers: Resource[];
  skills: Resource[];
  configEditable?: boolean;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const t = useTranslations('admin');
  const selectedCategories = new Set(initial.categoryIds ?? []);
  const selectedServers = new Set(initial.serverIds ?? []);
  const selectedSkills = new Set(initial.skillIds ?? []);
  const SubmitIcon = initial.id ? Save : Plus;

  return (
    <form action={formAction} className="space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="updateConfig" value={configEditable ? 'yes' : 'no'} />

      <AdminPanel
        title={t('agentDirectoryMetadata')}
        description={t('agentDirectoryMetadataDescription')}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <label className={LABEL_CLASS}>
            <span>{t('name')}</span>
            <input
              name="name"
              defaultValue={initial.name ?? ''}
              maxLength={240}
              required
              className="ui-input h-11"
            />
          </label>
          {initial.id ? (
            <div className={LABEL_CLASS}>
              <span>{t('agentDirectorySlug')}</span>
              <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/45 px-3">
                <code className="truncate font-mono text-sm text-foreground">{initial.directorySlug}</code>
                <AdminBadge tone="neutral">{t('immutable')}</AdminBadge>
              </div>
              <input type="hidden" name="directorySlug" value={initial.directorySlug ?? ''} />
            </div>
          ) : (
            <label className={LABEL_CLASS}>
              <span>{t('agentDirectorySlug')}</span>
              <input
                name="directorySlug"
                required
                maxLength={120}
                placeholder="research-assistant"
                className="ui-input h-11 font-mono"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          )}
          <label className={LABEL_CLASS}>
            <span>{t('author')}</span>
            <input
              name="author"
              defaultValue={initial.author ?? ''}
              maxLength={240}
              className="ui-input h-11"
            />
          </label>
          <label className={LABEL_CLASS}>
            <span>{t('statusColumn')}</span>
            <NativeSelect name="status" defaultValue={initial.status ?? 'published'} className="ui-input h-11">
              <option value="draft">{t('agentListingStatusDraft')}</option>
              <option value="published">{t('agentListingStatusPublished')}</option>
              <option value="disabled">{t('agentListingStatusDisabled')}</option>
            </NativeSelect>
          </label>
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            <span>{t('description')}</span>
            <textarea
              name="summary"
              defaultValue={initial.summary ?? ''}
              maxLength={4000}
              rows={4}
              className="ui-input h-auto min-h-28 resize-y py-2.5"
            />
          </label>
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            <span>{t('iconUrl')}</span>
            <input
              name="iconUrl"
              defaultValue={initial.iconUrl ?? ''}
              maxLength={2000}
              className="ui-input h-11"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className={`${LABEL_CLASS} sm:col-span-2`}>
            <span>{t('agentListingTags')}</span>
            <input
              name="tags"
              defaultValue={(initial.tags ?? []).join(', ')}
              placeholder="research, writing, productivity"
              className="ui-input h-11"
            />
            <span className="block text-xs font-normal leading-5 text-muted-foreground">
              {t('agentListingTagsDescription')}
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:gap-5">
          {initial.id ? (
            <label className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
              <input
                type="checkbox"
                name="curated"
                defaultChecked={initial.curated ?? true}
                className={CHECKBOX_CLASS}
              />
              {t('curated')}
            </label>
          ) : (
            <div className="flex min-h-11 items-center gap-2 px-2 text-sm font-medium text-foreground">
              <AdminBadge tone="brand">{t('curated')}</AdminBadge>
              <span className="text-xs font-normal text-muted-foreground">{t('agentAdminTemplatesAreCurated')}</span>
            </div>
          )}
          <label className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted/60">
            <input
              type="checkbox"
              name="isFeatured"
              defaultChecked={initial.isFeatured}
              className={CHECKBOX_CLASS}
            />
            {t('featured')}
          </label>
        </div>

        <fieldset className="mt-5 border-t border-border pt-5">
          <legend className="pr-3 text-sm font-semibold text-foreground">{t('categories')}</legend>
          {categories.length > 0 ? (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {categories.map((category) => (
                <label
                  key={category.id}
                  className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    name="categoryIds"
                    value={category.id}
                    defaultChecked={selectedCategories.has(category.id)}
                    className={CHECKBOX_CLASS}
                  />
                  {category.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t('none')}</p>
          )}
        </fieldset>
      </AdminPanel>

      <AdminPanel
        title={t('agentTemplateConfiguration')}
        description={configEditable
          ? t('agentTemplateConfigurationDescription')
          : t('agentTemplateConfigurationReadOnly')}
        actions={<Bot className="size-4 text-muted-foreground" />}
      >
        {configEditable ? (
          <div className="space-y-6">
            <label className={LABEL_CLASS}>
              <span>{t('agentSystemPrompt')}</span>
              <textarea
                name="systemPrompt"
                defaultValue={initial.systemPrompt ?? ''}
                rows={10}
                className="ui-input h-auto min-h-52 resize-y py-2.5 font-mono text-xs leading-6"
              />
            </label>

            <div className="grid gap-5 sm:grid-cols-3">
              <label className={LABEL_CLASS}>
                <span>{t('agentMaxSteps')}</span>
                <input
                  name="maxSteps"
                  type="number"
                  min={AGENT_STEP_BOUNDS.min}
                  max={AGENT_STEP_BOUNDS.max}
                  defaultValue={initial.maxSteps ?? AGENT_STEP_BOUNDS.default}
                  required
                  className="ui-input h-11"
                />
              </label>
              <label className={LABEL_CLASS}>
                <span>{t('agentModelFormat')}</span>
                <NativeSelect name="modelFormat" defaultValue={initial.modelFormat ?? ''} className="ui-input h-11">
                  <option value="">{t('agentNoModelRequirement')}</option>
                  <option value="openai">OpenAI</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic">Anthropic</option>
                </NativeSelect>
              </label>
              <label className={LABEL_CLASS}>
                <span>{t('agentModelId')}</span>
                <input
                  name="model"
                  defaultValue={initial.model ?? ''}
                  maxLength={240}
                  placeholder="gpt-5"
                  className="ui-input h-11 font-mono"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            </div>

            <fieldset className="border-t border-border pt-5">
              <legend className="pr-3 text-sm font-semibold text-foreground">{t('agentCatalogServers')}</legend>
              <div className="mt-2">
                <ResourceChecklist
                  name="serverIds"
                  resources={servers}
                  selected={selectedServers}
                  emptyLabel={t('agentNoVerifiedServers')}
                />
              </div>
            </fieldset>

            <fieldset className="border-t border-border pt-5">
              <legend className="pr-3 text-sm font-semibold text-foreground">{t('agentCatalogSkills')}</legend>
              <div className="mt-2">
                <ResourceChecklist
                  name="skillIds"
                  resources={skills}
                  selected={selectedSkills}
                  emptyLabel={t('agentNoCuratedSkills')}
                />
              </div>
            </fieldset>
          </div>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">{t('agentComplexReleasePreserved')}</p>
        )}
      </AdminPanel>

      <div className="flex flex-col items-start gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <SubmitButton
          error={state.error}
          pendingLabel={t('saving')}
          savedLabel={t('saved')}
          className="ui-button-primary h-11 w-full sm:w-auto"
        >
          <SubmitIcon className="size-4" />
          {submitLabel}
        </SubmitButton>
        {state.error ? (
          <p className="text-sm text-destructive-text" role="alert">{state.error}</p>
        ) : null}
      </div>
    </form>
  );
}
