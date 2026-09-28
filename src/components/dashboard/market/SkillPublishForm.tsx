'use client';

import { FormCheckbox } from '@/components/ui/FormCheckbox';

import { Input } from '@/components/motion/input';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalTrigger } from '@/components/motion/center-morph-modal';
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
    <div className="sm:col-span-4">
      <CenterMorphModal>
        <CenterMorphModalTrigger>
          <Button type="button" variant="secondary" size="sm"><Upload className="size-3.5" />{listing ? t('publishNewVersion') : t('publishToMarket')}</Button>
        </CenterMorphModalTrigger>
        <CenterMorphModalContent ariaLabel={listing ? t('publishNewVersion') : t('publishToMarket')}>
      <form action={action} className="mt-4 grid gap-3 rounded-lg bg-muted/35 p-4 sm:grid-cols-2">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name={sourceField} value={resource.id} />
        <div className="text-xs font-medium text-foreground">
          
          <Input label={t('listingName')}
            name="name"
            required
            maxLength={240}
            defaultValue={listing?.name ?? resource.name}
            className="mt-1.5"
          />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="text-xs font-medium text-foreground">{t('filterByCategory')}</legend>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {categories.map((category) => (
              <FormCheckbox key={category.id} name="categoryIds" value={category.id} defaultChecked={listing?.categoryIds.includes(category.id)} label={category.name} />
            ))}
          </div>
        </fieldset>
        <div className="text-xs font-medium text-foreground">
          
          <Input label={t('listingSlug')}
            name="slug"
            required
            maxLength={100}
            defaultValue={listing?.slug ?? resource.slug}
            className="mt-1.5"
          />
        </div>
        <label className="text-xs font-medium text-foreground sm:col-span-2">
          {t('listingSummary')}
          <textarea
            name="summary"
            required
            maxLength={4000}
            rows={3}
            defaultValue={listing?.summary ?? resource.description ?? ''}
            className="rounded-xl border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring mt-1.5 resize-y py-2"
          />
        </label>
        <div className="text-xs font-medium text-foreground">
          
          <Input label={t('listingTags')}
            name="tags"
            maxLength={400}
            defaultValue={listing?.tags.join(', ') ?? ''}
            placeholder={t('listingTagsPlaceholder')}
            className="mt-1.5"
          />
        </div>
        <div className="text-xs font-medium text-foreground">
          
          <Input label={t('releaseNotes')}
            name="releaseNotes"
            maxLength={10000}
            placeholder={t('releaseNotesPlaceholder')}
            className="mt-1.5"
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2">
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorLabels[state.error] ?? t('publishErrorGeneric')}
            </p>
          ) : null}
          {state.ok ? (
            <p role="status" className="mr-auto text-xs text-(--color-success) dark:text-(--color-success)">
              {t('releaseSubmitted')}
            </p>
          ) : null}
          <SubmitButton pendingLabel={t('submittingRelease')} flash={false} variant="primary" size="sm">
            {listing ? t('submitNewVersion') : t('submitForReview')}
          </SubmitButton>
        </div>
      </form>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </div>
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
