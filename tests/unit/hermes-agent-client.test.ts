import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage, UIMessageStreamWriter } from 'ai';
import { uiMessagesToHermes, writeHermesChatStream } from '@/lib/agents/hermes/client';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesRuntimeReady: vi.fn(async () => ({ port: 4312 })),
}));

const profileMocks = vi.hoisted(() => ({
  ensureProjection: vi.fn(async () => undefined),
  listModels: vi.fn(),
}));

vi.mock('@/lib/agents/hermes/profiles', () => ({
  ensureHermesProfileProjection: profileMocks.ensureProjection,
  hasHermesProfileChatCapabilities: (value: unknown) => {
    const features = value && typeof value === 'object'
      ? (value as { features?: Record<string, unknown> }).features
      : null;
    return features?.session_resources === true
      && features.session_chat_streaming === true
      && features.session_model_lock === true;
  },
  hasHermesProfileModel: (options: { providers: Array<{ id: string; models: string[] }> }, provider: string, model: string) => (
    options.providers.some((item) => item.id === provider && item.models.includes(model))
  ),
  HERMES_DEFAULT_PROFILE: 'default',
  listHermesProfileModels: profileMocks.listModels,
  normalizeHermesProfile: (value: unknown) => {
    const profile = String(value ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? profile : null;
  },
}));

const capabilities = () => Response.json({
  features: {
    session_resources: true,
    session_chat_streaming: true,
    session_model_lock: true,
  },
});

const doneStream = () => new Response([
  'event: assistant.delta',
  'data: {"delta":"Done."}',
  '',
  'event: assistant.completed',
  'data: {"content":"Done."}',
  '',
  'event: done',
  'data: {}',
  '',
].join('\n'), { status: 200 });

describe('Hermes chat projection', () => {
  beforeEach(() => {
    profileMocks.listModels.mockResolvedValue({
      profile: 'default',
      provider: 'openrouter',
      model: 'model-a',
      providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  it('uses the runtime path for files copied into a Work sandbox', () => {
    const messages: UIMessage[] = [{
      id: 'm1',
      role: 'user',
      parts: [{
        type: 'file',
        mediaType: 'text/plain',
        filename: 'notes.txt',
        url: '/api/v1/attachments/attachment-1',
        providerMetadata: { toolplane: { runtimePath: '/opt/data/workspace/notes.txt' } },
      }],
    }];

    expect(uiMessagesToHermes(messages)[0].content).toContain('/opt/data/workspace/notes.txt');
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
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({ object: 'hermes.session' }, { status: 201 }))
      .mockResolvedValueOnce(new Response([
        'event: assistant.delta',
        'data: {"delta":"I will inspect."}',
        '',
        'event: assistant.delta',
        'data: {"delta":"Final result."}',
        '',
        'event: run.completed',
        'data: {"session_id":"conversation-1"}',
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
      4,
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

  it('uses a cloned conversation runtime-session alias for Hermes requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({ object: 'hermes.session' }, { status: 201 }))
      .mockResolvedValueOnce(doneStream())
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await writeHermesChatStream({
      agent: {
        id: 'target-agent',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue the copied session.' }],
      }],
      conversationId: 'target-conversation',
      runtimeSessionId: 'source-conversation',
      sessionKey: 'agent:source-agent:console:source-conversation',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4312/hermes/api/sessions/source-conversation/chat/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-hermes-session-id': 'source-conversation',
          'x-hermes-session-key': 'agent:source-agent:console:source-conversation',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4312/hermes/api/sessions/source-conversation/messages',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('routes a conversation model override through the selected Hermes profile', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({ error: { code: 'session_exists' } }, { status: 409 }))
      .mockResolvedValueOnce(doneStream())
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

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
        parts: [{ type: 'text', text: 'Use the research profile.' }],
      }],
      conversationId: 'conversation-1',
      profile: 'research',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4312/hermes/p/research/api/sessions/conversation-1/chat/stream',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      message: 'Use the research profile.',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      model_options: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4312/hermes/p/research/api/sessions/conversation-1/messages',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('re-resolves a profile default for every turn', async () => {
    profileMocks.listModels
      .mockResolvedValueOnce({
        profile: 'default',
        provider: 'openrouter',
        model: 'model-a',
        providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a'] }],
      })
      .mockResolvedValueOnce({
        profile: 'default',
        provider: 'toolplane-provider',
        model: 'model-b',
        providers: [{ id: 'toolplane-provider', name: 'ToolPlane', models: ['model-b'] }],
      });
    const fetchMock = vi.fn();
    for (let turn = 0; turn < 2; turn += 1) {
      fetchMock
        .mockResolvedValueOnce(capabilities())
        .mockResolvedValueOnce(Response.json({}, { status: turn === 0 ? 201 : 409 }))
        .mockResolvedValueOnce(doneStream())
        .mockResolvedValueOnce(Response.json({ data: [] }));
    }
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{ id: 'user-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Hello' }] }],
      conversationId: 'conversation-1',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    };

    await writeHermesChatStream(input);
    await writeHermesChatStream(input);

    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      provider: 'openrouter', model: 'model-a',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[6][1]?.body))).toMatchObject({
      provider: 'toolplane-provider', model: 'model-b',
    });
  });

  it('falls back to the legacy default-profile stream with full history', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ features: { chat_completions: true } }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Legacy reply"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const write = vi.fn();

    await expect(writeHermesChatStream({
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
        { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'First answer' }] },
        { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Follow up' }] },
      ],
      conversationId: 'conversation-1',
      reasoningEffort: 'low',
      writer: { write } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    })).resolves.toEqual({ runtimeSessionId: 'conversation-1' });

    expect(profileMocks.listModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4312/hermes/v1/chat/completions',
      expect.objectContaining({ body: expect.any(String) }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' },
      ],
      model_options: { reasoning: { enabled: true, effort: 'low' } },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'text-delta',
      delta: 'Legacy reply',
    }));
  });

  it('fails closed for an explicit selection when Hermes lacks session model locking', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      features: { session_resources: true, session_chat_streaming: true },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(writeHermesChatStream({
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      conversationId: 'conversation-1',
      profile: 'research',
      provider: 'openrouter',
      model: 'model-a',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    })).rejects.toThrow('requires runtime v0.20.0 or newer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a truncated HTTP 200 stream', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockResolvedValueOnce(new Response([
        'event: assistant.delta',
        'data: {"delta":"Partial"}',
        '',
      ].join('\n'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(writeHermesChatStream({
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      conversationId: 'conversation-1',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    })).rejects.toThrow('before the turn completed');
  });

  it('returns the effective session id after Hermes compression rollover', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(new Response([
        'event: assistant.delta',
        'data: {"delta":"Done"}',
        '',
        'event: assistant.completed',
        'data: {"content":"Done","session_id":"conversation-child"}',
        '',
      ].join('\n'), { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(writeHermesChatStream({
      agent: {
        id: 'agent-1',
        slug: 'hermes',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes' },
      },
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      conversationId: 'conversation-1',
      writer: { write: vi.fn() } as unknown as UIMessageStreamWriter<HermesUIMessage>,
    })).resolves.toEqual({ runtimeSessionId: 'conversation-child' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4312/hermes/api/sessions/conversation-child/messages',
      expect.any(Object),
    );
  });
});
