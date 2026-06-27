// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { upsertServer, upsertSkill } from '../../scraper/ingest';

const stamp = Date.now();
const card = (slug: string, name: string) => ({ slug, name, author: null, description: null, iconUrl: null, category: null, stars: 7 });

describe('scraper respects curated rows', () => {
  it('does not overwrite a curated server', async () => {
    await db.server.create({ data: { slug: `cur-${stamp}`, name: 'Admin Name', curated: true, stars: 1 } });
    await upsertServer(card(`cur-${stamp}`, 'Scraped Name'));
    const row = await db.server.findUnique({ where: { slug: `cur-${stamp}` } });
    expect(row?.name).toBe('Admin Name');
    expect(row?.stars).toBe(1);
  });

  it('updates a non-curated server', async () => {
    await db.server.create({ data: { slug: `nc-${stamp}`, name: 'Old', curated: false, stars: 1 } });
    await upsertServer(card(`nc-${stamp}`, 'New'));
    const row = await db.server.findUnique({ where: { slug: `nc-${stamp}` } });
    expect(row?.name).toBe('New');
  });

  it('creates a new scraped slug', async () => {
    await upsertServer(card(`fresh-${stamp}`, 'Fresh'));
    expect(await db.server.findUnique({ where: { slug: `fresh-${stamp}` } })).not.toBeNull();
  });

  it('does not overwrite a curated skill', async () => {
    await db.skill.create({ data: { slug: `curs-${stamp}`, name: 'Admin Skill', curated: true, score: 2 } });
    await upsertSkill(card(`curs-${stamp}`, 'Scraped Skill'));
    const row = await db.skill.findUnique({ where: { slug: `curs-${stamp}` } });
    expect(row?.name).toBe('Admin Skill');
  });
});
