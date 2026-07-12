import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

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

    expect(chatMocks.setMessages).toHaveBeenLastCalledWith(secondMessages);
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
