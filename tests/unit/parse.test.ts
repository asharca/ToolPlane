import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseServerCard, parseStars } from '../../scraper/parse';

const html = readFileSync(resolve(__dirname, '../fixtures/server-card.html'), 'utf8');

describe('parseStars', () => {
  it('parses k-suffixed counts', () => {
    expect(parseStars('4.2k')).toBe(4200);
    expect(parseStars('12k')).toBe(12000);
    expect(parseStars('0')).toBe(0);
  });
});

describe('parseServerCard', () => {
  it('extracts fields from a card anchor', () => {
    const s = parseServerCard(html);
    expect(s).toEqual({
      slug: 'firecrawl',
      name: 'Firecrawl',
      author: 'mendableai',
      description: 'Empowers LLMs with advanced web scraping capabilities.',
      iconUrl: 'https://img/firecrawl.png',
      category: 'Web Scraping & Data Collection',
      stars: 4200,
    });
  });
});
