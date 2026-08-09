import { describe, expect, it } from 'vitest';
import { publicPageNumber } from '@/app/(site)/_lib/pagination';

describe('public directory pagination', () => {
  it('defaults to page one and accepts canonical positive integers', () => {
    expect(publicPageNumber(undefined)).toBe(1);
    expect(publicPageNumber('2')).toBe(2);
    expect(publicPageNumber(['3', '4'])).toBe(3);
  });

  it('rejects ambiguous, unsafe, or non-positive values', () => {
    for (const value of ['', '0', '-1', '01', '1e3', '1.5', '9007199254740992']) {
      expect(publicPageNumber(value)).toBeNull();
    }
  });
});
