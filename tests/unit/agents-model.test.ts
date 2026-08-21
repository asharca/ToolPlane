import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModel, providerModelIds } from '@/lib/agents/model';

const base = { name: 'P', baseUrl: 'https://example.com/v1', apiKey: 'k' };

describe('buildModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps configured formats to Pi APIs', () => {
    expect(buildModel({ ...base, format: 'anthropic' }, 'claude-x').model).toMatchObject({
      id: 'claude-x',
      api: 'anthropic-messages',
    });
    expect(buildModel({ ...base, format: 'openai' }, 'gpt-x').model).toMatchObject({
      id: 'gpt-x',
      api: 'openai-completions',
    });
    expect(buildModel({ ...base, format: 'openai-responses' }, 'gpt-x').model).toMatchObject({
      id: 'gpt-x',
      api: 'openai-responses',
    });
  });

  it('uses Pi builtin catalogs and preserves their provider-specific API', () => {
    const provider = { ...base, format: 'pi:google', baseUrl: 'https://gateway.example/v1' };
    const modelId = providerModelIds(provider)?.[0];

    expect(modelId).toBeTruthy();
    expect(buildModel(provider, modelId!).model).toMatchObject({
      id: modelId,
      api: 'google-generative-ai',
      baseUrl: 'https://gateway.example/v1',
    });
  });

  it('sends OpenAI Responses requests through Pi to the responses endpoint', async () => {
    let requestUrl = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ error: { message: 'test response' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { models, model } = buildModel({ ...base, format: 'openai-responses' }, 'gpt-x');
    const result = await models.completeSimple(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    });

    expect(result.stopReason).toBe('error');
    expect(requestUrl).toBe('https://example.com/v1/responses');
  });

  it('sends the system prompt through Pi as the first OpenAI-compatible chat message', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response([
        'data: {"id":"chatcmpl-test","model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","model":"gpt-x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const { models, model } = buildModel({ ...base, format: 'openai' }, 'gpt-x');
    const result = await models.completeSimple(model, {
      systemPrompt: 'Server system prompt',
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    });

    expect(result.stopReason).toBe('stop');
    expect(requestUrl).toBe('https://example.com/v1/chat/completions');
    const body = requestBody as Record<string, unknown> | null;
    expect(body).not.toHaveProperty('system');
    expect(body?.messages).toEqual([
      { role: 'system', content: 'Server system prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });
});
