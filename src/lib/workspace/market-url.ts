export type MarketSearchParams = Record<string, string | string[] | undefined>;

export function legacyMarketRedirectTarget(
  workspace: string,
  section: 'mcp' | 'skills',
  searchParams: MarketSearchParams,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.append(key, value);
  }
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/${section}`;
  return suffix ? `${base}?${suffix}` : base;
}
