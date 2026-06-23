import { fetchRenderedHtml } from './browser';
import { parseServerDetail, type ParsedServerDetail } from './parse';

export async function fetchServerDetail(
  slug: string,
): Promise<ParsedServerDetail> {
  const html = await fetchRenderedHtml(`/server/${slug}`, 'h1');
  return parseServerDetail(html);
}
