// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  AdminAgentMarketError,
  approvePendingAgentRelease,
  createDirectoryAgentTemplate,
  deleteDirectoryAgentListing,
  getDirectoryAgentListing,
  listDirectoryAgentListings,
  rejectPendingAgentRelease,
  setDirectoryAgentListingStatus,
  updateDirectoryAgentListing,
} from '@/lib/admin/agent-market';
import {
  AGENT_MARKET_MANIFEST_VERSION,
  agentReleaseChecksum,
  buildCatalogAgentManifest,
  materializeAgentRelease,
  summarizeAgentReleaseManifest,
} from '@/lib/agents/market';

const stamp = `${process.pid}-${Date.now()}`;
const directorySlug = `admin-agent-${stamp}`;

let adminId = '';
let categoryId = '';
let listingId = '';
let targetUserId = '';
let targetWorkspaceId = '';

describe.sequential('admin agent directory management', () => {
  beforeAll(async () => {
    const [admin, targetUser] = await Promise.all([
      db.user.create({
        data: {
          email: `admin-agent-reviewer-${stamp}@test.dev`,
          passwordHash: 'x',
          role: 'admin',
        },
      }),
      db.user.create({
        data: { email: `admin-agent-installer-${stamp}@test.dev`, passwordHash: 'x' },
      }),
    ]);
    adminId = admin.id;
    targetUserId = targetUser.id;
    const [category, workspace] = await Promise.all([
      db.category.create({
        data: { slug: `admin-agent-category-${stamp}`, name: `Admin Agent ${stamp}` },
      }),
      db.workspace.create({
        data: {
          slug: `admin-agent-target-${stamp}`,
          name: 'Admin Agent Target',
          ownerId: targetUser.id,
        },
      }),
    ]);
    categoryId = category.id;
    targetWorkspaceId = workspace.id;
  });

  afterAll(async () => {
    if (targetWorkspaceId) {
      await db.workspace.deleteMany({ where: { id: targetWorkspaceId } });
    }
    if (listingId) {
      await db.agentListing.deleteMany({ where: { id: listingId } });
    }
    if (categoryId) await db.category.deleteMany({ where: { id: categoryId } });
    if (adminId || targetUserId) {
      await db.user.deleteMany({ where: { id: { in: [adminId, targetUserId].filter(Boolean) } } });
    }
    await db.$disconnect();
  });

  it('creates a curated administrator template with an approved immutable release', async () => {
    const created = await createDirectoryAgentTemplate({
      directorySlug,
      name: 'Admin Research Agent',
      author: 'ToolPlane',
      summary: 'A centrally managed directory template.',
      iconUrl: null,
      tags: ['Research', ' research ', 'Writing'],
      curated: true,
      isFeatured: true,
      categoryIds: [categoryId],
      status: 'published',
      systemPrompt: 'Research carefully and cite evidence.',
      maxSteps: 12,
      modelFormat: 'openai',
      model: 'gpt-5',
      serverIds: [],
      skillIds: [],
    }, adminId);
    listingId = created.id;

    const listing = await getDirectoryAgentListing(listingId);
    expect(listing).toMatchObject({
      directorySlug,
      name: 'Admin Research Agent',
      author: 'ToolPlane',
      publisherWorkspaceId: null,
      publishedById: null,
      curated: true,
      isFeatured: true,
      status: 'published',
      latestVersion: 1,
    });
    expect(listing?.tags).toEqual(['research', 'writing']);
    expect(listing?.categories.map(({ id }) => id)).toEqual([categoryId]);
    expect(listing?.latestRelease).toMatchObject({
      id: created.releaseId,
      version: 1,
      reviewStatus: 'approved',
      reviewedById: adminId,
      name: 'Admin Research Agent',
    });
  });

  it('lists and searches directory agents with pagination metadata and status filtering', async () => {
    const found = await listDirectoryAgentListings({ q: directorySlug, status: 'published' });
    expect(found.page).toBe(1);
    expect(found.pageSize).toBe(25);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: listingId, directorySlug });

    const hiddenByStatus = await listDirectoryAgentListings({ q: directorySlug, status: 'disabled' });
    expect(hiddenByStatus.items).toHaveLength(0);
  });

  it('updates metadata and configuration by appending an approved release', async () => {
    const updated = await updateDirectoryAgentListing(listingId, {
      directorySlug,
      name: 'Admin Research Agent 2',
      author: 'ToolPlane Directory',
      summary: 'Updated safely by an administrator.',
      iconUrl: 'https://example.test/agent.png',
      tags: ['research', 'reviewed'],
      curated: true,
      isFeatured: false,
      categoryIds: [categoryId],
      status: 'published',
      config: {
        systemPrompt: 'Updated immutable instructions.',
        maxSteps: 18,
        modelFormat: 'anthropic',
        model: 'claude-test',
        serverIds: [],
        skillIds: [],
      },
    }, adminId);
    expect(updated.status).toBe('published');

    const listing = await getDirectoryAgentListing(listingId);
    expect(listing).toMatchObject({
      name: 'Admin Research Agent 2',
      author: 'ToolPlane Directory',
      isFeatured: false,
      latestVersion: 2,
    });
    expect(listing?.releases.map(({ version }) => version)).toEqual([2, 1]);
    expect(listing?.latestRelease).toMatchObject({
      version: 2,
      reviewStatus: 'approved',
      reviewedById: adminId,
    });
  });

  it('approves a pending release atomically and copies its public metadata', async () => {
    const pending = await db.$transaction(async (tx) => {
      const manifest = await buildCatalogAgentManifest(tx, {
        name: 'Publisher Rename',
        slug: directorySlug,
        systemPrompt: 'Pending publisher instructions.',
        maxSteps: 9,
      });
      const release = await tx.agentRelease.create({
        data: {
          listingId,
          version: 3,
          manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
          manifest: manifest as Prisma.InputJsonValue,
          releaseSummary: summarizeAgentReleaseManifest(manifest) as Prisma.InputJsonValue,
          checksum: agentReleaseChecksum(manifest),
          name: 'Publisher Rename',
          summary: 'Pending summary',
          iconUrl: null,
          tags: ['pending'],
          reviewStatus: 'pending',
        },
      });
      await tx.agentListing.update({
        where: { id: listingId },
        data: { pendingReleaseId: release.id, latestVersion: 3 },
      });
      return release;
    });

    await approvePendingAgentRelease({
      listingId,
      releaseId: pending.id,
      reviewedById: adminId,
      reviewNote: 'Reviewed and approved.',
    });
    const listing = await getDirectoryAgentListing(listingId);
    expect(listing).toMatchObject({
      name: 'Publisher Rename',
      summary: 'Pending summary',
      tags: ['pending'],
      latestReleaseId: pending.id,
      pendingReleaseId: null,
      latestVersion: 3,
      status: 'published',
    });
    expect(listing?.latestRelease).toMatchObject({
      reviewStatus: 'approved',
      reviewedById: adminId,
      reviewNote: 'Reviewed and approved.',
    });
    const replacedRelease = await db.agentRelease.findFirstOrThrow({
      where: { listingId, version: 2 },
      select: { id: true },
    });
    await expect(materializeAgentRelease({
      releaseId: replacedRelease.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `replaced-release-${stamp}`,
    })).rejects.toMatchObject({ code: 'listing_unavailable' });
  });

  it('rejects a pending release without replacing the approved release', async () => {
    const before = await db.agentListing.findUniqueOrThrow({
      where: { id: listingId },
      select: { latestReleaseId: true },
    });
    const approvedRelease = await db.agentRelease.findUniqueOrThrow({
      where: { id: before.latestReleaseId! },
      select: { manifest: true, releaseSummary: true, checksum: true },
    });
    const rejected = await db.agentRelease.create({
      data: {
        listingId,
        version: 4,
        manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
        manifest: approvedRelease.manifest as Prisma.InputJsonValue,
        releaseSummary: approvedRelease.releaseSummary as Prisma.InputJsonValue,
        checksum: approvedRelease.checksum,
        name: 'Rejected Rename',
        summary: null,
        reviewStatus: 'pending',
      },
    });
    await db.agentListing.update({
      where: { id: listingId },
      data: { pendingReleaseId: rejected.id, latestVersion: 4 },
    });

    await rejectPendingAgentRelease({
      listingId,
      releaseId: rejected.id,
      reviewedById: adminId,
      reviewNote: 'Does not meet directory policy.',
    });
    const listing = await getDirectoryAgentListing(listingId);
    expect(listing?.latestReleaseId).toBe(before.latestReleaseId);
    expect(listing?.pendingReleaseId).toBeNull();
    expect(listing?.status).toBe('published');
    await expect(db.agentRelease.findUniqueOrThrow({ where: { id: rejected.id } }))
      .resolves.toMatchObject({ reviewStatus: 'rejected', reviewedById: adminId });
  });

  it('disables and republishes an approved listing', async () => {
    await expect(setDirectoryAgentListingStatus(listingId, 'disabled'))
      .resolves.toMatchObject({ status: 'disabled' });
    await expect(setDirectoryAgentListingStatus(listingId, 'published'))
      .resolves.toMatchObject({ status: 'published' });
  });

  it('refuses to approve a pending release with an invalid checksum', async () => {
    const approved = await db.agentListing.findUniqueOrThrow({
      where: { id: listingId },
      select: {
        latestRelease: { select: { manifest: true, releaseSummary: true } },
      },
    });
    const invalid = await db.agentRelease.create({
      data: {
        listingId,
        version: 5,
        manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
        manifest: approved.latestRelease!.manifest as Prisma.InputJsonValue,
        releaseSummary: approved.latestRelease!.releaseSummary as Prisma.InputJsonValue,
        checksum: '0'.repeat(64),
        name: 'Invalid Checksum Release',
        reviewStatus: 'pending',
      },
    });
    await db.agentListing.update({
      where: { id: listingId },
      data: { pendingReleaseId: invalid.id, latestVersion: 5 },
    });

    await expect(approvePendingAgentRelease({
      listingId,
      releaseId: invalid.id,
      reviewedById: adminId,
    })).rejects.toMatchObject({ code: 'invalid_release' } satisfies Partial<AdminAgentMarketError>);
    await rejectPendingAgentRelease({
      listingId,
      releaseId: invalid.id,
      reviewedById: adminId,
      reviewNote: 'Invalid checksum.',
    });
  });

  it('refuses deletion while an install references any release', async () => {
    const listing = await db.agentListing.findUniqueOrThrow({
      where: { id: listingId },
      select: { latestReleaseId: true },
    });
    const install = await db.agentInstall.create({
      data: {
        releaseId: listing.latestReleaseId!,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `admin-agent-install-${stamp}`,
        requirements: { providers: [], environment: [] },
      },
    });
    await expect(deleteDirectoryAgentListing(listingId)).rejects.toMatchObject({
      code: 'installed',
      count: 1,
    } satisfies Partial<AdminAgentMarketError>);
    await db.agentInstall.delete({ where: { id: install.id } });
  });
});
