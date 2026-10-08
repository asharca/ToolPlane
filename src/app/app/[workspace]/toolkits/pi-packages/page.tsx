import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import { PiPackageComposeForm, PiPackagePublishForm } from '@/components/dashboard/market/SkillPublishForm';
import { PublisherControls } from '@/components/dashboard/market/PublisherControls';
import { PiCatalogActionForm } from '@/components/dashboard/market/PiCatalogForms';
import { getCurrentUser } from '@/lib/auth/current-user';
import { db } from '@/lib/db';
import { getDeployments, getInstalledSkills, getWorkspaceForUser } from '@/lib/workspace/queries';
import { getToolkitBySlug, listToolkits } from '@/lib/toolkits/queries';
import { listWorkspacePublishedResources } from '@/lib/market/skills';
import { listPiPackageTracking } from '@/lib/market/pi-package-catalog';
import { readMcpToolCatalog } from '@/lib/process/mcp-tool-catalog';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';

export const dynamic = 'force-dynamic';

export default async function ToolkitPiPackagesPage({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ toolkit?: string; q?: string }>;
}) {
  const [{ workspace: slug }, query, user, t, catalog, toolkitT, common] = await Promise.all([
    params, searchParams, getCurrentUser(), getTranslations('console.market'),
    getTranslations('console.market.piCatalog'), getTranslations('console.toolkits'), getTranslations('common'),
  ]);
  const base = `/app/${encodeURIComponent(slug)}`;
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`${base}/toolkits/pi-packages`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const [deployments, skills, toolkits, listings, categories, membership, tracking, toolkit] = await Promise.all([
    getDeployments(workspace.id), getInstalledSkills(workspace.id), listToolkits(workspace.id),
    listWorkspacePublishedResources(workspace.id),
    db.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    workspace.ownerId === user.id ? null : db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, select: { role: true } }),
    listPiPackageTracking({ workspaceId: workspace.id, userId: user.id }),
    query.toolkit ? getToolkitBySlug(workspace.id, query.toolkit) : null,
  ]);
  if (query.toolkit && !toolkit) notFound();
  const canPublish = workspace.ownerId === user.id || membership?.role === 'admin';
  const selectedSkills = new Set(toolkit?.skills.map(({ installedSkill }) => installedSkill.id));
  const selectedDeployments = new Set(toolkit?.servers.map(({ deployment }) => deployment.id));
  const options = {
    skills: skills.map((skill) => ({ id: skill.id, name: skillLabel(skill).name })),
    deployments: deployments.map((deployment) => ({
      id: deployment.id, name: deploymentLabel(deployment).name,
      tools: readMcpToolCatalog(deployment.installCfg)
        .filter((tool) => deployment.mcpToolExposure !== 'allowlist' || deployment.mcpAllowedTools.includes(tool.name))
        .map((tool) => tool.name),
    })),
  };
  const prefilledOptions = {
    skills: options.skills.map((skill) => ({ ...skill, selected: selectedSkills.has(skill.id) })),
    deployments: options.deployments.map((deployment) => ({ ...deployment, selected: selectedDeployments.has(deployment.id) })),
  };
  const search = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
  const trackingByListing = new Map(tracking.map((row) => [row.listingId, row]));
  const piListings = listings.filter((listing) => listing.kind === 'pi-package'
    && !(listing.metadata && typeof listing.metadata === 'object' && !Array.isArray(listing.metadata) && typeof listing.metadata.officialPiPackageName === 'string')
    && (!search || `${listing.name} ${listing.slug}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const labels = {
    withdraw: t('withdrawSubmission'), withdrawing: t('withdrawingSubmission'), withdrawConfirm: t('withdrawSubmissionConfirm'),
    unpublish: t('unpublishListing'), unpublishing: t('unpublishingListing'), unpublishConfirm: t('unpublishListingConfirm'), cancel: common('cancel'),
  };
  return <DashboardPage className="space-y-6">
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">{toolkitT('piPackagesTitle')}</h1>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{toolkitT('piPackagesHelp')}</p>
      <nav className="flex flex-wrap gap-2" aria-label={catalog('navigation')}>
        <ButtonLink variant="ghost" size="sm" href={`${base}/toolkits`}>{toolkitT('toolkits')}</ButtonLink>
        <ButtonLink variant="secondary" size="sm" href={`${base}/toolkits/pi-packages/sources`}>{catalog('sourcesTitle')}</ButtonLink>
        <ButtonLink variant="ghost" size="sm" href={`${base}/market/pi-packages`}>{toolkitT('browseMarket')}</ButtonLink>
      </nav>
    </div>
    <section id="compose" className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{toolkitT('newPiPackage')}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{t('piComposeDescription')}</p>
      <form className="flex flex-wrap items-end gap-3" action={`${base}/toolkits/pi-packages#compose`}>
        <label className="space-y-1 text-sm"><span className="block">{toolkitT('packageExistingToolkit')}</span>
          <select name="toolkit" defaultValue={toolkit?.slug ?? ''} className="rounded-md border border-border bg-background p-2">
            <option value="">{toolkitT('newPiPackage')}</option>
            {toolkits.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary" size="sm">{toolkitT('loadToolkitSelection')}</Button>
      </form>
      {toolkit ? <p className="text-sm text-muted-foreground">{toolkitT('packageToolkitUnchanged', { name: toolkit.name })}</p> : null}
      <PiPackageComposeForm key={toolkit?.id ?? 'new'} workspace={slug} canPublish={canPublish} categories={categories} options={prefilledOptions} resource={toolkit ? { id: toolkit.id, name: toolkit.name, slug: toolkit.slug, description: null } : undefined} />
    </section>
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{t('piPublishTitle')}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{t('piSourceHelp')}</p>
      <PiPackagePublishForm workspace={slug} canPublish={canPublish} categories={categories} />
    </section>
    <section className="space-y-4">
      <h2 className="font-semibold">{catalog('workspacePackages')}</h2>
      <form className="flex flex-wrap gap-2"><Input name="q" label={catalog('search')} defaultValue={search} maxLength={200} className="min-w-0 flex-1" /><Button type="submit" variant="secondary" size="sm">{catalog('search')}</Button></form>
      <PiCatalogActionForm workspace={slug} operation="check" label={catalog('checkAll')} />
      {!piListings.length ? <p className="text-sm text-muted-foreground">{catalog('workspaceEmptyHelp')}</p> : piListings.map((listing) => {
        const tracked = trackingByListing.get(listing.id);
        const defaults = { name: listing.name, slug: listing.slug, summary: listing.summary, tags: listing.tags, categoryIds: listing.categories.map(({ id }) => id) };
        const visibility = listing.visibility === 'public' ? 'public' : 'private';
        return <article id={`package-${listing.id}`} key={listing.id} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{listing.name}</h3><span className="text-xs text-muted-foreground">{catalog(visibility)}</span></div>
          <p className="text-sm text-muted-foreground">{listing.summary}</p>
          <p className="text-sm text-muted-foreground">{listing.pendingRelease ? t('publicationPending', { version: listing.pendingRelease.version }) : listing.status === 'disabled' ? t('publicationDisabled') : listing.latestRelease ? t('publicationPublished', { version: listing.latestRelease.version }) : t('publicationNotPublished')}</p>
          {listing.releases[0]?.reviewStatus === 'rejected' ? <p className="text-sm text-destructive">{t('piReviewRejected')}</p> : null}
          {listing.releases[0]?.reviewNote ? <p className="text-sm text-muted-foreground">{listing.releases[0].reviewNote}</p> : null}
          <PiPackagePublishForm workspace={slug} listingId={listing.id} listing={defaults} canPublish={canPublish} categories={categories} visibility={visibility} />
          <PiPackageComposeForm workspace={slug} listingId={listing.id} listing={defaults} canPublish={canPublish} categories={categories} visibility={visibility} options={options} />
          {listing.latestRelease ? <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/api/v1/workspaces/${encodeURIComponent(slug)}/market/pi-packages/${encodeURIComponent(listing.latestRelease.id)}/download`} variant="secondary" size="sm">{t('piArtifactDownload')}</ButtonLink>
            {listing.status === 'published' ? <ButtonLink variant="ghost" size="sm" href={`${base}/market/items/${encodeURIComponent(listing.namespace)}/${encodeURIComponent(listing.slug)}`}>{catalog('reviewInstall')}</ButtonLink> : null}
          </div> : null}
          <PublisherControls listing={listing} workspace={slug} canPublish={canPublish} labels={labels} />
          {tracked ? <div className="space-y-3 border-t border-border pt-3">
            <p className="break-all text-xs text-muted-foreground">{catalog('trackedSource')}: {tracked.requested}</p>
            <p className="text-xs text-muted-foreground">{catalog(`trackingMode.${tracked.mode}`)} · {catalog(`trackingStatus.${tracked.status}`)}</p>
            <p className="text-sm text-muted-foreground">{catalog('latestUpstream')}: {tracked.latestVersion ?? tracked.latestIdentity ?? catalog('notChecked')}</p>
            <p className="text-xs text-muted-foreground">{catalog('lastChecked')}: {tracked.checkedAt ? new Date(tracked.checkedAt).toISOString() : catalog('notChecked')}</p>
            {tracked.status === 'error' || tracked.status === 'suspicious' ? <p role="alert" className="text-sm text-destructive">{catalog(tracked.status === 'suspicious' ? 'suspicious' : 'checkFailed')}</p> : null}
            <div className="flex flex-wrap gap-4">
              <PiCatalogActionForm workspace={slug} operation="check" label={catalog('checkOne')} values={{ listingId: listing.id }} />
              {canPublish && tracked.latestIdentity && tracked.status === 'update_available' ? <PiCatalogActionForm workspace={slug} operation="ignore" label={catalog('dismissVersion')} values={{ listingId: listing.id, identity: tracked.latestIdentity }} /> : null}
              {canPublish ? <PiCatalogActionForm workspace={slug} operation="capture" label={catalog('captureNew')} values={{ listingId: listing.id }} capture /> : null}
            </div>
            <p className="text-xs text-muted-foreground">{catalog('trackingHelp')}</p>
          </div> : <p className="text-xs text-muted-foreground">{catalog('notTracked')}</p>}
        </article>;
      })}
    </section>
  </DashboardPage>;
}
