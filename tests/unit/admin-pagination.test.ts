import { describe, expect, it } from 'vitest';
import { normalizeAdminPage } from '@/lib/admin/pagination';

describe('normalizeAdminPage', () => {
  it('keeps positive integer pages', () => {
    expect(normalizeAdminPage(1)).toBe(1);
    expect(normalizeAdminPage(42)).toBe(42);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])(
    'falls back to page one for %s',
    (page) => {
      expect(normalizeAdminPage(page)).toBe(1);
    },
  );
});
