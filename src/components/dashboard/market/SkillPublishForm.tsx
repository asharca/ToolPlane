'use client';

import { FormCheckbox } from '@/components/ui/FormCheckbox';

import { Input } from '@/components/motion/input';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalTrigger } from '@/components/motion/center-morph-modal';
import {
  publishPiPackageReleaseAction,
  publishAssembledPiPackageReleaseAction,
  publishAssistantReleaseAction,
  publishMcpReleaseAction,
  publishSkillReleaseAction,
  publishToolkitReleaseAction,
} from '@/lib/market/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { MarketActionState } from '@/lib/market/actions';

const initialState: MarketActionState = {};

type PublishAction = (state: MarketActionState, formData: FormData) => Promise<MarketActionState>;

type ListingDefaults = {
  name: string;
  slug: string;
  summary: string | null;
  tags: string[];
  categoryIds: string[];
};

export type PiCompositionOptions = {
  skills: Array<{ id: string; name: string; selected?: boolean }>;
  deployments: Array<{ id: string; name: string; tools: string[]; selected?: boolean }>;
};

type CategoryOption = { id: string; name: string };

type MarketPublishFormProps = {
  workspace: string;
  listing?: ListingDefaults;
  canPublish: boolean;
  categories: CategoryOption[];
  action: PublishAction;
} & ({
  sourceField: 'deploymentId' | 'installedSkillId' | 'assistantId' | 'toolkitId';
  resource: { id: string; name: string; slug: string; description: string | null };
} | {
  sourceField: 'source';
  listingId?: string;
  visibility?: 'private' | 'public';
} | {
  sourceField: 'composition';
  listingId?: string;
  visibility?: 'private' | 'public';
  options: PiCompositionOptions;
  resource?: { id: string; name: string; slug: string; description: string | null };
});

