import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

const chatMocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: chatMocks.useChat,
}));

vi.mock('@assistant-ui/react-streamdown', async () => {
  const assistantUi = await vi.importActual<typeof import('@assistant-ui/react')>('@assistant-ui/react');
  return {
    StreamdownTextPrimitive: () => {
      const part = assistantUi.useMessagePartText();
      return <div>{part.text}</div>;
    },
  };
});

vi.mock('streamdown', () => ({
  defaultRemarkPlugins: {},
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('@streamdown/code', () => ({
  code: {},
}));

vi.mock('@/components/dashboard/sandboxes/SandboxConsole', () => ({
  SandboxConsole: () => <div>Hermes shell</div>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/lib/agents/actions', () => ({
  createConversationAction: vi.fn(),
  createAgentChannelConnectionAction: vi.fn(),
  deleteAgentChannelConnectionAction: vi.fn(),
  requestAgentChannelPairingAction: vi.fn(),
  checkAgentChannelPairingAction: vi.fn(),
  applyAgentChannelPairingAction: vi.fn(),
  updateAgentChannelConnectionCredentialsAction: vi.fn(),
  startAgentChannelConnectionAction: vi.fn(),
  stopAgentChannelConnectionAction: vi.fn(),
  stopAgentRuntimeAction: vi.fn(),
  syncAgentRuntimeAction: vi.fn(),
  updateHermesRuntimeEnvAction: vi.fn(),
  updateAgentAction: vi.fn(),
}));

const settings = {
  name: 'Test agent',
  systemPrompt: '',
  providerId: null,
  providerIds: [],
  model: null,
  maxSteps: 8,
  providers: [],
  deployments: [],
  skills: [],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
};

const channelSettings = {
  connections: [],
};

const hermesRuntime = {
  kind: 'hermes',
  image: 'nousresearch/hermes-agent:latest',
  status: 'running',
  lastError: null,
  lastSyncedAt: '2026-07-11T00:00:00.000Z',
  sandboxId: 'sandbox-1',
  deploymentId: 'deployment-1',
  dashboardUrl: '/api/v1/agent-runtimes/runtime-1/dashboard/capability/',
};

function renderChat({
  conversationId = 'conv-1',
  initialMessages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }] as HermesUIMessage[],
  initialSettingsTab = null,
  runtime = null,
}: {
  conversationId?: string | null;
  initialMessages?: HermesUIMessage[];
  initialSettingsTab?: 'agent' | 'channels' | 'hermes' | 'terminal' | null;
  runtime?: typeof hermesRuntime | null;
} = {}) {
  return render(
    <AgentChat
      slug="acme"
      agentId="agent-1"
      conversationId={conversationId}
      initialMessages={initialMessages}
      conversations={[
        {
          id: 'conv-1',
          title: 'First chat',
          createdAt: 'Jul 6',
          messageCount: 1,
          lastMessageAt: 'Jul 6',
          source: null,
        },
        {
          id: 'conv-2',
          title: 'Second chat',
          createdAt: 'Jul 6',
          messageCount: 1,
          lastMessageAt: 'Jul 6',
          source: null,
        },
      ]}
      settings={{ ...settings, runtime }}
      channelSettings={channelSettings}
      ready
      agentName="Test agent"
      providerLabel="Provider · model"
      initialSettingsTab={initialSettingsTab}
    />,
  );
}

describe('AgentChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    apiMocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ conversationId: 'conv-new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', apiMocks.fetch);
    chatMocks.useChat.mockReturnValue({
      messages: [{ id: 'local-1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }],
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: vi.fn(),
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'ready',
      error: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-syncs local chat state when the selected conversation changes', () => {
    const firstMessages: HermesUIMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] }];
    const secondMessages: HermesUIMessage[] = [{ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second' }] }];
    const view = renderChat({ conversationId: 'conv-1', initialMessages: firstMessages });

    view.rerender(
      <AgentChat
        slug="acme"
        agentId="agent-1"
        conversationId="conv-2"
        initialMessages={secondMessages}
        conversations={[
          { id: 'conv-1', title: 'First chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
          { id: 'conv-2', title: 'Second chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
        ]}
        settings={settings}
        channelSettings={channelSettings}
        ready
        agentName="Test agent"
        providerLabel="Provider · model"
      />,
    );

    expect(chatMocks.useChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ messages: secondMessages }),
    );
  });

  it('re-syncs messages when the active conversation receives a server update', async () => {
    const firstMessages: HermesUIMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] }];
    const updatedMessages: HermesUIMessage[] = [
      ...firstMessages,
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'external update' }] },
    ];
    const view = renderChat({ conversationId: 'conv-1', initialMessages: firstMessages });

    view.rerender(
      <AgentChat
        slug="acme"
        agentId="agent-1"
        conversationId="conv-1"
        initialMessages={updatedMessages}
        conversations={[
          { id: 'conv-1', title: 'First chat', createdAt: 'Jul 6', messageCount: 2, lastMessageAt: 'Jul 6', source: null },
        ]}
        settings={settings}
        channelSettings={channelSettings}
        ready
        agentName="Test agent"
        providerLabel="Provider · model"
      />,
    );

    await waitFor(() => expect(chatMocks.setMessages).toHaveBeenCalledWith(updatedMessages));
  });

  it('renders Hermes assistant turn segments as separate messages', () => {
    const segmentedMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Inspect the file.' }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'I will inspect.\n\nFinal result.' },
          {
            type: 'data-hermes-messages',
            id: 'hermes-messages-conversation-1',
            data: {
              segments: [
                { id: '2', text: 'I will inspect.' },
                { id: '4', text: 'Final result.' },
              ],
            },
          },
        ],
      },
    ] as unknown as HermesUIMessage[];
    chatMocks.useChat.mockReturnValue({
      messages: segmentedMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: vi.fn(),
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'ready',
      error: undefined,
    });

    renderChat({ initialMessages: segmentedMessages, runtime: hermesRuntime });

    const preamble = screen.getByText('I will inspect.');
    const final = screen.getByText('Final result.');
    expect(preamble.closest('article')).not.toBe(final.closest('article'));
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('sends the active conversation id with each message submission', async () => {
    renderChat({ conversationId: 'conv-2' });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Need status');
    fireEvent.submit(screen.getByRole('button', { name: /send/i }).closest('form')!);

    await waitFor(() => {
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Need status' }],
        }),
        expect.objectContaining({ body: { conversationId: 'conv-2' } }),
      );
    });
  });

  it('sends with Enter from the message box', async () => {
    renderChat({ conversationId: 'conv-2' });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Need status{enter}');

    await waitFor(() => {
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Need status' }],
        }),
        expect.objectContaining({ body: { conversationId: 'conv-2' } }),
      );
    });
  });

  it('keeps the composer usable and creates a conversation before first send', async () => {
    renderChat({ conversationId: null, initialMessages: [] });

    const composer = screen.getByPlaceholderText('Message this agent');
    expect(composer).toBeEnabled();
    expect(screen.getByText('A conversation will be created when you send.')).toBeInTheDocument();

    await userEvent.type(composer, 'Start here');
    fireEvent.submit(screen.getByRole('button', { name: /send/i }).closest('form')!);

    await waitFor(() => {
      expect(apiMocks.fetch).toHaveBeenCalledWith('/api/v1/agents/agent-1/conversations', {
        method: 'POST',
      });
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Start here' }],
        }),
        expect.objectContaining({ body: { conversationId: 'conv-new' } }),
      );
    });
  });

  it('restores the text draft when automatic conversation creation fails', async () => {
    apiMocks.fetch.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    renderChat({ conversationId: null, initialMessages: [] });

    const composer = screen.getByPlaceholderText('Message this agent');
    await userEvent.type(composer, 'Keep this draft');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create a conversation');
    expect(composer).toHaveValue('Keep this draft');
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not let a late conversation creation overwrite a newly selected conversation', async () => {
    let finishCreation!: (response: Response) => void;
    apiMocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishCreation = resolve;
    }));
    const view = renderChat({ conversationId: null, initialMessages: [] });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'First draft');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiMocks.fetch).toHaveBeenCalledWith(
      '/api/v1/agents/agent-1/conversations',
      { method: 'POST' },
    ));

    view.rerender(
      <AgentChat
        slug="acme"
        agentId="agent-1"
        conversationId="conv-2"
        initialMessages={[]}
        conversations={[
          { id: 'conv-1', title: 'First chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
          { id: 'conv-2', title: 'Second chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
        ]}
        settings={settings}
        channelSettings={channelSettings}
        ready
        agentName="Test agent"
        providerLabel="Provider · model"
      />,
    );
    finishCreation(new Response(JSON.stringify({ conversationId: 'late-conversation' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalled());
    chatMocks.sendMessage.mockClear();
    const nextComposer = screen.getByPlaceholderText('Message this agent');
    await waitFor(() => expect(nextComposer).toBeEnabled());
    await userEvent.type(nextComposer, 'Second draft');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: 'text', text: 'Second draft' }],
      }),
      expect.objectContaining({ body: { conversationId: 'conv-2' } }),
    ));
  });

  it('uploads Hermes attachments through the assistant-ui adapter and creates one conversation', async () => {
    apiMocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/conversations')) {
        return new Response(JSON.stringify({ conversationId: 'conv-new' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/attachments')) {
        return new Response(JSON.stringify({
          name: 'uploaded.txt',
          runtimePath: `/workspace/${apiMocks.fetch.mock.calls.length}.txt`,
        }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderChat({ conversationId: null, initialMessages: [], runtime: hermesRuntime });

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ]);
    expect(await screen.findByText('one.txt')).toBeInTheDocument();
    expect(screen.getByText('two.txt')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Review these');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalled());
    const conversationCalls = apiMocks.fetch.mock.calls.filter(
      ([input]) => String(input).endsWith('/conversations'),
    );
    const attachmentCalls = apiMocks.fetch.mock.calls.filter(
      ([input]) => String(input).endsWith('/attachments'),
    );
    expect(conversationCalls).toHaveLength(1);
    expect(attachmentCalls).toHaveLength(2);
    expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        parts: expect.arrayContaining([
          { type: 'text', text: 'Review these' },
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Uploaded attachment in the Hermes workspace'),
          }),
        ]),
      }),
      expect.objectContaining({ body: { conversationId: 'conv-new' } }),
    );
  });

  it('limits the assistant-ui composer to five attachments without an unhandled rejection', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(fileInput!, Array.from({ length: 6 }, (_, index) => (
      new File([String(index)], `file-${index + 1}.txt`, { type: 'text/plain' })
    )));

    expect(await screen.findByText('file-1.txt')).toBeInTheDocument();
    expect(screen.getByText('file-5.txt')).toBeInTheDocument();
    expect(screen.queryByText('file-6.txt')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('up to 5 files');
  });

  it('keeps a batch attachment validation error after adding a valid file', async () => {
    renderChat();
    const oversized = new File(['large'], 'large.txt', { type: 'text/plain' });
    Object.defineProperty(oversized, 'size', { value: 10_000_001 });

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(fileInput!, [
      oversized,
      new File(['valid'], 'valid.txt', { type: 'text/plain' }),
    ]);

    expect(await screen.findByText('valid.txt')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('large.txt exceeds the 10 MB');
  });

  it('pins an attachment send to the conversation selected when upload starts', async () => {
    let finishUpload!: (response: Response) => void;
    apiMocks.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/attachments')) {
        return new Promise<Response>((resolve) => {
          finishUpload = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const view = renderChat({ conversationId: 'conv-1', runtime: hermesRuntime });

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(fileInput!, new File(['one'], 'one.txt', { type: 'text/plain' }));
    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Use this file');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiMocks.fetch).toHaveBeenCalledWith(
      '/api/v1/agents/agent-1/attachments',
      expect.objectContaining({ method: 'POST' }),
    ));

    view.rerender(
      <AgentChat
        slug="acme"
        agentId="agent-1"
        conversationId="conv-2"
        initialMessages={[]}
        conversations={[
          { id: 'conv-1', title: 'First chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
          { id: 'conv-2', title: 'Second chat', createdAt: 'Jul 6', messageCount: 1, lastMessageAt: 'Jul 6', source: null },
        ]}
        settings={{ ...settings, runtime: hermesRuntime }}
        channelSettings={channelSettings}
        ready
        agentName="Test agent"
        providerLabel="Provider · model"
      />,
    );
    finishUpload(new Response(JSON.stringify({
      name: 'one.txt',
      runtimePath: '/workspace/one.txt',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ body: { conversationId: 'conv-1' } }),
    ));
  });

  it('restores the complete composer when a Hermes attachment upload fails', async () => {
    apiMocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Hermes storage is unavailable.',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    renderChat({ conversationId: 'conv-1', runtime: hermesRuntime });

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(fileInput!, new File(['one'], 'one.txt', { type: 'text/plain' }));
    const composer = screen.getByPlaceholderText('Message this agent');
    await userEvent.type(composer, 'Keep the file and text');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Hermes storage is unavailable.');
    expect(composer).toHaveValue('Keep the file and text');
    expect(screen.getByText('one.txt')).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('restores an attachment draft when its conversation cannot be created', async () => {
    apiMocks.fetch.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    renderChat({ conversationId: null, initialMessages: [], runtime: hermesRuntime });

    await userEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    await userEvent.upload(fileInput!, new File(['one'], 'one.txt', { type: 'text/plain' }));
    const composer = screen.getByPlaceholderText('Message this agent');
    await userEvent.type(composer, 'Keep this first draft');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create a conversation');
    expect(composer).toHaveValue('Keep this first draft');
    expect(screen.getByText('one.txt')).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('stops a streaming response through the assistant-ui composer', async () => {
    chatMocks.useChat.mockReturnValue({
      messages: [{ id: 'local-1', role: 'assistant', parts: [{ type: 'text', text: 'working' }] }],
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: vi.fn(),
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'streaming',
      error: undefined,
    });
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(chatMocks.stop).toHaveBeenCalledOnce();
  });

  it('reveals the assistant-ui scroll control after scrolling away from the latest message', async () => {
    renderChat();
    const composer = screen.getByPlaceholderText('Message this agent');
    const viewport = composer.closest('form')?.parentElement?.previousElementSibling as HTMLElement;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });

    fireEvent.pointerDown(viewport);
    fireEvent.scroll(viewport);
    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Scroll to latest message' }),
    ).toBeEnabled());
  });

  it('lets the conversation sidebar collapse and reopen', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Hide conversations' }));
    expect(screen.queryByText('First chat')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
    expect(screen.getByText('First chat')).toBeInTheDocument();
  });

  it('collapses the conversation sidebar when the viewport becomes narrow', () => {
    let narrowViewport = false;
    let handleViewportChange: (() => void) | undefined;
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() {
        return narrowViewport;
      },
      addEventListener: (_type: string, listener: () => void) => {
        handleViewportChange = listener;
      },
      removeEventListener: vi.fn(),
    })));
    renderChat();
    expect(screen.getByText('First chat')).toBeInTheDocument();

    act(() => {
      narrowViewport = true;
      handleViewportChange?.();
    });

    expect(screen.queryByText('First chat')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show conversations' })).toBeInTheDocument();
  });

  it('starts with the conversation sidebar collapsed on a narrow viewport', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    renderChat();

    await waitFor(() => expect(screen.queryByText('First chat')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show conversations' })).toBeInTheDocument();
  });

  it('opens agent settings from the chat header', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Close settings')).toBeInTheDocument();
  });

  it('closes settings with Escape or a backdrop click but not an inside click', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    let dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.mouseDown(dialog);
    expect(dialog).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('removes a deep-linked settings parameter when the dialog closes', async () => {
    window.history.replaceState(
      {},
      '',
      '/app/acme/agents/agent-1?c=conv-1&settings=agent',
    );
    renderChat({ initialSettingsTab: 'agent' });

    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(window.location.pathname).toBe('/app/acme/agents/agent-1');
    expect(window.location.search).toBe('?c=conv-1');
  });

  it('keeps one stable settings frame while switching tabs', async () => {
    renderChat({ runtime: hermesRuntime });

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const frameClassName = dialog.className;

    await userEvent.click(screen.getByRole('button', { name: 'Hermes' }));
    expect(dialog.className).toBe(frameClassName);
    await userEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(dialog.className).toBe(frameClassName);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(dialog.className).toBe(frameClassName);
  });

  it('accepts an Escape close request from the Hermes iframe', () => {
    renderChat({ initialSettingsTab: 'hermes', runtime: hermesRuntime });

    const iframe = screen.getByTitle('Hermes runtime dashboard') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', {
      data: 'toolplane:close-agent-settings',
      source: iframe.contentWindow,
    }));

    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('keeps channel settings inside the settings dialog', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Channels' }));

    expect(await screen.findByText('Add channel')).toBeInTheDocument();
    expect(screen.getByText('Connected channels')).toBeInTheDocument();
  });

  it('hides channel configuration for Hermes agents', async () => {
    renderChat({ runtime: hermesRuntime, initialSettingsTab: 'channels' });

    expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add channel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveClass('bg-accent');
  });

  it('can open channel settings from the initial settings tab', async () => {
    renderChat({ initialSettingsTab: 'channels' });

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByText('Connected channels')).toBeInTheDocument();
  });

  it('lets the separate-origin Hermes dashboard use browser storage', () => {
    renderChat({ initialSettingsTab: 'hermes', runtime: hermesRuntime });

    const dashboard = screen.getByTitle('Hermes runtime dashboard');
    expect(dashboard).toHaveAttribute('src', hermesRuntime.dashboardUrl);
    expect(dashboard.getAttribute('sandbox')).toContain('allow-scripts');
    expect(dashboard.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(dashboard.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(screen.getByText(/managed by ToolPlane/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
  });
});
