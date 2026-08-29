import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowUpRight, Bot, Brain, EyeOff, MessageSquare, Plug, Undo2, Upload, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listAgents } from '@/lib/agents/queries';
import { listChatAssistantsForWorkspace } from '@/lib/chat/service';
import { db } from '@/lib/db';
import { listWorkspacePublishedResources } from '@/lib/market/skills';
import { listToolkits } from '@/lib/toolkits/queries';
import {
  getDeployments,
  getInstalledSkills,
  getWorkspaceForUser,
} from '@/lib/workspace/queries';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardEmptyState, DashboardPage } from '@/components/dashboard/DashboardUI';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import {
  AssistantPublishForm,
  McpPublishForm,
  SkillPublishForm,
  ToolkitPublishForm,
} from '@/components/dashboard/market/SkillPublishForm';
import {
  unpublishMarketListingAction,
  withdrawMarketReleaseAction,
} from '@/lib/market/actions';

export const dynamic = 'force-dynamic';

type ListingStatus = {
  id?: string;
  status: string;
  latestVersion: number;
  latestRelease: { version: number } | null;
  pendingRelease: { version: number; reviewStatus: string } | null;
};

function PublisherControls({
  listing,
  workspace,
  canPublish,
  labels,
}: {
  listing: ListingStatus | undefined;
  workspace: string;
  canPublish: boolean;
  labels: {
    withdraw: string;
    withdrawing: string;
    withdrawConfirm: string;
    unpublish: string;
    unpublishing: string;
    unpublishConfirm: string;
    cancel: string;
  };
}) {
  if (!listing?.id || !canPublish) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2 sm:col-span-4">
      {listing.pendingRelease?.reviewStatus === 'pending' ? (
        <form action={withdrawMarketReleaseAction}>
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="listingId" value={listing.id} />
          <ConfirmSubmitButton
            triggerLabel={<><Undo2 className="size-3.5" />{labels.withdraw}</>}
            prompt={labels.withdrawConfirm}
            confirmLabel={labels.withdraw}
            pendingLabel={labels.withdrawing}
            cancelLabel={labels.cancel}
            triggerClassName="ui-button-ghost h-8 px-2 text-xs"
            confirmClassName="ui-button-primary h-8 px-2.5 text-xs"
            cancelClassName="ui-button-ghost h-8 px-2 text-xs"
            promptClassName="max-w-72 text-xs text-muted-foreground"
          />
        </form>
      ) : null}
      {listing.status === 'published' && listing.latestRelease ? (
        <form action={unpublishMarketListingAction}>
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="listingId" value={listing.id} />
          <ConfirmSubmitButton
            triggerLabel={<><EyeOff className="size-3.5" />{labels.unpublish}</>}
            prompt={labels.unpublishConfirm}
            confirmLabel={labels.unpublish}
            pendingLabel={labels.unpublishing}
            cancelLabel={labels.cancel}
            triggerClassName="ui-button-ghost h-8 px-2 text-xs text-red-600 dark:text-red-400"
            confirmClassName="ui-button-primary ui-button-danger h-8 px-2.5 text-xs"
            cancelClassName="ui-button-ghost h-8 px-2 text-xs"
            promptClassName="max-w-72 text-xs text-muted-foreground"
          />
        </form>
      ) : null}
    </div>
  );
}

function publicationTone(listing: ListingStatus | undefined) {
  if (listing?.pendingRelease?.reviewStatus === 'pending') return 'bg-amber-500';
  if (listing?.status === 'published' && listing.latestRelease) return 'bg-emerald-500';
  if (listing?.status === 'disabled') return 'bg-red-500';
  return 'bg-zinc-400';
}

function resourceSlug(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'assistant';
}

