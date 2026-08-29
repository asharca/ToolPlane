'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Upload } from 'lucide-react';
import {
  publishAssistantReleaseAction,
  publishMcpReleaseAction,
  publishSkillReleaseAction,
  publishToolkitReleaseAction,
  type MarketActionState,
} from '@/lib/market/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

const initialState: MarketActionState = {};

type PublishAction = (state: MarketActionState, formData: FormData) => Promise<MarketActionState>;

type ListingDefaults = {
  name: string;
  slug: string;
  summary: string | null;
  tags: string[];
  categoryIds: string[];
};

type CategoryOption = { id: string; name: string };

function MarketPublishForm({
  workspace,
  resource,
  listing,
  canPublish,
  categories,
  sourceField,
  action: publishAction,
}: {
  workspace: string;
  resource: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
  sourceField: 'deploymentId' | 'installedSkillId' | 'assistantId' | 'toolkitId';
  action: PublishAction;
}) {
  const t = useTranslations('console.market');
  const [state, action] = useActionState(publishAction, initialState);
  const errorLabels: Record<string, string> = {
    not_authorized: t('publishErrorUnauthorized'),
    source_not_found: t('publishErrorMissing'),
    listing_conflict: t('publishErrorConflict'),
    action_failed: t('publishErrorGeneric'),
  };

  if (!canPublish) {
    return <span className="text-xs text-muted-foreground">{t('publishRequiresManager')}</span>;
  }

  return (
    <details className="group sm:col-span-4">
      <summary className="ui-button-secondary ml-auto h-8 w-fit cursor-pointer list-none px-2.5 text-xs [&::-webkit-details-marker]:hidden">
        <Upload className="size-3.5" />
        {listing ? t('publishNewVersion') : t('publishToMarket')}
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <form action={action} className="mt-4 grid gap-3 rounded-lg bg-muted/35 p-4 sm:grid-cols-2">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name={sourceField} value={resource.id} />
        <label className="text-xs font-medium text-foreground">
          {t('listingName')}
          <input
            name="name"
            required
            maxLength={240}
            defaultValue={listing?.name ?? resource.name}
            className="ui-input mt-1.5 h-9"
          />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="text-xs font-medium text-foreground">{t('filterByCategory')}</legend>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {categories.map((category) => (
              <label key={category.id} className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  name="categoryIds"
                  value={category.id}
                  defaultChecked={listing?.categoryIds.includes(category.id)}
                  className="size-3.5 accent-foreground"
                />
                <span>{category.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-xs font-medium text-foreground">
          {t('listingSlug')}
          <input
            name="slug"
            required
            maxLength={100}
            defaultValue={listing?.slug ?? resource.slug}
            className="ui-input mt-1.5 h-9"
          />
        </label>
        <label className="text-xs font-medium text-foreground sm:col-span-2">
          {t('listingSummary')}
          <textarea
            name="summary"
            required
            maxLength={4000}
            rows={3}
            defaultValue={listing?.summary ?? resource.description ?? ''}
            className="ui-input mt-1.5 resize-y py-2"
          />
        </label>
        <label className="text-xs font-medium text-foreground">
          {t('listingTags')}
          <input
            name="tags"
            maxLength={400}
            defaultValue={listing?.tags.join(', ') ?? ''}
            placeholder={t('listingTagsPlaceholder')}
            className="ui-input mt-1.5 h-9"
          />
        </label>
        <label className="text-xs font-medium text-foreground">
          {t('releaseNotes')}
          <input
            name="releaseNotes"
            maxLength={10000}
            placeholder={t('releaseNotesPlaceholder')}
            className="ui-input mt-1.5 h-9"
          />
        </label>
        <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2">
          {state.error ? (
            <p role="alert" className="mr-auto text-xs text-red-600 dark:text-red-400">
              {errorLabels[state.error] ?? t('publishErrorGeneric')}
            </p>
          ) : null}
          {state.ok ? (
            <p role="status" className="mr-auto text-xs text-emerald-700 dark:text-emerald-300">
              {t('releaseSubmitted')}
            </p>
          ) : null}
          <SubmitButton pendingLabel={t('submittingRelease')} flash={false} className="ui-button-primary h-9 px-3 text-xs">
            {listing ? t('submitNewVersion') : t('submitForReview')}
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

export function SkillPublishForm(props: {
  workspace: string;
  skill: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.skill}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="installedSkillId"
      action={publishSkillReleaseAction}
    />
  );
}

export function AssistantPublishForm(props: {
  workspace: string;
  assistant: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.assistant}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="assistantId"
      action={publishAssistantReleaseAction}
    />
  );
}

export function McpPublishForm(props: {
  workspace: string;
  mcp: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.mcp}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="deploymentId"
      action={publishMcpReleaseAction}
    />
  );
}

export function ToolkitPublishForm(props: {
  workspace: string;
  toolkit: { id: string; name: string; slug: string; description: string | null };
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
}) {
  return (
    <MarketPublishForm
      workspace={props.workspace}
      resource={props.toolkit}
      listing={props.listing}
      canPublish={props.canPublish}
      categories={props.categories}
      sourceField="toolkitId"
      action={publishToolkitReleaseAction}
    />
  );
}
