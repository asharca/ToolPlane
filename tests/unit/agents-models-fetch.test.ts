import { describe, it, expect } from 'vitest';
import { modelsEndpoint, modelsHeaders, parseModelList } from '@/lib/agents/models-fetch';

describe('modelsEndpoint', () => {
  it('appends /models and trims a trailing slash', () => {
    expect(modelsEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(modelsEndpoint('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com/v1/models');
  });
});

describe('modelsHeaders', () => {
  it('uses Bearer auth for openai format', () => {
    expect(modelsHeaders('openai', 'k')).toEqual({ authorization: 'Bearer k' });
  });
  it('uses x-api-key + version for anthropic format', () => {
    expect(modelsHeaders('anthropic', 'k')).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
  });
});

describe('parseModelList', () => {
  it('extracts string ids from a { data: [{ id }] } body', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }, { nope: 1 }] })).toEqual(['a', 'b']);
  });
  it('returns [] for malformed bodies', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: 'x' })).toEqual([]);
  });
});
