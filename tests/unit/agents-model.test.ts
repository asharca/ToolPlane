import { describe, it, expect } from 'vitest';
import { buildModel } from '@/lib/agents/model';

// LanguageModel in AI SDK v6 is a union type that does not expose .modelId /
// .provider as static string properties, even though the concrete objects
// returned by createAnthropic()(id) and createOpenAICompatible()(id) carry
// them at runtime.  We cast to `any` so that tsc stays clean while still
// asserting the meaningful runtime behaviour: correct modelId forwarding and
// distinct provider strings between the two formats.

const base = { name: 'P', baseUrl: 'https://example.com/v1', apiKey: 'k' };

describe('buildModel', () => {
  it('builds an anthropic-format model carrying the requested model id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = buildModel({ ...base, format: 'anthropic' }, 'claude-x') as any;
    expect(m.modelId).toBe('claude-x');
    expect(m.provider).toContain('anthropic');
  });

  it('builds an openai-compatible model for any other format', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = buildModel({ ...base, format: 'openai' }, 'gpt-x') as any;
    expect(m.modelId).toBe('gpt-x');
    expect(m.provider).not.toContain('anthropic');
  });
});
