export function adminHref(path: string, values: Record<string, string | undefined>) {
  const query = new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return query.size ? `${path}?${query}` : path;
}

export function adminReturnHref(value: unknown, fallback: string) {
  if (typeof value !== 'string' || value.length > 8000) return fallback;
  try {
    const url = new URL(value, 'http://admin.local');
    return value.startsWith('/admin') && url.origin === 'http://admin.local'
      && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
      ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch { return fallback; }
}
