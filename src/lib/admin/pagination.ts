export function normalizeAdminPage(page: number): number {
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
}
