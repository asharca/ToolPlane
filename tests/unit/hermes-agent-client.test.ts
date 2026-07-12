import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage, UIMessageStreamWriter } from 'ai';
import { uiMessagesToHermes, writeHermesChatStream } from '@/lib/agents/hermes/client';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesRuntimeReady: vi.fn(async () => ({ port: 4312 })),
}));

describe('Hermes chat projection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves text and maps inline images to OpenAI image parts', () => {
    const messages: UIMessage[] = [{
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
      ],
    }];

    expect(uiMessagesToHermes(messages)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]);
  });

  it('renders unsupported files as explicit attachment context', () => {
    const messages: UIMessage[] = [{
      id: 'm1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'application/pdf', filename: 'report.pdf', url: 'https://files.test/report.pdf' }],
    }];
    expect(uiMessagesToHermes(messages)[0].content).toContain('report.pdf');
  });

  it('never forwards system messages from ToolPlane to Hermes', () => {
    const messages = [{
      id: 'system-1',
      role: 'system',
      parts: [{ type: 'text', text: 'ToolPlane override' }],
    }] as unknown as UIMessage[];

    expect(uiMessagesToHermes(messages)).toEqual([]);
  });

  it('emits authoritative assistant segments from the completed Hermes turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"I will inspect."}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"Final result."}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: 1, role: 'user', content: 'Inspect the file.' },
          { id: 2, role: 'assistant', content: 'I will inspect.', tool_calls: [{ id: 'call-1' }] },
          { id: 3, role: 'tool', content: 'file contents', tool_name: 'read_file' },
          { id: 4, role: 'assistant', content: 'Final result.' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const write = vi.fn();

    await writeHermesChatStream({
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Inspect the file.' }],
      }],
      conversationId: 'conversation-1',
      writer: { write } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4312/hermes/api/sessions/conversation-1/messages',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(write).toHaveBeenCalledWith({
      type: 'data-hermes-messages',
      id: 'hermes-messages-conversation-1',
      data: {
        segments: [
          { id: '2', text: 'I will inspect.' },
          { id: '4', text: 'Final result.' },
        ],
      },
    });
  });
});
