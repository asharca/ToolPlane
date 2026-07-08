import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';

const chatMocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: chatMocks.useChat,
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('@streamdown/code', () => ({
  code: {},
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
  updateAgentAction: vi.fn(),
}));

const settings = {
  name: 'Test agent',
  systemPrompt: '',
  providerId: null,
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
  endpoint: 'http://localhost/api/v1/agents/agent-1/messages',
  connections: [],
  stats: { mcp: 0, skills: 0, toolkits: 0, sandboxes: 0, subAgents: 0 },
};

function renderChat({
  conversationId = 'conv-1',
  initialMessages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }] as UIMessage[],
  initialSettingsTab = null,
}: {
  conversationId?: string | null;
  initialMessages?: UIMessage[];
  initialSettingsTab?: 'agent' | 'channels' | null;
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
      settings={settings}
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
      status: 'ready',
      error: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-syncs local chat state when the selected conversation changes', () => {
    const firstMessages: UIMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] }];
    const secondMessages: UIMessage[] = [{ id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second' }] }];
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

    expect(chatMocks.setMessages).toHaveBeenLastCalledWith(secondMessages);
  });

  it('sends the active conversation id with each message submission', async () => {
    renderChat({ conversationId: 'conv-2' });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Need status');
    fireEvent.submit(screen.getByRole('button', { name: /send/i }).closest('form')!);

    await waitFor(() => {
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        { text: 'Need status' },
        { body: { conversationId: 'conv-2' } },
      );
    });
  });

  it('sends with Enter from the message box', async () => {
    renderChat({ conversationId: 'conv-2' });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Need status{enter}');

    await waitFor(() => {
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        { text: 'Need status' },
        { body: { conversationId: 'conv-2' } },
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
        { text: 'Start here' },
        { body: { conversationId: 'conv-new' } },
      );
    });
  });

  it('lets the conversation sidebar collapse and reopen', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Hide conversations' }));
    expect(screen.queryByText('First chat')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show conversations' }));
    expect(screen.getByText('First chat')).toBeInTheDocument();
  });

  it('opens agent settings from the chat header', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Close settings')).toBeInTheDocument();
  });

  it('keeps channel settings inside the settings dialog', async () => {
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Channels' }));

    expect(screen.getByText('Add channel')).toBeInTheDocument();
    expect(screen.getByText('Connected channels')).toBeInTheDocument();
  });

  it('can open channel settings from the initial settings tab', () => {
    renderChat({ initialSettingsTab: 'channels' });

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Connected channels')).toBeInTheDocument();
  });
});
