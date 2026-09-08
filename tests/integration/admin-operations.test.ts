// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { listAdminReviews } from '@/lib/admin/reviews';
import { getSystemOverview } from '@/lib/admin/overview';
import { getWorkspaceDetail, listWorkspaces } from '@/lib/admin/workspaces';
import { getUserDetail, listUsers } from '@/lib/admin/users';
import { createCategory, updateCategory, deleteCategory } from '@/lib/admin/categories';
import { getSettingChanges, saveAuditedSetting } from '@/lib/admin/audited-setting';
import { updateAdminMarketListing } from '@/lib/admin/market-catalog';

const stamp = `ops-${randomUUID()}`;
const ids = { admin: '', member: '', workspace: '', deployment: '', category: '', listing: '' };
const setting = `${stamp}.setting`;

describe.sequential('practical admin operations', () => {
  beforeAll(async () => {
    ids.admin = (await db.user.create({ data: { email: `${stamp}@test.dev`, name: stamp, passwordHash: 'x', role: 'admin' } })).id;
    ids.member = (await db.user.create({ data: { email: `${stamp}-member@test.dev`, passwordHash: 'x', status: 'suspended' } })).id;
    ids.workspace = (await db.workspace.create({ data: { slug: stamp, name: stamp, ownerId: ids.admin, members: { create: { userId: ids.member, role: 'member' } } } })).id;
    ids.deployment = (await db.deployment.create({ data: { workspaceId: ids.workspace, name: 'Stale running deployment', status: 'running' } })).id;
    await db.agent.create({ data: { workspaceId: ids.workspace, name: 'Operations agent', slug: 'agent', runtimeKind: 'pi' } });
    await db.sandbox.create({ data: { workspaceId: ids.workspace, deploymentId: ids.deployment, name: 'Operations sandbox', slug: 'sandbox', kind: 'connector' } });
    await db.logEvent.create({ data: { workspaceId: ids.workspace, domain: 'runtime', outcome: 'error', eventName: 'runtime.failed', message: stamp, traceId: stamp, spanId: 'ops' } });
    ids.category = (await createCategory(stamp, stamp, ids.admin)).id;
    for (let i = 0; i < 26; i += 1) {
      const submittedAt = new Date(Date.now() - (26 - i) * 1000);
      if (i % 2 === 0) {
        const listing = await db.marketListing.create({ data: { kind: 'skill', namespace: stamp, slug: `skill-${i}`, name: `${stamp}-${i}`, metadata: {}, publishedById: ids.admin } });
        const release = await db.marketRelease.create({ data: { listingId: listing.id, version: 1, manifest: {}, releaseSummary: {}, checksum: 'test', createdAt: submittedAt } });
        await db.marketListing.update({ where: { id: listing.id }, data: { pendingReleaseId: release.id } });
        ids.listing ||= listing.id;
      } else {
        const listing = await db.agentListing.create({ data: { slug: `agent-${i}`, directorySlug: `${stamp}-${i}`, name: `${stamp}-${i}`, publishedById: ids.admin } });
        const release = await db.agentRelease.create({ data: { listingId: listing.id, name: listing.name, version: 1, manifest: {}, releaseSummary: {}, checksum: 'test', publishedAt: submittedAt } });
        await db.agentListing.update({ where: { id: listing.id }, data: { pendingReleaseId: release.id } });
      }
    }
    await db.marketRelease.create({ data: { listingId: ids.listing, version: 2, manifest: {}, releaseSummary: {}, checksum: 'obsolete-pending' } });
  });

  afterAll(async () => {
    await db.systemSetting.deleteMany({ where: { key: setting } });
    await db.marketListing.deleteMany({ where: { namespace: stamp } });
    await db.agentListing.deleteMany({ where: { directorySlug: { startsWith: stamp } } });
    await db.logEvent.deleteMany({ where: { workspaceId: ids.workspace } });
    await db.workspace.deleteMany({ where: { id: ids.workspace } });
    await db.category.deleteMany({ where: { id: ids.category } });
    await db.auditEvent.deleteMany({ where: { actorId: ids.admin } });
    await db.user.deleteMany({ where: { id: { in: [ids.admin, ids.member].filter(Boolean) } } });
  });

  it('merges both queues with stable pagination and excludes superseded pending versions', async () => {
    const first = await listAdminReviews({ q: stamp });
    const next = await listAdminReviews({ q: stamp, page: 2 });
    expect(first.total).toBe(26);
    expect(first.items).toHaveLength(25);
    expect(next.items).toHaveLength(1);
    expect(new Set([...first.items, ...next.items].map(({ id }) => id)).size).toBe(26);
    expect(first.items[0].source).toBe('market');
    expect(first.items[1].source).toBe('agent');
    expect((await listAdminReviews({ q: stamp, kind: 'agent' })).total).toBe(13);
    expect((await listAdminReviews({ q: "' OR 1=1 --" })).total).toBe(0);
  });

  it('returns actionable runtime state, joined memberships and precise user filters', async () => {
    const detail = await getWorkspaceDetail(ids.workspace);
    expect(detail?.deployments[0].status).toBe('stopped');
    expect(detail?.sandboxes[0].status).toBe('stopped');
    expect(detail?.agents[0].name).toBe('Operations agent');
    expect(detail?.recentErrors[0].message).toBe(stamp);
    expect((await getUserDetail(ids.member))?.memberships[0].workspace.id).toBe(ids.workspace);
    expect((await listUsers({ q: stamp, role: 'admin' })).items.map(({ id }) => id)).toEqual([ids.admin]);
    expect((await listUsers({ q: stamp, status: 'suspended' })).items.map(({ id }) => id)).toEqual([ids.member]);
    expect((await listWorkspaces({ owner: `${stamp}@test.dev`, status: 'active' })).items.map(({ id }) => id)).toEqual([ids.workspace]);
    const overview = await getSystemOverview();
    expect(overview.attention.pendingReviews).toBeGreaterThanOrEqual(26);
    expect(overview.attention.abnormalCount).toBeGreaterThanOrEqual(1);
    expect(overview.counts.deployments.stopped).toBeGreaterThanOrEqual(1);
  });

  it('writes catalog and setting audit records with real actor identities', async () => {
    await updateCategory(ids.category, 'Renamed operations', ids.admin);
    await updateAdminMarketListing({ id: ids.listing, status: 'disabled', curated: true, isFeatured: false, categoryIds: [ids.category] }, ids.admin);
    await expect(deleteCategory(ids.category, ids.admin)).rejects.toThrow('not empty');
    expect(await db.auditEvent.count({ where: { actorId: ids.admin, targetId: ids.category, action: 'category.deleted' } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { targetId: ids.listing, actorId: ids.admin, action: 'market.listing.updated' } });
    expect(audit.changes).toMatchObject({ before: { status: 'draft' }, after: { status: 'disabled', categoryIds: [ids.category] } });
    await saveAuditedSetting(setting, '42', ids.admin);
    expect((await getSettingChanges([setting])).get(setting)).toMatchObject({ actor: stamp, actorId: ids.admin });
    await saveAuditedSetting(setting, null, ids.admin);
    expect(await db.systemSetting.findUnique({ where: { key: setting } })).toBeNull();
    expect(await db.auditEvent.count({ where: { targetId: setting, action: 'setting.reset', actorId: ids.admin } })).toBe(1);
  });
});
