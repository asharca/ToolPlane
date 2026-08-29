// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getMarketListing } from '@/lib/market/listings';
import {
  approveMarketRelease,
  countWorkspaceMarketUpdates,
  ignoreMarketUpdate,
  installSkillRelease,
  listWorkspaceMarketInstalls,
  MarketError,
  publishSkillRelease,
  removeMarketInstall,
  updateSkillMarketInstall,
} from '@/lib/market/skills';

const stamp = `${process.pid}-${Date.now()}`;
const namespace = `skill-market-source-${stamp}`;
let sourceUserId = '';
let targetUserId = '';
let adminUserId = '';
let sourceWorkspaceId = '';
let targetWorkspaceId = '';
let sourceSkillId = '';
let listingId = '';
let firstReleaseId = '';
let installId = '';
let installedSkillId = '';
let categoryId = '';

describe.sequential('unified skill market', () => {
  beforeAll(async () => {
    const [sourceUser, targetUser, admin] = await Promise.all([
      db.user.create({ data: { email: `skill-market-source-${stamp}@test.dev`, passwordHash: 'x' } }),
      db.user.create({ data: { email: `skill-market-target-${stamp}@test.dev`, passwordHash: 'x' } }),
      db.user.create({ data: { email: `skill-market-admin-${stamp}@test.dev`, passwordHash: 'x', role: 'admin' } }),
    ]);
    sourceUserId = sourceUser.id;
    targetUserId = targetUser.id;
    adminUserId = admin.id;
    const [sourceWorkspace, targetWorkspace] = await Promise.all([
      db.workspace.create({
        data: {
          slug: namespace,
          name: 'Skill publisher',
          ownerId: sourceUser.id,
          members: { create: { userId: sourceUser.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: `skill-market-target-${stamp}`,
          name: 'Skill installer',
          ownerId: targetUser.id,
          members: { create: { userId: targetUser.id, role: 'owner' } },
        },
      }),
    ]);
    sourceWorkspaceId = sourceWorkspace.id;
    targetWorkspaceId = targetWorkspace.id;
    const category = await db.category.create({
      data: { slug: `skill-market-${stamp}`, name: 'Skill market' },
    });
    categoryId = category.id;
    const skill = await db.installedSkill.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: 'Release notes',
        slug: `release-notes-${stamp}`,
        description: 'Write concise release notes.',
        content: '# Release notes\n\nVersion one.',
        files: [{ path: 'references/style.md', content: 'Use bullets.' }],
        source: 'custom',
      },
    });
    sourceSkillId = skill.id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: [sourceWorkspaceId, targetWorkspaceId] } } });
    await db.marketListing.deleteMany({ where: { namespace } });
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.user.deleteMany({ where: { id: { in: [sourceUserId, targetUserId, adminUserId] } } });
    await db.$disconnect();
  });

  it('publishes an immutable release and requires administrator approval', async () => {
    await expect(publishSkillRelease({
      workspaceId: sourceWorkspaceId,
      installedSkillId: sourceSkillId,
      publishedById: targetUserId,
      categoryIds: [categoryId],
    })).rejects.toMatchObject({ code: 'not_authorized' } satisfies Partial<MarketError>);

    const published = await publishSkillRelease({
      workspaceId: sourceWorkspaceId,
      installedSkillId: sourceSkillId,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      listing: { tags: ['writing'] },
      releaseNotes: 'Initial release.',
    });
    listingId = published.listing.id;
    firstReleaseId = published.release.id;
    expect(published.release.reviewStatus).toBe('pending');
    expect(JSON.stringify(published.manifest)).not.toContain('passwordHash');

    const approved = await approveMarketRelease({
      listingId,
      releaseId: firstReleaseId,
      reviewedById: adminUserId,
    });
    expect(approved.status).toBe('published');
    expect(approved.latestReleaseId).toBe(firstReleaseId);
    const publicListing = await getMarketListing(namespace, published.listing.slug);
    expect(publicListing).not.toHaveProperty('publishedById');
    expect(publicListing).not.toHaveProperty('sourceInstalledSkillId');
    expect(publicListing?.latestRelease).not.toHaveProperty('reviewedById');
  });

  it('rejects release artifacts that contain credentials', async () => {
    const secret = `sk-proj-${'a'.repeat(24)}`;
    const unsafe = await db.installedSkill.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: 'Unsafe skill',
        slug: `unsafe-${stamp}`,
        content: '# Unsafe\n\nNo credentials here.',
        files: [],
        source: 'custom',
      },
    });

    await expect(publishSkillRelease({
      workspaceId: sourceWorkspaceId,
      installedSkillId: unsafe.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      releaseNotes: `Token: ${secret}`,
    })).rejects.toMatchObject({ code: 'invalid_manifest' } satisfies Partial<MarketError>);
    expect(await db.marketListing.findUnique({
      where: { sourceInstalledSkillId: unsafe.id },
    })).toBeNull();
  });

  it('installs the reviewed snapshot idempotently', async () => {
    const [firstAttempt, secondAttempt] = await Promise.all([
      installSkillRelease({
        releaseId: firstReleaseId,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `install-${stamp}`,
      }),
      installSkillRelease({
        releaseId: firstReleaseId,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `install-${stamp}`,
      }),
    ]);
    const installed = firstAttempt.reused ? secondAttempt : firstAttempt;
    installId = installed.install.id;
    installedSkillId = installed.installedSkill.id;
    expect(installed.reused).toBe(false);
    expect([firstAttempt.reused, secondAttempt.reused].sort()).toEqual([false, true]);
    expect(installed.installedSkill.content).toContain('Version one');

    const replay = await installSkillRelease({
      releaseId: firstReleaseId,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `install-${stamp}`,
    });
    expect(replay.reused).toBe(true);
    expect(replay.installedSkill.id).toBe(installedSkillId);
  });

  it('detects, ignores, and explicitly applies an approved update', async () => {
    await db.installedSkill.update({
      where: { id: sourceSkillId },
      data: { content: '# Release notes\n\nVersion two.' },
    });
    const second = await publishSkillRelease({
      workspaceId: sourceWorkspaceId,
      installedSkillId: sourceSkillId,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      listing: {
        slug: `release-notes-renamed-${stamp}`,
        name: 'Release notes v2',
        summary: 'Unreviewed summary.',
        iconUrl: 'https://example.invalid/unreviewed.png',
        tags: ['updated'],
      },
      releaseNotes: 'Improved instructions.',
    });
    const beforeApproval = await getMarketListing(namespace, second.listing.slug);
    expect(second.manifest.listing?.slug).toBe(second.listing.slug);
    expect(beforeApproval).toMatchObject({
      name: 'Release notes',
      summary: 'Write concise release notes.',
      iconUrl: null,
      tags: ['writing'],
    });
    await approveMarketRelease({
      listingId,
      releaseId: second.release.id,
      reviewedById: adminUserId,
    });
    const afterApproval = await getMarketListing(namespace, second.listing.slug);
    expect(afterApproval).toMatchObject({
      name: 'Release notes v2',
      summary: 'Unreviewed summary.',
      iconUrl: 'https://example.invalid/unreviewed.png',
      tags: ['updated'],
    });
    await expect(installSkillRelease({
      releaseId: second.release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `install-${stamp}`,
    })).rejects.toMatchObject({ code: 'idempotency_conflict' } satisfies Partial<MarketError>);

    let installs = await listWorkspaceMarketInstalls(targetWorkspaceId);
    expect(installs[0].updateAvailable).toBe(true);
    expect(await countWorkspaceMarketUpdates(targetWorkspaceId)).toBe(1);
    expect((await db.installedSkill.findUnique({ where: { id: installedSkillId } }))?.content).toContain('Version one');

    await expect(updateSkillMarketInstall({
      installId,
      targetWorkspaceId,
      actorId: targetUserId,
      targetReleaseId: firstReleaseId,
      currentReleaseId: firstReleaseId,
    })).rejects.toMatchObject({ code: 'listing_conflict' } satisfies Partial<MarketError>);

    await ignoreMarketUpdate({
      installId,
      targetWorkspaceId,
      actorId: targetUserId,
      targetReleaseId: second.release.id,
      currentReleaseId: firstReleaseId,
    });
    installs = await listWorkspaceMarketInstalls(targetWorkspaceId);
    expect(installs[0].updateAvailable).toBe(false);
    expect(await countWorkspaceMarketUpdates(targetWorkspaceId)).toBe(0);

    await db.installedSkill.update({ where: { id: installedSkillId }, data: { userInvocable: false } });
    await Promise.all([1, 2].map(() => updateSkillMarketInstall({
      installId,
      targetWorkspaceId,
      actorId: targetUserId,
      targetReleaseId: second.release.id,
      currentReleaseId: firstReleaseId,
    })));
    const updated = await db.installedSkill.findUnique({ where: { id: installedSkillId } });
    expect(updated?.content).toContain('Version two');
    expect(updated?.userInvocable).toBe(false);

    const oldRequestReplay = await installSkillRelease({
      releaseId: firstReleaseId,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `install-${stamp}`,
    });
    expect(oldRequestReplay).toMatchObject({ reused: true, installedSkill: { id: installedSkillId } });
  });

  it('does not overwrite locally modified content without confirmation', async () => {
    await db.marketInstall.update({ where: { id: installId }, data: { status: 'modified' } });
    await expect(updateSkillMarketInstall({
      installId,
      targetWorkspaceId,
      actorId: targetUserId,
    })).rejects.toMatchObject({ code: 'local_changes' } satisfies Partial<MarketError>);
  });

  it('decrements the shared install count atomically during concurrent removals', async () => {
    const user = await db.user.create({
      data: { email: `skill-market-second-target-${stamp}@test.dev`, passwordHash: 'x' },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: `skill-market-second-target-${stamp}`,
        name: 'Second skill installer',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    const listing = await db.marketListing.findUniqueOrThrow({ where: { id: listingId } });
    const second = await installSkillRelease({
      releaseId: listing.latestReleaseId!,
      targetWorkspaceId: workspace.id,
      installedById: user.id,
      idempotencyKey: `second-install-${stamp}`,
    });
    expect((await db.marketListing.findUniqueOrThrow({ where: { id: listingId } })).installCount).toBe(2);

    await Promise.all([
      removeMarketInstall({ installId, targetWorkspaceId, actorId: targetUserId }),
      removeMarketInstall({ installId: second.install.id, targetWorkspaceId: workspace.id, actorId: user.id }),
    ]);
    expect((await db.marketListing.findUniqueOrThrow({ where: { id: listingId } })).installCount).toBe(0);
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
