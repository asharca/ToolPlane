export const WEB_SEARCH_CATEGORIES = new Set(['web', 'search']);
const WEB_SEARCH_SOURCE_REFS = new Set([
  'mcp-server-fetch',
  'firecrawl-mcp',
  '@modelcontextprotocol/server-brave-search',
]);

export type CategorizedDeployment = {
  sourceRef?: string | null;
  server?: {
    categories?: ReadonlyArray<{ slug: string }>;
  } | null;
};

export function isWebSearchIdentifier(value: string): boolean {
  const normalized = value.toLowerCase();
  return WEB_SEARCH_CATEGORIES.has(normalized) || WEB_SEARCH_SOURCE_REFS.has(normalized);
}

export function isWebSearchDeployment(deployment: CategorizedDeployment): boolean {
  return Boolean(
    (deployment.sourceRef && isWebSearchIdentifier(deployment.sourceRef))
    || deployment.server?.categories?.some((category) => isWebSearchIdentifier(category.slug)),
  );
}
