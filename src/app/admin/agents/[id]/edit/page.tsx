import { History } from 'lucide-react';
import Link from 'next/link';
import { ReleaseChanges } from '@/components/admin/ReleaseChanges';
import { LogTimestamp } from '@/components/admin/LogUI';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AgentListingForm, type AgentListingFormInitial } from '@/components/admin/AgentListingForm';
import { AgentReleaseReview } from '@/components/admin/AgentReleaseReview';
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from '@/components/admin/AdminUI';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import {
  getDirectoryAgentListing,
  listCatalogAgentResources,
  readAgentReleaseManifest,
} from '@/lib/admin/agent-market';
import {
  deleteAgentListingAction,
  rejectAgentReleaseAction,
  setAgentListingStatusAction,
  updateAgentListingAction,
} from '@/lib/admin/agent-market-actions';
import { listCategories } from '@/lib/admin/categories';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function releaseStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'approved') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

export default async function EditAgentListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string; releaseId?: string }>;
}) {
  const { id } = await params;
  await requireAdmin();
  const [t, listing, categories, resources] = await Promise.all([
    getTranslations('admin'),
    getDirectoryAgentListing(id),
    listCategories(),
    listCatalogAgentResources(),
  ]);
  if (!listing) notFound();
  const ops = await getTranslations('adminOps');
  const query = await searchParams;
  const backHref = adminReturnHref(query.returnTo, '/admin/agents');
  const detailHref = adminHref(`/admin/agents/${id}/edit`, { releaseId: query.releaseId, returnTo: backHref });
  const selectedRelease = query.releaseId ? await db.agentRelease.findFirst({
    where: { id: query.releaseId, listingId: id },
    include: { reviewedBy: { select: { name: true, email: true } } },
  }) : null;
  if (query.releaseId && !selectedRelease) notFound();
  const reviewRelease = selectedRelease ?? listing.pendingRelease;
  const canReview = reviewRelease?.reviewStatus === 'pending' && reviewRelease.id === listing.pendingRelease?.id;
  const previousRelease = reviewRelease ? await db.agentRelease.findFirst({
    where: { listingId: id, version: { lt: reviewRelease.version }, reviewStatus: 'approved' },
    orderBy: { version: 'desc' }, select: { manifest: true },
  }) : null;

  const configurationRelease = listing.latestRelease ?? listing.pendingRelease;
  let manifest: ReturnType<typeof readAgentReleaseManifest> | null = null;
  if (configurationRelease) {
    try {
      manifest = readAgentReleaseManifest(configurationRelease.manifest, configurationRelease.checksum);
    } catch {
      manifest = null;
    }
  }
  const rootAgent = manifest?.agents.find(({ key }) => key === manifest.rootAgentKey) ?? null;
  const serverIdBySlug = new Map(resources.servers.map((server) => [server.slug, server.id]));
  const skillIdBySlug = new Map(resources.skills.map((skill) => [skill.slug, skill.id]));
  const selectedServerIds = manifest?.deployments
    .map(({ catalogSlug }) => serverIdBySlug.get(catalogSlug))
    .filter((value): value is string => Boolean(value)) ?? [];
  const selectedSkillIds = manifest?.skills
    .map(({ catalogSlug }) => catalogSlug ? skillIdBySlug.get(catalogSlug) : undefined)
    .filter((value): value is string => Boolean(value)) ?? [];
  const configEditable = !listing.pendingRelease && (!configurationRelease || Boolean(
    manifest
    && rootAgent
    && manifest.agents.length === 1
    && rootAgent.subAgentKeys.length === 0
    && manifest.toolkits.length === 0
    && manifest.skills.every(({ origin, catalogSlug }) => origin === 'catalog' && Boolean(catalogSlug))
    && selectedServerIds.length === manifest.deployments.length
    && selectedSkillIds.length === manifest.skills.length,
  ));
  const initial: AgentListingFormInitial = {
    id: listing.id,
    directorySlug: listing.directorySlug,
    name: listing.name,
    author: listing.author,
    summary: listing.summary,
    iconUrl: listing.iconUrl,
    tags: listing.tags,
    curated: listing.curated,
    isFeatured: listing.isFeatured,
    categoryIds: listing.categories.map(({ id: categoryId }) => categoryId),
    status: listing.status,
    systemPrompt: rootAgent?.systemPrompt ?? null,
    maxSteps: rootAgent?.maxSteps,
    modelFormat: rootAgent?.modelRequirement?.format ?? null,
    model: rootAgent?.modelRequirement?.model ?? null,
    serverIds: selectedServerIds,
    skillIds: selectedSkillIds,
  };

  let reviewManifest: ReturnType<typeof readAgentReleaseManifest> | null = null;
  if (reviewRelease) {
    try {
      reviewManifest = readAgentReleaseManifest(reviewRelease.manifest, reviewRelease.checksum);
    } catch {
      reviewManifest = null;
    }
  }

  return (
    <AdminPage className="max-w-6xl">
      <AdminPageHeader
        title={`${t('edit')} ${listing.name}`}
        meta={<AdminBadge tone="neutral">/{listing.directorySlug}</AdminBadge>}
        backHref={backHref}
        backLabel={t('directoryAgents')}
        actions={<Link href={adminHref('/admin/logs', { tab: 'audit', targetType: 'agentListing', targetId: id, returnTo: detailHref })} className="ui-button-secondary"><History className="size-4" />{ops('audit')}</Link>}
      />

      {reviewRelease && reviewManifest ? (
        <AgentReleaseReview listingId={listing.id} release={{
          ...reviewRelease, manifest: reviewManifest, publishedAt: reviewRelease.publishedAt.toISOString(),
          reviewedAt: reviewRelease.reviewedAt?.toISOString() ?? null,
        }} categories={categories} canReview={canReview} />
      ) : reviewRelease ? (
        <AdminPanel
          title={`${ops('review')} v${reviewRelease.version}`}
          description={t('agentInvalidPendingRelease')}
          tone="danger"
        >
          <div className="space-y-4">
            <p className="text-sm text-destructive-text">{t('agentInvalidPendingReleaseDescription')}</p>
            {canReview ? <ConfirmDialog
              label={t('agentRejectRelease')}
              prompt={t('agentRejectReleaseDescription')}
              action={rejectAgentReleaseAction}
              hidden={{ listingId: listing.id, releaseId: reviewRelease.id }}
              pendingLabel={t('agentRejectingRelease')}
              tone="danger"
            /> : <p className="whitespace-pre-wrap break-words text-sm">{ops.has(reviewRelease.reviewStatus) ? ops(reviewRelease.reviewStatus) : reviewRelease.reviewStatus}: {reviewRelease.reviewNote ?? '-'}</p>}
          </div>
        </AdminPanel>
      ) : null}

      {reviewRelease ? <ReleaseChanges before={previousRelease?.manifest ?? null} after={reviewRelease.manifest} /> : null}

      <AgentListingForm
        action={updateAgentListingAction}
        initial={initial}
        categories={categories}
        servers={resources.servers}
        skills={resources.skills}
        configEditable={configEditable}
        submitLabel={t('saveChanges')}
      />

      <AdminPanel
        title={t('agentReleaseHistory')}
        description={t('agentReleaseHistoryDescription')}
        actions={<History className="size-4 text-muted-foreground" />}
        padded={false}
      >
        {listing.releases.length > 0 ? (
          <DashboardTable
            ariaLabel={t('agentReleaseHistory')}
            minWidth="46rem"
            headers={[
              { label: t('agentVersionColumn') },
              { label: t('statusColumn') },
              { label: ops('reviewer') },
              { label: ops('reviewNote') },
              { label: t('agentReleaseChecksum'), className: 'w-full' },
              { label: t('installsColumn'), align: 'right' },
            ]}
          >
            {listing.releases.map((release) => (
              <tr key={release.id}>
                <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums text-foreground">
                  <Link href={adminHref(`/admin/agents/${id}/edit`, { releaseId: release.id, returnTo: backHref })} className="hover:underline" aria-current={release.id === reviewRelease?.id ? 'page' : undefined}>v{release.version}</Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <AdminBadge tone={releaseStatusTone(release.reviewStatus)} dot>
                    {ops.has(release.reviewStatus) ? ops(release.reviewStatus) : release.reviewStatus}
                  </AdminBadge>
                </td>
                <td className="px-4 py-3 text-sm"><span className="block">{release.reviewedBy?.name ?? release.reviewedBy?.email ?? '-'}</span>{release.reviewedAt ? <LogTimestamp date={release.reviewedAt} /> : null}</td>
                <td className="max-w-64 whitespace-pre-wrap break-words px-4 py-3 text-xs">{release.reviewNote ?? '-'}</td>
                <td className="px-4 py-3">
                  <code className="block max-w-xl truncate font-mono text-xs text-muted-foreground">
                    sha256:{release.checksum}
                  </code>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {release._count.installs}
                </td>
              </tr>
            ))}
          </DashboardTable>
        ) : (
          <p className="px-5 py-8 text-sm text-muted-foreground">{t('agentNoReleases')}</p>
        )}
      </AdminPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <AdminPanel
          title={listing.status === 'published' ? t('disableAgentListing') : t('publishAgentListing')}
          description={listing.status === 'published'
            ? t('disableAgentListingDescription')
            : t('publishAgentListingDescription')}
          tone={listing.status === 'published' ? 'danger' : 'default'}
        >
          <ConfirmDialog
            label={listing.status === 'published' ? t('disableAgentListing') : t('publishAgentListing')}
            prompt={listing.status === 'published'
              ? t('disableAgentListingConfirm')
              : t('publishAgentListingConfirm')}
            action={setAgentListingStatusAction}
            hidden={{
              id: listing.id,
              status: listing.status === 'published' ? 'disabled' : 'published',
            }}
            pendingLabel={t('saving')}
            tone={listing.status === 'published' ? 'danger' : 'default'}
          />
        </AdminPanel>

        <AdminPanel
          title={t('dangerZone')}
          description={t('agentDeleteListingDescription', { count: listing.installCount })}
          tone="danger"
        >
          <ConfirmDialog
            label={t('deleteAgentListing')}
            prompt={t('deleteAgentListingConfirm')}
            action={deleteAgentListingAction}
            hidden={{ id: listing.id }}
            pendingLabel={t('deleting')}
            tone="danger"
          />
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
