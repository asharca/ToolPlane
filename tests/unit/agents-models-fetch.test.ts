import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  fetchProviderModels,
  modelsEndpoint,
  modelsHeaders,
  parseModelList,
} from '@/lib/agents/models-fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelsEndpoint', () => {
  it('appends /models and trims a trailing slash', () => {
    expect(modelsEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models');
    expect(modelsEndpoint('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com/v1/models');
  });
});

describe('modelsHeaders', () => {
  it('uses Bearer auth for OpenAI formats', () => {
    expect(modelsHeaders('openai', 'k')).toEqual({ authorization: 'Bearer k' });
    expect(modelsHeaders('openai-responses', 'k')).toEqual({ authorization: 'Bearer k' });
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

describe('fetchProviderModels', () => {
  it('fetches the provider /models endpoint and parses model ids', async () => {
    const json = vi.fn(async () => ({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProviderModels({
      format: 'openai',
      baseUrl: 'https://api.example.test/v1/',
      apiKey: 'secret',
    })).resolves.toEqual({ ok: true, models: ['gpt-x', 'gpt-y'] });

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer secret' },
      cache: 'no-store',
    }));
  });

  it('returns a status error when the provider rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));

    await expect(fetchProviderModels({
      format: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'bad',
    })).resolves.toEqual({ ok: false, reason: 'status', status: 401 });
  });
});
