import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

export interface ParsedServerCard {
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  iconUrl: string | null;
  category: string | null;
  stars: number;
}

export type ParsedCard = ParsedServerCard;

export function parseStars(text: string): number {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (!t) return 0;
  if (t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
  if (t.endsWith('m')) return Math.round(parseFloat(t) * 1_000_000);
  return parseInt(t, 10) || 0;
}

const STAR_TOKEN = /^\d[\d.,]*\s*[km]?$/i;

function parseCard(
  $: CheerioAPI,
  a: ReturnType<CheerioAPI>,
  prefix: string,
): ParsedCard | null {
  const href = a.attr('href') ?? '';
  if (!href.startsWith(prefix)) return null;
  const slug = href.slice(prefix.length).replace(/\/+$/, '');
  // Skip pagination links (".../page/N") and the bare listing link.
  if (!slug || slug.includes('/')) return null;
  const name = a.find('h3').first().text().trim();
  if (!name) return null;

  const img = a.find('img').first();
  let stars = 0;
  a.find('span, div').each((_i, node) => {
    if (stars) return;
    const txt = $(node).clone().children().remove().end().text().trim();
    if (STAR_TOKEN.test(txt)) stars = parseStars(txt);
  });

  return {
    slug,
    name,
    author: img.attr('alt')?.trim() || null,
    description: a.find('p').first().text().trim() || null,
    iconUrl: img.attr('src') || null,
    category: null,
    stars,
  };
}

export function parseListing(html: string, prefix: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const out: ParsedCard[] = [];
  const seen = new Set<string>();
  $(`a[href^="${prefix}"]`).each((_i, el) => {
    const card = parseCard($, $(el), prefix);
    if (card && !seen.has(card.slug)) {
      seen.add(card.slug);
      out.push(card);
    }
  });
  return out;
}

export function parseServerCard(html: string): ParsedServerCard | null {
  const $ = cheerio.load(html);
  const a = $('a[href^="/server/"]').first();
  return a.length ? parseCard($, a, '/server/') : null;
}

export function parseServerListing(html: string): ParsedServerCard[] {
  return parseListing(html, '/server/');
}