export default async function MarketPublishPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, t, common, user] = await Promise.all([
    params,
    getTranslations('console.market'),
    getTranslations('common'),
    getCurrentUser(),
  ]);
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/publish`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const [deployments, skills, toolkits, agents, assistants, listings, marketCategories, membership] = await Promise.all([
    getDeployments(workspace.id),
    getInstalledSkills(workspace.id),
    listToolkits(workspace.id),
    listAgents(workspace.id),
    listChatAssistantsForWorkspace(workspace.id),
    listWorkspacePublishedResources(workspace.id),
    db.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    workspace.ownerId === user.id
      ? Promise.resolve(null)
      : db.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
        select: { role: true },
      }),
  ]);
  const agentListings = agents.length > 0
    ? await db.agentListing.findMany({
      where: { publisherWorkspaceId: workspace.id, sourceAgentId: { in: agents.map((agent) => agent.id) } },
      select: {
        sourceAgentId: true,
        status: true,
        latestVersion: true,
        latestRelease: { select: { version: true } },
        pendingRelease: { select: { version: true, reviewStatus: true } },
      },
    })
    : [];
  const canPublish = workspace.ownerId === user.id || membership?.role === 'admin';
  const base = `/app/${encodeURIComponent(workspace.slug)}`;
  const listingByDeployment = new Map(listings.flatMap((item) => item.sourceDeploymentId ? [[item.sourceDeploymentId, item]] : []));
  const listingBySkill = new Map(listings.flatMap((item) => item.sourceInstalledSkillId ? [[item.sourceInstalledSkillId, item]] : []));
  const listingByToolkit = new Map(listings.flatMap((item) => item.sourceToolkitId ? [[item.sourceToolkitId, item]] : []));
  const listingByAssistant = new Map(listings.flatMap((item) => item.sourceChatAssistantId ? [[item.sourceChatAssistantId, item]] : []));
  const agentListingByAgent = new Map(agentListings.flatMap((item) => item.sourceAgentId ? [[item.sourceAgentId, item]] : []));
  const total = deployments.length + skills.length + toolkits.length + agents.length + assistants.length;

  const publicationLabel = (listing: ListingStatus | undefined) => {
    if (listing?.pendingRelease?.reviewStatus === 'pending') {
      return t('publicationPending', { version: listing.pendingRelease.version });
    }
    if (listing?.status === 'published' && listing.latestRelease) {
      return t('publicationPublished', { version: listing.latestRelease.version });
    }
    if (listing?.status === 'disabled') return t('publicationDisabled');
    return t('publicationNotPublished');
  };
  const publisherControlLabels = {
    withdraw: t('withdrawSubmission'),
    withdrawing: t('withdrawingSubmission'),
    withdrawConfirm: t('withdrawSubmissionConfirm'),
    unpublish: t('unpublishListing'),
    unpublishing: t('unpublishingListing'),
    unpublishConfirm: t('unpublishListingConfirm'),
    cancel: common('cancel'),
  };

  return (
    <DashboardPage className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t('publishTitle')}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t('publishDescription')}
        </p>
        {!canPublish ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('publishRequiresManager')}</p>
        ) : null}
      </div>

      {total === 0 ? (
        <DashboardEmptyState
          icon={Upload}
          title={t('publishEmptyTitle')}
          description={t('publishEmptyDescription')}
          actions={<Link href={`${base}/market/mcp`} className="ui-button-primary">{t('browseMcp')}</Link>}
        />
      ) : (
        <section aria-label={t('publishManagement')} className="space-y-1">
          {deployments.map((deployment) => {
            const label = deploymentLabel(deployment);
            const listing = listingByDeployment.get(deployment.id);
            return (
              <article key={`mcp-${deployment.id}`} className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(15rem,1.5fr)_8rem_minmax(12rem,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><Plug className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{label.name}</p><p className="truncate text-xs text-muted-foreground">{label.source}</p></div>
                </div>
                <span className="text-xs text-muted-foreground">{t('mcp')}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${publicationTone(listing)}`} />{publicationLabel(listing)}</span>
                <Link href={`${base}/mcp/${deployment.id}`} className="ui-button-ghost h-8 px-2 text-xs sm:justify-self-end">{t('manage')} <ArrowUpRight className="size-3.5" /></Link>
                {deployment.serverId && !listing ? (
                  <span className="text-xs text-muted-foreground sm:col-span-4 sm:text-right">{t('catalogAlreadyListed')}</span>
                ) : ['npm', 'pypi', 'github', 'docker'].includes(deployment.source ?? '') ? (
                  <McpPublishForm
                    workspace={workspace.slug}
                    mcp={{
                      id: deployment.id,
                      name: label.name,
                      slug: resourceSlug(label.name),
                      description: null,
                    }}
                    listing={listing ? {
                      name: listing.name,
                      slug: listing.slug,
                      summary: listing.summary,
                      tags: listing.tags,
                      categoryIds: listing.categories.map(({ id }) => id),
                    } : undefined}
                    canPublish={canPublish}
                    categories={marketCategories}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground sm:col-span-4 sm:text-right">{t('mcpNotPortable')}</span>
                )}
                <PublisherControls listing={listing} workspace={workspace.slug} canPublish={canPublish} labels={publisherControlLabels} />
              </article>
            );
          })}

          {skills.map((skill) => {
            const label = skillLabel(skill);
            const listing = listingBySkill.get(skill.id);
            return (
              <article key={`skill-${skill.id}`} className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(15rem,1.5fr)_8rem_minmax(12rem,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><Brain className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{label.name}</p><p className="truncate text-xs text-muted-foreground">{label.source}</p></div>
                </div>
                <span className="text-xs text-muted-foreground">{t('skills')}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${publicationTone(listing)}`} />{publicationLabel(listing)}</span>
                <Link href={`${base}/skills/${skill.id}`} className="ui-button-ghost h-8 px-2 text-xs sm:justify-self-end">{t('manage')} <ArrowUpRight className="size-3.5" /></Link>
                <SkillPublishForm
                  workspace={workspace.slug}
                  skill={{
                    id: skill.id,
                    name: label.name,
                    slug: label.slug,
                    description: skill.description ?? skill.skill?.description ?? null,
                  }}
                  listing={listing ? {
                    name: listing.name,
                    slug: listing.slug,
                    summary: listing.summary,
                    tags: listing.tags,
                    categoryIds: listing.categories.map(({ id }) => id),
                  } : undefined}
                  canPublish={canPublish}
                  categories={marketCategories}
                />
                <PublisherControls listing={listing} workspace={workspace.slug} canPublish={canPublish} labels={publisherControlLabels} />
              </article>
            );
          })}

          {agents.map((agent) => {
            const listing = agentListingByAgent.get(agent.id);
            return (
              <article key={`agent-${agent.id}`} className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(15rem,1.5fr)_8rem_minmax(12rem,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><Bot className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{agent.name}</p><p className="truncate text-xs text-muted-foreground">{agent.runtimeKind}</p></div>
                </div>
                <span className="text-xs text-muted-foreground">{t('agents')}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${publicationTone(listing)}`} />{publicationLabel(listing)}</span>
                <Link href={`${base}/agents/${agent.id}/publish`} className="ui-button-secondary h-8 px-2.5 text-xs sm:justify-self-end">{listing ? t('manageListing') : t('publishToMarket')} <ArrowUpRight className="size-3.5" /></Link>
              </article>
            );
          })}

          {assistants.map((assistant) => {
            const listing = listingByAssistant.get(assistant.id);
            return (
              <article key={`assistant-${assistant.id}`} className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(15rem,1.5fr)_8rem_minmax(12rem,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><MessageSquare className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{assistant.name}</p><p className="truncate text-xs text-muted-foreground">{assistant.model ?? t('sourceWorkspace')}</p></div>
                </div>
                <span className="text-xs text-muted-foreground">{t('assistants')}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${publicationTone(listing)}`} />{publicationLabel(listing)}</span>
                <Link href={`${base}/chat?assistant=${assistant.id}`} className="ui-button-ghost h-8 px-2 text-xs sm:justify-self-end">{t('manage')} <ArrowUpRight className="size-3.5" /></Link>
                <AssistantPublishForm
                  workspace={workspace.slug}
                  assistant={{
                    id: assistant.id,
                    name: assistant.name,
                    slug: resourceSlug(assistant.name),
                    description: assistant.systemPrompt?.slice(0, 4_000) ?? null,
                  }}
                  listing={listing ? {
                    name: listing.name,
                    slug: listing.slug,
                    summary: listing.summary,
                    tags: listing.tags,
                    categoryIds: listing.categories.map(({ id }) => id),
                  } : undefined}
                  canPublish={canPublish}
                  categories={marketCategories}
                />
                <PublisherControls listing={listing} workspace={workspace.slug} canPublish={canPublish} labels={publisherControlLabels} />
              </article>
            );
          })}

          {toolkits.map((toolkit) => {
            const listing = listingByToolkit.get(toolkit.id);
            return (
              <article key={`toolkit-${toolkit.id}`} className="grid gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(15rem,1.5fr)_8rem_minmax(12rem,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><Wrench className="size-4" /></span>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{toolkit.name}</p><p className="truncate text-xs text-muted-foreground">{t('sourceWorkspace')}</p></div>
                </div>
                <span className="text-xs text-muted-foreground">{t('toolkits')}</span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${publicationTone(listing)}`} />{publicationLabel(listing)}</span>
                <Link href={`${base}/toolkits/${toolkit.slug}`} className="ui-button-ghost h-8 px-2 text-xs sm:justify-self-end">{t('manage')} <ArrowUpRight className="size-3.5" /></Link>
                <ToolkitPublishForm
                  workspace={workspace.slug}
                  toolkit={{ id: toolkit.id, name: toolkit.name, slug: toolkit.slug, description: null }}
                  listing={listing ? {
                    name: listing.name,
                    slug: listing.slug,
                    summary: listing.summary,
                    tags: listing.tags,
                    categoryIds: listing.categories.map(({ id }) => id),
                  } : undefined}
                  canPublish={canPublish}
                  categories={marketCategories}
                />
                <PublisherControls listing={listing} workspace={workspace.slug} canPublish={canPublish} labels={publisherControlLabels} />
              </article>
            );
          })}
        </section>
      )}
    </DashboardPage>
  );
}
