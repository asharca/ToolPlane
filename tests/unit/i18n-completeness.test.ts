import { describe, it, expect } from 'vitest';
import en from '../../messages/en.json';
import zh from '../../messages/zh.json';

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? collectKeys(v as Record<string, unknown>, full)
      : [full];
  });
}

describe('translation completeness', () => {
  it('zh.json contains every key present in en.json', () => {
    const enKeys = collectKeys(en);
    const zhKeys = new Set(collectKeys(zh));
    const missing = enKeys.filter((k) => !zhKeys.has(k));
    expect(missing, `Missing zh keys:\n${missing.join('\n')}`).toEqual([]);
  });

  it('en.json contains every key present in zh.json (no orphan zh keys)', () => {
    const zhKeys = collectKeys(zh);
    const enKeys = new Set(collectKeys(en));
    const orphans = zhKeys.filter((k) => !enKeys.has(k));
    expect(orphans, `Orphan zh keys:\n${orphans.join('\n')}`).toEqual([]);
  });
});