function MarketPublishForm(props: MarketPublishFormProps) {
  const { workspace, listing, canPublish, categories, sourceField, action: publishAction } = props;
  const resource = 'resource' in props ? props.resource : null;
  const t = useTranslations('console.market');
  const [state, action] = useActionState(publishAction, initialState);
  const errorLabels: Record<string, string> = {
    not_authorized: t('publishErrorUnauthorized'),
    source_not_found: t('publishErrorMissing'),
    listing_conflict: t('publishErrorConflict'),
    action_failed: t('publishErrorGeneric'),
    capture_busy: t('piCaptureBusy'),
    capture_image_missing: t('piCaptureImageMissing'),
    package_capture_failed: t('piCaptureFailed'),
    pi_extensions_missing: t('piExtensionsMissing'),
    invalid_categories: t('piInvalidCategories'),
    invalid_manifest: t('piInvalidManifest'),
    pi_package_tools_unavailable: t('piComposeToolsUnavailable'),
    pi_package_name_invalid: t('piComposeInvalidIdentity'),
    pi_package_version_invalid: t('piComposeInvalidIdentity'),
    pi_package_invalid_selection: t('piComposeInvalidIdentity'),
    pi_package_source_unavailable: t('piComposeSourceUnavailable'),
  };

  if (!canPublish) {
    return <span className="text-xs text-muted-foreground">{t('publishRequiresManager')}</span>;
  }

  return (
    <div className="sm:col-span-4">
      <CenterMorphModal>
        <CenterMorphModalTrigger>
          <Button type="button" variant="secondary" size="sm"><Upload className="size-3.5" />{sourceField === 'composition' ? t(listing ? 'piComposeNewVersion' : 'piComposeTitle') : listing ? t('publishNewVersion') : t('publishToMarket')}</Button>
        </CenterMorphModalTrigger>
        <CenterMorphModalContent ariaLabel={listing ? t('publishNewVersion') : t('publishToMarket')}>
      <form action={action} className="mt-4 grid max-h-[75dvh] gap-3 overflow-y-auto rounded-lg bg-muted/35 p-4 sm:grid-cols-2">
        <input type="hidden" name="workspace" value={workspace} />
        {props.sourceField === 'source' || props.sourceField === 'composition' ? (
          <>
            <input type="hidden" name="listingId" value={props.listingId ?? state.listingId ?? ''} />
            {props.sourceField === 'source' ? <div className="space-y-2 sm:col-span-2">
              <Input label={t('piSource')} name="source" required maxLength={2048} placeholder="npm:package@version / https://host/owner/repo.git" />
              <p className="text-xs leading-5 text-muted-foreground">{t('piSourceHelp')}</p>
              <p className="text-xs leading-5 text-muted-foreground">{t('piExecutionWarning')}</p>
              <p className="text-xs leading-5 text-muted-foreground">{t('piHeadlessWarning')}</p>
            </div> : <>
              <Input label={t('piComposePackageName')} name="packageName" required maxLength={214} placeholder="@team/package-name" defaultValue={resource?.slug} />
              <Input label={t('piComposePackageVersion')} name="packageVersion" required maxLength={100} placeholder="1.0.0" defaultValue={resource ? '1.0.0' : undefined} />
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('piComposeIdentityHelp')}</p>
              <fieldset className="space-y-2 sm:col-span-2">
                <legend className="text-sm font-medium">{t('skills')}</legend>
                {props.options.skills.length ? props.options.skills.map((skill) => <FormCheckbox key={skill.id} name="installedSkillIds" value={skill.id} label={skill.name} defaultChecked={skill.selected} />) : <p className="text-xs text-muted-foreground">{t('piComposeNoSkills')}</p>}
              </fieldset>
              <fieldset className="space-y-3 sm:col-span-2">
                <legend className="text-sm font-medium">{t('piComposeMcpTools')}</legend>
                {props.options.deployments.map((deployment) => <div key={deployment.id} className="space-y-2">
                  <p className="text-xs font-medium">{deployment.name}</p>
                  {deployment.tools.length ? deployment.tools.map((tool) => <FormCheckbox key={tool} name="mcpTools" value={JSON.stringify([deployment.id, tool])} label={tool} defaultChecked={deployment.selected} />) : <p className="text-xs text-muted-foreground">{t('piComposeNoTools')}</p>}
                </div>)}
                <p className="text-xs text-muted-foreground">{t('piComposeBindingHelp')}</p>
              </fieldset>
            </>}
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-xs font-medium">{t('piVisibility')}</legend>
              <FormCheckbox name="visibility" value="public" defaultChecked={props.visibility === 'public'} label={t('piVisibilityPublic')} />
              <p className="text-xs text-muted-foreground">{t('piVisibilityHelp')}</p>
            </fieldset>
          </>
        ) : <input type="hidden" name={sourceField} value={props.resource.id} />}
        <div className="text-xs font-medium text-foreground">
          
          <Input label={t('listingName')}
            name="name"
            required
            maxLength={240}
            defaultValue={listing?.name ?? resource?.name ?? ''}
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
            defaultValue={listing?.slug ?? resource?.slug ?? ''}
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
            defaultValue={listing?.summary ?? resource?.description ?? ''}
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
          <SubmitButton pendingLabel={t(sourceField === 'source' ? 'piCapturing' : 'submittingRelease')} flash={false} variant="primary" size="sm">
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

export function PiPackagePublishForm(props: {
  workspace: string;
  listing?: ListingDefaults;
  listingId?: string;
  canPublish: boolean;
  categories: CategoryOption[];
  visibility?: 'private' | 'public';
}) {
  return <MarketPublishForm {...props} sourceField="source" action={publishPiPackageReleaseAction} />;
}

export function PiPackageComposeForm(props: {
  workspace: string;
  listing?: ListingDefaults;
  listingId?: string;
  visibility?: 'private' | 'public';
  canPublish: boolean;
  categories: CategoryOption[];
  options: PiCompositionOptions;
  resource?: { id: string; name: string; slug: string; description: string | null };
}) {
  return <MarketPublishForm {...props} sourceField="composition" action={publishAssembledPiPackageReleaseAction} />;
}
