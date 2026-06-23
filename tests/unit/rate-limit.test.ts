import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../../scraper/rate-limit';

describe('backoffDelay', () => {
  it('grows exponentially from a base, capped', () => {
    expect(backoffDelay(0, 1000, 30000)).toBe(1000);
    expect(backoffDelay(1, 1000, 30000)).toBe(2000);
    expect(backoffDelay(2, 1000, 30000)).toBe(4000);
    expect(backoffDelay(10, 1000, 30000)).toBe(30000); // capped
  });
});
