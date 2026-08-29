// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { listWorkspaceMarketCopies } from '@/lib/market/copy-updates';

const stamp = `${process.pid}-${Date.now()}`;
let userId = '';
let workspaceId = '';
let agentListingId = '';
let assistantListingId = '';

describe.sequential('market copy update detection', () => {
  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `market-copy-${stamp}@test.dev`, passwordHash: 'x' },
    });
    userId = user.id;
    const workspace = await db.workspace.create({
      data: { slug: `market-copy-${stamp}`, name: 'Market copies', ownerId: user.id },
    });
    workspaceId = workspace.id;

    const agent = await db.agent.create({
      data: { workspaceId, name: 'Customized agent', slug: 'customized-agent', runtimeKind: 'pi' },
    });
    const agentListing = await db.agentListing.create({
      data: {
        publisherKind: 'platform',
        slug: `agent-${stamp}`,
        directorySlug: `agent-${stamp}`,
        name: 'Agent template',
        status: 'draft',
      },
    });
    agentListingId = agentListing.id;
    const [agentV1, agentV2] = await Promise.all([
      db.agentRelease.create({
        data: {
          listingId: agentListing.id,
          version: 1,
          manifest: {},
          releaseSummary: {},
          checksum: '1'.repeat(64),
          name: 'Agent template',
          reviewStatus: 'approved',
        },
      }),
      db.agentRelease.create({
        data: {
          listingId: agentListing.id,
          version: 2,
          manifest: {},
          releaseSummary: {},
          checksum: '2'.repeat(64),
          name: 'Agent template',
          reviewStatus: 'approved',
        },
      }),
    ]);
    await db.agentListing.update({
      where: { id: agentListing.id },
      data: {
        status: 'published',
        latestVersion: 2,
        latestReleaseId: agentV2.id,
        publishedAt: new Date(),
      },
    });
    await db.agentInstall.create({
      data: {
        releaseId: agentV1.id,
        targetWorkspaceId: workspaceId,
        installedById: userId,
        agentId: agent.id,
        idempotencyKey: `agent-${stamp}`,
        status: 'ready',
        requirements: {},
      },
    });

    const assistantListing = await db.marketListing.create({
      data: {
        kind: 'assistant',
        namespace: 'platform',
        slug: `assistant-${stamp}`,
        name: 'Assistant template',
        metadata: {},
      },
    });
    assistantListingId = assistantListing.id;
    const [assistantV1, assistantV2] = await Promise.all([
      db.marketRelease.create({
        data: {
          listingId: assistantListing.id,
          version: 1,
          manifest: {},
          releaseSummary: {},
          checksum: '3'.repeat(64),
          reviewStatus: 'approved',
          publishedAt: new Date(),
        },
      }),
      db.marketRelease.create({
        data: {
          listingId: assistantListing.id,
          version: 2,
          manifest: {},
          releaseSummary: {},
          checksum: '4'.repeat(64),
          releaseNotes: 'New assistant behavior.',
          reviewStatus: 'approved',
          publishedAt: new Date(),
        },
      }),
    ]);
    await db.marketListing.update({
      where: { id: assistantListing.id },
      data: {
        status: 'published',
        latestVersion: 2,
        latestReleaseId: assistantV2.id,
        publishedAt: new Date(),
      },
    });
    await db.chatAssistant.create({
      data: {
        workspaceId,
        name: 'Customized assistant',
        marketTemplateReleaseId: assistantV1.id,
      },
    });
  });

  afterAll(async () => {
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    if (agentListingId) await db.agentListing.deleteMany({ where: { id: agentListingId } });
    if (assistantListingId) await db.marketListing.deleteMany({ where: { id: assistantListingId } });
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('offers reviewed newer releases without mutating customized copies', async () => {
    const updates = await listWorkspaceMarketCopies(workspaceId);

    expect(updates.agents).toEqual([
      expect.objectContaining({
        name: 'Customized agent',
        currentVersion: 1,
        latestVersion: 2,
        updateAvailable: true,
      }),
    ]);
    expect(updates.assistants).toEqual([
      expect.objectContaining({
        name: 'Customized assistant',
        currentVersion: 1,
        latestVersion: 2,
        releaseNotes: 'New assistant behavior.',
        updateAvailable: true,
      }),
    ]);
    await expect(db.agent.count({ where: { workspaceId } })).resolves.toBe(1);
    await expect(db.chatAssistant.count({ where: { workspaceId } })).resolves.toBe(1);
  });

  it('does not offer disabled listings as updates', async () => {
    await Promise.all([
      db.agentListing.update({ where: { id: agentListingId }, data: { status: 'disabled' } }),
      db.marketListing.update({ where: { id: assistantListingId }, data: { status: 'disabled' } }),
    ]);
    const updates = await listWorkspaceMarketCopies(workspaceId);
    expect(updates.agents[0]?.updateAvailable).toBe(false);
    expect(updates.assistants[0]?.updateAvailable).toBe(false);
  });
});
