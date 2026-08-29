// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  unpublishMarketListing,
  withdrawMarketRelease,
} from '@/lib/market/publisher-management';

const stamp = `${process.pid}-${Date.now()}`;
let ownerId = '';
let outsiderId = '';
let workspaceId = '';
let serverId = '';
let toolkitId = '';

describe.sequential('market publisher management', () => {
  beforeAll(async () => {
    const [owner, outsider] = await Promise.all([
      db.user.create({ data: { email: `publisher-${stamp}@test.dev`, passwordHash: 'x' } }),
      db.user.create({ data: { email: `publisher-outsider-${stamp}@test.dev`, passwordHash: 'x' } }),
    ]);
    ownerId = owner.id;
    outsiderId = outsider.id;
    const workspace = await db.workspace.create({
      data: { slug: `publisher-${stamp}`, name: 'Publisher', ownerId: owner.id },
    });
    workspaceId = workspace.id;
    const [server, toolkit] = await Promise.all([
      db.server.create({
        data: {
          slug: `publisher-mcp-${stamp}`,
          name: 'Publisher MCP',
          verifiedAt: new Date(),
          installCfg: { source: 'npm', ref: '@modelcontextprotocol/server-everything', env: [] },
        },
      }),
      db.toolkit.create({
        data: { workspaceId: workspace.id, slug: 'publisher-toolkit', name: 'Publisher toolkit', visibility: 'public' },
      }),
    ]);
    serverId = server.id;
    toolkitId = toolkit.id;
  });

  afterAll(async () => {
    await db.marketListing.deleteMany({ where: { publisherWorkspaceId: workspaceId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.server.deleteMany({ where: { id: serverId } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  });

  it('lets only the publisher withdraw a pending release', async () => {
    const listing = await db.marketListing.create({
      data: {
        kind: 'assistant', namespace: `publisher-${stamp}`, slug: 'pending', name: 'Pending',
        metadata: {}, publisherWorkspaceId: workspaceId,
      },
    });
    const release = await db.marketRelease.create({
      data: { listingId: listing.id, version: 1, manifest: {}, releaseSummary: {}, checksum: 'pending' },
    });
    await db.marketListing.update({
      where: { id: listing.id },
      data: { latestVersion: 1, pendingReleaseId: release.id },
    });

    await expect(withdrawMarketRelease({
      workspaceId, listingId: listing.id, actorId: outsiderId,
    })).rejects.toMatchObject({ code: 'not_authorized' });
    await withdrawMarketRelease({ workspaceId, listingId: listing.id, actorId: ownerId });

    const [updatedListing, updatedRelease] = await Promise.all([
      db.marketListing.findUniqueOrThrow({ where: { id: listing.id } }),
      db.marketRelease.findUniqueOrThrow({ where: { id: release.id } }),
    ]);
    expect(updatedListing).toMatchObject({ status: 'draft', pendingReleaseId: null });
    expect(updatedRelease).toMatchObject({ reviewStatus: 'rejected', reviewNote: 'Withdrawn by the publisher.' });
  });

  it('unpublishes reviewed MCP and toolkit identities and cancels pending updates', async () => {
    const mcpListing = await db.marketListing.create({
      data: {
        kind: 'mcp', namespace: `publisher-${stamp}`, slug: 'mcp', name: 'MCP', metadata: {},
        publisherWorkspaceId: workspaceId, sourceServerId: serverId, status: 'published',
      },
    });
    const [mcpRelease, pendingRelease] = await Promise.all([
      db.marketRelease.create({
        data: { listingId: mcpListing.id, version: 1, manifest: {}, releaseSummary: {}, checksum: 'mcp-1', reviewStatus: 'approved' },
      }),
      db.marketRelease.create({
        data: { listingId: mcpListing.id, version: 2, manifest: {}, releaseSummary: {}, checksum: 'mcp-2' },
      }),
    ]);
    await db.marketListing.update({
      where: { id: mcpListing.id },
      data: { latestVersion: 2, latestReleaseId: mcpRelease.id, pendingReleaseId: pendingRelease.id },
    });
    const toolkitListing = await db.marketListing.create({
      data: {
        kind: 'toolkit', namespace: `publisher-${stamp}`, slug: 'toolkit', name: 'Toolkit', metadata: {},
        publisherWorkspaceId: workspaceId, sourceToolkitId: toolkitId, status: 'published',
      },
    });
    const toolkitRelease = await db.marketRelease.create({
      data: { listingId: toolkitListing.id, version: 1, manifest: {}, releaseSummary: {}, checksum: 'toolkit-1', reviewStatus: 'approved' },
    });
    await db.marketListing.update({
      where: { id: toolkitListing.id },
      data: { latestVersion: 1, latestReleaseId: toolkitRelease.id },
    });

    await unpublishMarketListing({ workspaceId, listingId: mcpListing.id, actorId: ownerId });
    await unpublishMarketListing({ workspaceId, listingId: toolkitListing.id, actorId: ownerId });

    const [mcp, pending, server, toolkit] = await Promise.all([
      db.marketListing.findUniqueOrThrow({ where: { id: mcpListing.id } }),
      db.marketRelease.findUniqueOrThrow({ where: { id: pendingRelease.id } }),
      db.server.findUniqueOrThrow({ where: { id: serverId } }),
      db.toolkit.findUniqueOrThrow({ where: { id: toolkitId } }),
    ]);
    expect(mcp).toMatchObject({ status: 'disabled', pendingReleaseId: null });
    expect(pending.reviewStatus).toBe('rejected');
    expect(server.verifiedAt).toBeNull();
    expect(toolkit.enabled).toBe(false);
  });
});
