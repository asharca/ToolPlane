import { describe, expect, it } from 'vitest';
import {
  defaultProviderModel,
  inferModelGroup,
  inferModelPrimaryType,
} from '@/lib/agents/model-catalog';

describe('provider model catalog defaults', () => {
  it('derives Cherry-style groups and safe initial model types', () => {
    expect(inferModelGroup('openai/gpt-5.5')).toBe('openai');
    expect(inferModelGroup('deepseek-v4-pro')).toBe('deepseek');
    expect(inferModelPrimaryType('text-embedding-3-large')).toBe('embedding');
    expect(inferModelPrimaryType('bge-reranker-v2')).toBe('rerank');
    expect(inferModelPrimaryType('gpt-image-1')).toBe('image');
    expect(defaultProviderModel('claude-sonnet-4')).toMatchObject({
      name: 'claude-sonnet-4',
      group: 'claude',
      primaryType: 'text',
    });
  });
});
