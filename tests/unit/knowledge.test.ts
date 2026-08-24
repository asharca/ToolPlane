import { describe, expect, it } from 'vitest';
import { splitKnowledgeText } from '@/lib/knowledge';

describe('splitKnowledgeText', () => {
  it('creates bounded overlapping chunks without losing the tail', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const chunks = splitKnowledgeText(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(200);
    expect(chunks.at(-1)).toContain('line 39');
  });

  it('ignores empty text', () => {
    expect(splitKnowledgeText('  \n ', 1200, 200)).toEqual([]);
  });
});
