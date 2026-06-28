// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { upsertServer } from '../../scraper/ingest';
import type { ParsedServerCard } from '../../scraper/parse';

const card: ParsedServerCard = {
  slug: 'ingest-test-firecrawl', name: 'Firecrawl', author: 'mendableai',
  description: 'desc', iconUrl: 'https://img/x.png',
  category: 'Web Scraping & Data Collection', stars: 4200,
};

describe('upsertServer', () => {
  beforeEach(async () => {
    await db.server.deleteMany({ where: { slug: 'ingest-test-firecrawl' } });
  });
  afterAll(async () => { await db.$disconnect(); });

  it('creates then updates idempotently and links category', async () => {
    await upsertServer(card);
    await upsertServer({ ...card, stars: 5000 });
    const s = await db.server.findUnique({
      where: { slug: 'ingest-test-firecrawl' }, include: { categories: true },
    });
    expect(s?.stars).toBe(5000);
    expect(s?.categories[0]?.name).toBe('Web Scraping & Data Collection');
    const dupes = await db.server.count({ where: { slug: 'ingest-test-firecrawl' } });
    expect(dupes).toBe(1);
  });
});
