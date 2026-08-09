import { searchPublicDirectory } from '@/lib/queries/public-search';

export async function searchAll(query: string) {
  return searchPublicDirectory(query);
}
