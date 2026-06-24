import { describe, it, expect } from 'vitest';
import { safeRelativePath } from '@/lib/auth/safe-redirect';

describe('safeRelativePath', () => {
  it('accepts same-origin relative paths', () => {
    expect(safeRelativePath('/app')).toBe('/app');
    expect(safeRelativePath('/app/acme/mcp')).toBe('/app/acme/mcp');
  });

  it('rejects protocol-relative and absolute URLs (open redirect)', () => {
    expect(safeRelativePath('//evil.com')).toBeNull();
    expect(safeRelativePath('https://evil.com')).toBeNull();
    expect(safeRelativePath('/\\evil.com')).toBeNull();
  });

  it('rejects non-path values', () => {
    expect(safeRelativePath('app')).toBeNull();
    expect(safeRelativePath('')).toBeNull();
    expect(safeRelativePath(undefined)).toBeNull();
    expect(safeRelativePath(null)).toBeNull();
    expect(safeRelativePath(42)).toBeNull();
  });

  it('uses the first entry when given an array', () => {
    expect(safeRelativePath(['/app', '/other'])).toBe('/app');
    expect(safeRelativePath(['//evil'])).toBeNull();
  });
});
