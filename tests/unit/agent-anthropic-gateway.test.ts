// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

const mocks = vi.hoisted(() => ({
  buildModel: vi.fn(),
  streamSimple: vi.fn(),
}));

vi.mock('@/lib/agents/model', () => ({ buildModel: mocks.buildModel }));

import {
  ANTHROPIC_GATEWAY_MAX_BODY_BYTES,
  handleAnthropicCountTokens,
  handleAnthropicMessages,
} from '@/lib/agents/anthropic-gateway';

const provider = {
  id: 'provider-1',
  name: 'Responses',
  format: 'openai-responses',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'secret',
};

const usage = {
  input: 21,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 28,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseMessage = (content: AssistantMessage['content'] = []): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'provider-1',
  model: 'gpt-test',
  usage,
  stopReason: 'stop',
  timestamp: Date.now(),
});

function fakeStream(events: AssistantMessageEvent[], result: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: vi.fn(async () => result),
  };
}

describe('Anthropic runtime gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildModel.mockReturnValue({
      models: { streamSimple: mocks.streamSimple },
      model: {
        id: 'gpt-test',
        api: 'openai-responses',
        provider: 'provider-1',
        baseUrl: provider.baseUrl,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    });
  });

  it('translates Anthropic tool history and returns an Anthropic tool-use stream', async () => {
    const originalToolName = `mcp:filesystem/${'read-file-'.repeat(8)}`;
    mocks.streamSimple.mockImplementation((_model, context) => {
      const providerToolName = context.tools[0].name;
      const partial = baseMessage([{ type: 'toolCall', id: 'call_abc|fc_abc', name: providerToolName, arguments: {} }]);
      const final = { ...partial, content: [{ type: 'toolCall' as const, id: 'call_abc|fc_abc', name: providerToolName, arguments: { path: 'README.md' } }], stopReason: 'toolUse' as const };
      return fakeStream([
        { type: 'start', partial: baseMessage() },
        { type: 'toolcall_start', contentIndex: 0, partial },
        { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":', partial },
        { type: 'toolcall_delta', contentIndex: 0, delta: '"README.md"}', partial },
        { type: 'toolcall_end', contentIndex: 0, toolCall: final.content[0], partial: final },
        { type: 'done', reason: 'toolUse', message: final },
      ], final);
    });

    const response = await handleAnthropicMessages(new Request('http://toolplane.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        max_tokens: 4_096,
        stream: true,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: 'Work inside the sandbox.' }],
        tools: [{ name: originalToolName, description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: originalToolName, input: { path: 'old.txt' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'old contents' }, { type: 'text', text: 'Now read README.' }] },
        ],
      }),
    }), provider);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const [, context, options] = mocks.streamSimple.mock.calls[0];
    expect(context.systemPrompt).toBe('Work inside the sandbox.');
    expect(context.tools[0].name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(context.tools[0].name).not.toBe(originalToolName);
    expect(context.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'toolu_old', name: context.tools[0].name }] },
      { role: 'toolResult', toolCallId: 'toolu_old', toolName: context.tools[0].name, isError: false },
      { role: 'user', content: [{ type: 'text', text: 'Now read README.' }] },
    ]);
    expect(options).toMatchObject({ maxTokens: 4_096, reasoning: 'medium', maxRetries: 0 });

    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('"id":"call_abc"');
    expect(text).toContain(`"name":"${originalToolName}"`);
    expect(text).toContain('"partial_json":"{\\"path\\":"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('event: message_stop');
  });

  it('returns a standard non-streaming Anthropic message', async () => {
    const result = baseMessage([{ type: 'text', text: 'Done.' }]);
    mocks.streamSimple.mockReturnValue(fakeStream([], result));

    const response = await handleAnthropicMessages(new Request('http://toolplane.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-test',
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }), provider);

    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 21, output_tokens: 7 },
    });
  });

  it('validates bounded message requests and estimates count_tokens locally', async () => {
    const invalid = await handleAnthropicMessages(new Request('http://toolplane.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'Hello' }] }),
    }), provider);
    expect(invalid.status).toBe(400);
    expect(mocks.buildModel).not.toHaveBeenCalled();

    const tooLarge = await handleAnthropicCountTokens(new Request('http://toolplane.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-length': String(ANTHROPIC_GATEWAY_MAX_BODY_BYTES + 1) },
      body: '{}',
    }));
    expect(tooLarge.status).toBe(413);

    const count = await handleAnthropicCountTokens(new Request('http://toolplane.test/v1/messages/count_tokens', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'Count this request' }] }),
    }));
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toEqual({ input_tokens: expect.any(Number) });
  });

  it('returns an Anthropic API error before committing a failed stream', async () => {
    const failed = { ...baseMessage(), stopReason: 'error' as const, errorMessage: 'upstream unavailable' };
    mocks.streamSimple.mockReturnValue(fakeStream([
      { type: 'error', reason: 'error', error: failed },
    ], failed));

    const response = await handleAnthropicMessages(new Request('http://toolplane.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-test', max_tokens: 100, stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }), provider);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error', error: { type: 'api_error', message: 'upstream unavailable' },
    });
  });
});
