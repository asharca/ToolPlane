// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { getSystemOverview } from '@/lib/admin/overview';

const stamp = Date.now();

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `ov-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `ov-${stamp}`, name: 'OV', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  await db.requestLog.create({
    data: { workspaceId: ws.id, method: 'POST', path: '/x', statusCode: 200, durationMs: 10 },
  });
  await db.requestLog.create({
    data: { workspaceId: ws.id, method: 'POST', path: '/x', statusCode: 500, durationMs: 20 },
  });
});

describe('getSystemOverview', () => {
  it('returns counts and 24h request aggregates', async () => {
    const o = await getSystemOverview();
    expect(o.counts.users).toBeGreaterThan(0);
    expect(o.counts.workspaces).toBeGreaterThan(0);
    expect(o.requests.total).toBeGreaterThanOrEqual(2);
    expect(o.requests.errors).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(o.scraper)).toBe(true);
    expect(Array.isArray(o.recentUsers)).toBe(true);
  });
});
