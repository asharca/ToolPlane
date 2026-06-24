// Guard against open-redirect: only accept same-origin relative paths from
// untrusted input (e.g. a ?next= query param or hidden form field).
export function safeRelativePath(value: unknown): string | null {
  const next = Array.isArray(value) ? value[0] : value;
  if (
    typeof next === 'string' &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.startsWith('/\\')
  ) {
    return next;
  }
  return null;
}
