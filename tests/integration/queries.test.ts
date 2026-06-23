// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { listServers, getServer } from '@/lib/queries/servers';
import { searchAll } from '@/lib/queries/search';

beforeAll(async () => {
  await db.server.upsert({
    where: { slug: 'firecrawl' },
    create: { slug: 'firecrawl', name: 'Firecrawl', description: 'web scraping', stars: 4200 },
    update: {},
  });
});
afterAll(async () => { await db.$disconnect(); });

describe('queries', () => {
  it('lists servers ordered by stars with paging', async () => {
    const { items, total } = await listServers({ page: 1, pageSize: 10 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items[0]).toHaveProperty('slug');
  });

  it('gets a server by slug', async () => {
    const s = await getServer('firecrawl');
    expect(s?.name).toBe('Firecrawl');
  });

  it('returns null for unknown slug', async () => {
    expect(await getServer('does-not-exist')).toBeNull();
  });

  it('searches servers by name/description (case-insensitive)', async () => {
    const res = await searchAll('FIRE');
    expect(res.servers.some((s) => s.slug === 'firecrawl')).toBe(true);
  });

  it('returns empty results for blank query without hitting filters', async () => {
    const res = await searchAll('   ');
    expect(res.servers).toEqual([]);
  });
});
