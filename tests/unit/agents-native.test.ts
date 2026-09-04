import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { agentTool } from '@/lib/agents/agent-tool';
import { runNativeAgent, uiMessagesToPi } from '@/lib/agents/native';

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
    const onContextUsage = vi.fn();
    const fetchMock = vi.fn()
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
        { id: 'chatcmpl-1', model: 'gpt-x', choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
      ]))
      .mockResolvedValueOnce(sse([
        { id: 'chatcmpl-2', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
        { id: 'chatcmpl-2', model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { id: 'chatcmpl-2', model: 'gpt-x', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
      ]));
    vi.stubGlobal('fetch', fetchMock);

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
      reasoningEffort: 'high',
      onContextUsage,
    })).resolves.toBe('done');

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ reasoning_effort: 'high' });
    expect(execute).toHaveBeenCalledWith({ value: 'hi' });
    expect(onContextUsage).toHaveBeenLastCalledWith({
      usedTokens: 150,
      maxTokens: 128_000,
      modelName: 'gpt-x',
      estimated: true,
    });
  });

  it('fails explicitly when the final allowed model step still requests tools', async () => {
    const execute = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(sse([
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
              function: { name: 'complete_work', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ])));

    await expect(runNativeAgent({
      provider: { name: 'P', format: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret' },
      modelId: 'gpt-x',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'finish', timestamp: Date.now() }],
      tools: {
        complete_work: agentTool({
          name: 'complete_work',
          description: 'Completes work.',
          parameters: Type.Object({}),
          execute,
        }),
      },
      maxSteps: 1,
    })).rejects.toThrow('Agent reached the 1-turn tool-call limit before completing its response.');

    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps persisted Work tool results in recovery context', () => {
    const [message] = uiMessagesToPi([{
      role: 'assistant',
      parts: [{
        type: 'work-tool',
        toolName: 'write_file',
        input: { path: '/workspace/result.txt' },
        output: { ok: true },
        isError: false,
      }],
    }]);

    expect(message).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(message)).toContain('Recorded successful tool call: write_file');
    expect(JSON.stringify(message)).toContain('/workspace/result.txt');
  });

  it('passes hydrated text and image data to Pi', () => {
    const [message] = uiMessagesToPi([{
      role: 'user',
      parts: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    }]);

    expect(message).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    });
  });

  it('keeps server-generated Work attachment paths in Pi context', () => {
    const [message] = uiMessagesToPi([{
      role: 'user',
      parts: [{
        type: 'file',
        filename: 'brief.txt',
        providerMetadata: { toolplane: { runtimePath: '/workspace/.toolplane/attachments/brief.txt' } },
      }],
    }]);

    expect(JSON.stringify(message)).toContain(
      '[Attached file: brief.txt at /workspace/.toolplane/attachments/brief.txt]',
    );
  });
});
