import * as cheerio from 'cheerio';

export interface ParsedServerCard {
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  category: string | null;
  stars: number;
}

export function parseStars(text: string): number {
  const t = text.trim().toLowerCase();
  if (t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
  return parseInt(t, 10) || 0;
}

export function parseServerCard(html: string): ParsedServerCard {
  const $ = cheerio.load(html);
  const a = $('a').first();
  const href = a.attr('href') ?? '';
  const slug = href.split('/').filter(Boolean).pop() ?? '';
  const img = a.find('img').first();
  const starsText = a.find('[data-stars]').first().text();
  return {
    slug,
    name: a.find('h3').first().text().trim(),
    author: img.attr('alt')?.trim() || null,
    description: a.find('p').first().text().trim() || null,
    iconUrl: img.attr('src') || null,
    category: a.find('[data-category]').first().text().trim() || null,
    stars: starsText ? parseStars(starsText) : 0,
  };
}
