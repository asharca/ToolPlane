import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Boxes,
  CheckCircle2,
  Eye,
  FileLock2,
  Globe2,
  Network,
  PackageCheck,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getAgentPageData } from '@/lib/agents/queries';
import {
  assessAgentPortability,
  getAgentListingForPublisher,
} from '@/lib/agents/market';
import {
  publishAgentReleaseAction,
  unpublishAgentListingAction,
  withdrawPendingAgentReleaseAction,
} from '@/lib/agents/actions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

function marketListingHref(workspace: string, listingId: string) {
  return `/app/${encodeURIComponent(workspace)}/market/agents/${encodeURIComponent(listingId)}`;
}

function errorMessage(t: (key: 'ownerOnlyPublish' | 'confirmRequired' | 'publishError') => string, error?: string) {
  if (!error) return null;
  if (error === 'owner_only') return t('ownerOnlyPublish');
  if (error === 'confirm_required') return t('confirmRequired');
  return t('publishError');
}

export default async function AgentPublishPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
  searchParams: Promise<{ submitted?: string; unpublished?: string; withdrawn?: string; error?: string }>;
}) {
  const [{ workspace: workspaceSlug, agentId }, statusParams, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.agents'),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(workspaceSlug, user.id);
  if (!workspace) redirect('/app');

  const [agent, listing, assessment] = await Promise.all([
    getAgentPageData(workspace.id, agentId),
    getAgentListingForPublisher(workspace.id, agentId),
    assessAgentPortability({ workspaceId: workspace.id, agentId }),
  ]);
  if (!agent) notFound();

  const isOwner = workspace.ownerId === user.id;
  const currentListing = listing;
  const latestRelease = listing?.latestRelease ?? null;
  const pendingRelease = listing?.pendingRelease ?? null;
  const manifest = assessment.portable ? assessment.manifest : null;
  const issueText = assessment.portable
    ? []
    : assessment.issues.map((issue) => issue.message);
  const formError = errorMessage(t, statusParams.error);
  const isPublished = currentListing?.status === 'published' && Boolean(latestRelease);
  const isPending = pendingRelease?.reviewStatus === 'pending';
  const previewHref = isPublished && currentListing
    ? marketListingHref(workspaceSlug, currentListing.id)
    : null;
  const draftName = pendingRelease?.name ?? currentListing?.name ?? agent.name;
  const draftSummary = pendingRelease?.summary ?? currentListing?.summary ?? '';
  const draftIconUrl = pendingRelease?.iconUrl ?? currentListing?.iconUrl ?? '';
  const draftTags = pendingRelease?.tags ?? currentListing?.tags ?? [];

  return (
    <>
      <DashboardHeader
        breadcrumb={[
          { label: t('title'), href: `/app/${workspaceSlug}/agents` },
          { label: agent.name, href: `/app/${workspaceSlug}/agents/${agentId}` },
          { label: t('publishBreadcrumb') },
        ]}
      />
      <DashboardPage className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href={`/app/${workspaceSlug}/agents/${agentId}`}
              className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> {agent.name}
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('marketListing')}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('marketListingDescription')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${
              isPublished
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : isPending
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'bg-muted text-muted-foreground'
            }`}>
              <Globe2 className="size-3.5" />
              {isPublished && latestRelease
                ? t('publishedVersion', { version: latestRelease.version })
                : isPending && pendingRelease
                  ? t('pendingReviewVersion', { version: pendingRelease.version })
                : t('notPublished')}
            </span>
            {isPublished && isPending && pendingRelease ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <FileLock2 className="size-3.5" />
                {t('pendingUpdateVersion', { version: pendingRelease.version })}
              </span>
            ) : null}
            {previewHref ? (
              <Link href={previewHref} className="ui-button-secondary h-8 gap-1.5 px-2.5 text-xs">
                <Eye className="size-3.5" /> {t('previewListing')}
              </Link>
            ) : null}
          </div>
        </div>

        {statusParams.submitted ? (
          <p role="status" className="rounded-md bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            {t('submissionSuccess')}
          </p>
        ) : null}
        {statusParams.unpublished ? (
          <p role="status" className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
            {t('unpublishedSuccess')}
          </p>
        ) : null}
        {statusParams.withdrawn ? (
          <p role="status" className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
            {t('withdrawnSuccess')}
          </p>
        ) : null}
        {formError ? (
          <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {formError}
          </p>
        ) : null}
        {!isOwner ? (
          <p role="alert" className="rounded-md border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            {t('ownerOnlyPublish')}
          </p>
        ) : null}

        <form action={publishAgentReleaseAction} className="space-y-5">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="listingSlug" value={currentListing?.slug ?? agent.slug} />

          <section className="ui-panel overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
              <Globe2 className="size-[18px] text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('marketListing')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('marketListingDescription')}</p>
              </div>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('publicName')}</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={draftName}
                  className="ui-input h-10"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('marketTags')}</span>
                <input
                  name="tags"
                  maxLength={240}
                  defaultValue={draftTags.join(', ')}
                  placeholder={t('marketTagsPlaceholder')}
                  className="ui-input h-10"
                />
                <span className="mt-1.5 block text-xs text-muted-foreground">{t('marketTagsHint')}</span>
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('publicSummary')}</span>
                <textarea
                  name="summary"
                  required
                  maxLength={360}
                  rows={4}
                  defaultValue={draftSummary}
                  placeholder={t('publicSummaryPlaceholder')}
                  className="ui-input min-h-28 resize-y py-3"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('publicIconUrl')}</span>
                <input
                  name="iconUrl"
                  type="url"
                  maxLength={2000}
                  defaultValue={draftIconUrl}
                  placeholder="https://example.com/agent-icon.png"
                  className="ui-input h-10"
                />
              </label>
            </div>
          </section>

          <section className="ui-panel overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
              {assessment.portable ? (
                <CheckCircle2 className="size-[18px] text-emerald-600" />
              ) : (
                <AlertTriangle className="size-[18px] text-amber-600" />
              )}
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('portabilityCheck')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {assessment.portable ? t('portableDescription') : t('notPortableDescription')}
                </p>
              </div>
            </div>
            {assessment.portable && manifest ? (
              <div className="p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  <ShieldCheck className="size-4" /> {t('portableTitle')}
                </div>
                <dl className="mt-5 grid gap-x-7 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    [Bot, t('agentDefinitions'), manifest.agents.length],
                    [Server, t('verifiedMcps'), manifest.deployments.length],
                    [PackageCheck, t('skillSnapshots'), manifest.skills.length],
                    [Boxes, t('privateToolkits'), manifest.toolkits.length],
                    [Network, t('subAgents'), Math.max(0, manifest.agents.length - 1)],
                  ].map(([Icon, label, value]) => {
                    const MetricIcon = Icon as typeof Bot;
                    return (
                      <div key={String(label)} className="flex items-center gap-3 border-b border-border pb-3">
                        <MetricIcon className="size-4 text-muted-foreground" />
                        <dt className="flex-1 text-xs text-muted-foreground">{label as string}</dt>
                        <dd className="text-sm font-semibold tabular-nums text-foreground">{value as number}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ) : (
              <div className="p-5">
                <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300">{t('notPortableTitle')}</h3>
                <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                  {issueText.map((issue) => (
                    <li key={issue} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="ui-panel overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
              <FileLock2 className="size-[18px] text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('willNotPublish')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('willNotPublishDescription')}</p>
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-3 p-5 text-sm leading-6 text-foreground">
              <input
                type="checkbox"
                name="confirmPublicContents"
                value="yes"
                required
                disabled={!assessment.portable || !isOwner}
                className="mt-1 size-4 rounded border-input accent-brand"
              />
              <span>{t('confirmPublicContents')}</span>
            </label>
          </section>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 py-3 backdrop-blur-sm">
            <p className="text-xs text-muted-foreground">{t('releaseContentsDescription')}</p>
            <SubmitButton
              pendingLabel={isPublished ? t('submitUpdateForReview') : t('submitForReview')}
              savedLabel={t('submissionSuccess')}
              disabled={!assessment.portable || !isOwner}
              flash={false}
              className="ui-button-primary h-10 gap-2 px-4"
            >
              <Globe2 className="size-4" />
              {isPublished ? t('submitUpdateForReview') : t('submitForReview')}
            </SubmitButton>
          </div>
        </form>

        {isPending && isOwner ? (
          <section className="ui-panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('withdrawSubmission')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t('withdrawSubmissionDescription')}</p>
              </div>
              <form action={withdrawPendingAgentReleaseAction}>
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="agentId" value={agentId} />
                <button type="submit" className="ui-button-secondary h-9 px-3 text-xs">
                  {t('withdrawSubmission')}
                </button>
              </form>
            </div>
          </section>
        ) : null}

        {isPublished && isOwner ? (
          <section className="ui-panel ui-panel-danger p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t('unpublish')}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('unpublishDescription')}
                </p>
              </div>
              <form action={unpublishAgentListingAction}>
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="agentId" value={agentId} />
                <button type="submit" className="ui-button-secondary ui-button-danger-secondary h-9 px-3 text-xs">
                  {t('unpublish')}
                </button>
              </form>
            </div>
          </section>
        ) : null}
      </DashboardPage>
    </>
  );
}
