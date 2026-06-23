import { fetchRenderedHtml } from './browser';
import { parseListing, type ParsedServerCard } from './parse';

export function serverPagePath(page: number): string {
  return page <= 1 ? '/server' : `/server/page/${page}`;
}

export async function enumerateServerPage(
  page: number,
): Promise<ParsedServerCard[]> {
  const html = await fetchRenderedHtml(
    serverPagePath(page),
    'a[href^="/server/"] h3',
  );
  return parseListing(html, '/server/');
}

export async function enumerateClients(): Promise<ParsedServerCard[]> {
  const html = await fetchRenderedHtml('/client', 'a[href^="/client/"] h3');
  return parseListing(html, '/client/');
}

export async function enumerateSkills(): Promise<ParsedServerCard[]> {
  const html = await fetchRenderedHtml(
    '/tools/skills',
    'a[href^="/tools/skills/"] h3',
  );
  return parseListing(html, '/tools/skills/');
}
