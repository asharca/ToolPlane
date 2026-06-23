import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseServerCard,
  parseServerListing,
  parseStars,
} from '../../scraper/parse';

const html = readFileSync(
  resolve(__dirname, '../fixtures/server-card.html'),
  'utf8',
);

describe('parseStars', () => {
  it('parses k-suffixed, comma, and plain counts', () => {
    expect(parseStars('4.2k')).toBe(4200);
    expect(parseStars('12k')).toBe(12000);
    expect(parseStars('1,234')).toBe(1234);
    expect(parseStars('0')).toBe(0);
  });
});

describe('parseServerCard', () => {
  it('extracts fields from a real listing card', () => {
    expect(parseServerCard(html)).toEqual({
      slug: 'firecrawl',
      name: 'Firecrawl',
      author: 'mendableai',
      description: 'Empowers LLMs with advanced web scraping capabilities.',
      iconUrl: 'https://avatars.githubusercontent.com/u/135057108?v=4',
      category: null,
      stars: 4200,
    });
  });
});

describe('parseServerListing', () => {
  it('returns one card per server anchor and dedupes', () => {
    const list = parseServerListing(html);
    expect(list).toHaveLength(1);
    expect(list[0]?.slug).toBe('firecrawl');
  });
});
