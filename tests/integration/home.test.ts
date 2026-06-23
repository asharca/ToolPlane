// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { getHomeSections } from '@/lib/queries/home';

const PREFIX = 'home-';
const BASE = new Date('2020-01-01T00:00:00Z').getTime();

async function cleanup() {
  await db.server.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.client.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await db.skill.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}

function nonIncreasing(nums: number[]): boolean {
  return nums.every((n, i) => i === 0 || nums[i - 1] >= n);
}

beforeAll(async () => {
  await cleanup();
  await db.server.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      slug: `${PREFIX}s${i}`,
      name: `Home Server ${i}`,
      stars: i,
      isOfficial: i % 2 === 0,
      isFeatured: i % 3 === 0,
      createdAt: new Date(BASE + i * 1000),
    })),
  });
  await db.server.create({
    data: {
      slug: `${PREFIX}top`,
      name: 'Top Server',
      stars: 10_000_000,
      isOfficial: true,
      isFeatured: true,
      createdAt: new Date(BASE + 999_000),
    },
  });
  await db.client.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      slug: `${PREFIX}c${i}`,
      name: `Home Client ${i}`,
      stars: i,
    })),
  });
  await db.skill.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      slug: `${PREFIX}k${i}`,
      name: `Home Skill ${i}`,
      score: i,
    })),
  });
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe('getHomeSections', () => {
  it('returns six sections, each limited to 6 and correctly ordered', async () => {
    const s = await getHomeSections();

    for (const list of [
      s.officialServers,
      s.featuredServers,
      s.topServers,
      s.latestServers,
      s.clients,
      s.topSkills,
    ]) {
      expect(list.length).toBeLessThanOrEqual(6);
    }

    expect(s.officialServers.every((x) => x.isOfficial)).toBe(true);
    expect(s.featuredServers.every((x) => x.isFeatured)).toBe(true);

    expect(nonIncreasing(s.topServers.map((x) => x.stars))).toBe(true);
    expect(nonIncreasing(s.clients.map((x) => x.stars))).toBe(true);
    expect(nonIncreasing(s.topSkills.map((x) => x.score))).toBe(true);
    expect(
      nonIncreasing(s.latestServers.map((x) => x.createdAt.getTime())),
    ).toBe(true);

    expect(s.topServers[0]?.slug).toBe(`${PREFIX}top`);
  });
});
