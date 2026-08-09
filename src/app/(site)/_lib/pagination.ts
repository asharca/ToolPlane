export function publicPageNumber(
  value: string | string[] | undefined,
): number | null {
  const candidate = Array.isArray(value) ? value[0] : value ?? '1';
  if (!/^[1-9]\d*$/.test(candidate)) return null;
  const page = Number(candidate);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}
