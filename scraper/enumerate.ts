import { fetchHtml } from './http';
import { parseServerListing, type ParsedServerCard } from './parse';

export function serverPagePath(page: number): string {
  return page <= 1 ? '/server' : `/server/page/${page}`;
}

export async function enumerateServerPage(
  page: number,
): Promise<ParsedServerCard[]> {
  const html = await fetchHtml(serverPagePath(page));
  return parseServerListing(html);
}
