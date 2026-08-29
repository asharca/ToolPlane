import 'server-only';

import { db } from '@/lib/db';

export async function listWorkspaceMarketCopies(workspaceId: string) {
  const [agentInstalls, assistants] = await Promise.all([
    db.agentInstall.findMany({
      where: { targetWorkspaceId: workspaceId, agentId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        agent: { select: { id: true, name: true, runtimeKind: true } },
        release: {
          select: {
            id: true,
            version: true,
            listing: {
              select: {
                id: true,
                name: true,
                publisherKind: true,
                publisherWorkspaceId: true,
                status: true,
                publishedAt: true,
                latestRelease: { select: { id: true, version: true, reviewStatus: true } },
              },
            },
          },
        },
      },
    }),
    db.chatAssistant.findMany({
      where: { workspaceId, marketTemplateReleaseId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        marketTemplateRelease: {
          select: {
            id: true,
            version: true,
            listing: {
              select: {
                id: true,
                kind: true,
                namespace: true,
                slug: true,
                name: true,
                status: true,
                latestRelease: {
                  select: { id: true, version: true, reviewStatus: true, releaseNotes: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  return {
    agents: agentInstalls.flatMap((install) => {
      if (!install.agent) return [];
      const listing = install.release.listing;
      const latest = listing.latestRelease;
      const visibleOrigin = listing.publisherKind === 'platform' || Boolean(listing.publisherWorkspaceId);
      return [{
        kind: 'agent' as const,
        id: install.id,
        resourceId: install.agent.id,
        name: install.agent.name,
        sourceDetail: install.agent.runtimeKind,
        status: install.status,
        updatedAt: install.updatedAt,
        currentReleaseId: install.release.id,
        currentVersion: install.release.version,
        listingId: listing.id,
        latestReleaseId: latest?.id ?? null,
        latestVersion: latest?.version ?? null,
        releaseNotes: null,
        updateAvailable: Boolean(
          listing.status === 'published'
          && listing.publishedAt
          && visibleOrigin
          && latest?.reviewStatus === 'approved'
          && latest.id !== install.release.id,
        ),
      }];
    }),
    assistants: assistants.flatMap((assistant) => {
      const release = assistant.marketTemplateRelease;
      if (!release || release.listing.kind !== 'assistant') return [];
      const listing = release.listing;
      const latest = listing.latestRelease;
      return [{
        kind: 'assistant' as const,
        id: assistant.id,
        resourceId: assistant.id,
        name: assistant.name,
        sourceDetail: `${listing.namespace}/${listing.slug}`,
        status: 'ready',
        updatedAt: assistant.updatedAt,
        currentReleaseId: release.id,
        currentVersion: release.version,
        listingId: listing.id,
        latestReleaseId: latest?.id ?? null,
        latestVersion: latest?.version ?? null,
        releaseNotes: latest?.releaseNotes ?? null,
        updateAvailable: Boolean(
          listing.status === 'published'
          && latest?.reviewStatus === 'approved'
          && latest.id !== release.id,
        ),
      }];
    }),
  };
}
