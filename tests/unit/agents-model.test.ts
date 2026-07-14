import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateText, type ModelMessage } from 'ai';
import { buildModel } from '@/lib/agents/model';
import { prependSystemModelMessage } from '@/lib/agents/system-prompt';

// LanguageModel in AI SDK v6 is a union type that does not expose .modelId /
// .provider as static string properties, even though the concrete objects
// returned by createAnthropic()(id) and createOpenAICompatible()(id) carry
// them at runtime.  We cast to `any` so that tsc stays clean while still
// asserting the meaningful runtime behaviour: correct modelId forwarding and
// distinct provider strings between the two formats.

const base = { name: 'P', baseUrl: 'https://example.com/v1', apiKey: 'k' };

describe('buildModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('builds an OpenAI Responses model carrying the requested model id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = buildModel({ ...base, format: 'openai-responses' }, 'gpt-x') as any;
    expect(m.modelId).toBe('gpt-x');
    expect(m.provider).toContain('responses');
  });

  it('sends OpenAI Responses requests to the responses endpoint', async () => {
    let requestUrl = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ error: { message: 'test response' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(generateText({
      model: buildModel({ ...base, format: 'openai-responses' }, 'gpt-x'),
      prompt: 'hello',
    })).rejects.toThrow();

    expect(requestUrl).toBe('https://example.com/v1/responses');
  });

  it('sends system instructions as the first OpenAI-compatible chat message', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-x',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const messages: ModelMessage[] = prependSystemModelMessage(
      'Server system prompt',
      [{ role: 'user', content: 'hello' }],
    );
    await generateText({
      model: buildModel({ ...base, format: 'openai' }, 'gpt-x'),
      allowSystemInMessages: true,
      messages,
    });

    expect(requestUrl).toBe('https://example.com/v1/chat/completions');
    expect(requestBody).not.toHaveProperty('system');
    expect(requestBody?.messages).toEqual([
      { role: 'system', content: 'Server system prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });
});
