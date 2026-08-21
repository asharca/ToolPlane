import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { agentTool } from '@/lib/agents/agent-tool';
import { runNativeAgent } from '@/lib/agents/native';

afterEach(() => vi.unstubAllGlobals());

function sse(chunks: object[]): Response {
  return new Response([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
    'data: [DONE]',
    '',
  ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
}

describe('runNativeAgent', () => {
  it('continues through Pi tool calls and returns the completed reply', async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(sse([
        {
          id: 'chatcmpl-1',
          model: 'gpt-x',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'echo', arguments: '{"value":"hi"}' },
              }],
            },
            finish_reason: null,
          }],
        },
        { id: 'chatcmpl-1', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]))
      .mockResolvedValueOnce(sse([
        { id: 'chatcmpl-2', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
        { id: 'chatcmpl-2', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])));

    await expect(runNativeAgent({
      provider: { name: 'P', format: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret' },
      modelId: 'gpt-x',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      tools: {
        echo: agentTool({
          name: 'echo',
          description: 'Echoes a value.',
          parameters: Type.Object({ value: Type.String() }),
          execute,
        }),
      },
      maxSteps: 2,
    })).resolves.toBe('done');

    expect(execute).toHaveBeenCalledWith({ value: 'hi' });
  });
});
