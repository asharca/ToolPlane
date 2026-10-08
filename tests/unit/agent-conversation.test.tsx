import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

const chatMocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  regenerate: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: { id?: string }) => ({ ...chatMocks.useChat(options), id: options.id ?? 'test-chat' }),
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
  defaultRehypePlugins: {},
  defaultRemarkPlugins: {},
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('@streamdown/code', () => ({ code: {} }));

const initialMessages: HermesUIMessage[] = [
  { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
];

type ConversationProps = ComponentProps<typeof AgentConversation>;

function renderConversation(overrides: Partial<ConversationProps> = {}) {
  const ensureConversation = overrides.ensureConversation
    ?? vi.fn().mockResolvedValue(overrides.activeConversationId ?? 'conv-new');
  const props: ConversationProps = {
    activeConversationId: 'conv-1',
    agentId: 'agent-1',
    agentName: 'Test agent',
    creatingConversation: false,
    ensureConversation,
    initialMessages,
    ready: true,
    runtimeKind: null,
    ...overrides,
  };
  return { ensureConversation, props, ...render(<AgentConversation {...props} />) };
}

describe('AgentConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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
      messages: initialMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
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

  it('explicitly stops the server turn without treating unmount as cancellation', async () => {
    chatMocks.useChat.mockReturnValue({ ...chatMocks.useChat(), status: 'streaming' });
    apiMocks.fetch.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { headers: {
      'content-type': 'text/event-stream', 'X-Chat-Turn-Id': 'server-turn-1',
    } }));
    const view = renderConversation({ serverManaged: true, apiPath: '/api/v1/chat/threads/conv-1/turns', includeConversationIdInBody: false });
    const { transport } = chatMocks.useChat.mock.calls.at(-1)![0];
    const stream = await transport.sendMessages({
      chatId: 'conv-1', trigger: 'submit-message',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Work on the server' }] }],
      abortSignal: new AbortController().signal,
    });
    await stream.cancel();
    apiMocks.fetch.mockResolvedValueOnce(Response.json({ cancelled: true }));
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(apiMocks.fetch).toHaveBeenCalledWith('/api/v1/chat/threads/conv-1/turns', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: 'server-turn-1' }),
    }));
    expect(chatMocks.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(apiMocks.fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
  });

  it('renders branch position and delegates sibling navigation', async () => {
    const onBranchChange = vi.fn();
    renderConversation({
      branchNavigation: [{
        messageId: 'm1',
        position: 2,
        total: 3,
        previousMessageId: 'm0',
        nextMessageId: 'm2',
      }],
      onBranchChange,
    });

    expect(screen.getByText('2/3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onBranchChange).toHaveBeenNthCalledWith(1, 'm0');
    expect(onBranchChange).toHaveBeenNthCalledWith(2, 'm2');
  });

  it('starts a new branch from the assistant message actions', async () => {
    const onStartBranch = vi.fn();
    renderConversation({ onStartBranch });

    await userEvent.click(screen.getByRole('button', { name: 'Start a new branch' }));

    expect(onStartBranch).toHaveBeenCalledWith('m1');
  });

  it('disables the composer while a branch switch is being committed', () => {
    renderConversation({ branchBusy: true });

    expect(screen.getByPlaceholderText('Message this agent')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
  });

  it('sends an edited user message with its source id', async () => {
    const messages: HermesUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'original question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'original answer' }] },
    ];
    chatMocks.useChat.mockReturnValue({
      messages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'ready',
      error: undefined,
    });
    renderConversation({ allowEdit: true, initialMessages: messages, includeConversationIdInBody: false });

    await userEvent.hover(screen.getByText('original question'));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByDisplayValue('original question');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'edited question');
    await userEvent.click(within(editor.closest('form')!).getByRole('button', { name: 'Send prompt' }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ toolplaneEditMessageId: 'u1' }),
        parts: [{ type: 'text', text: 'edited question' }],
      }),
      expect.any(Object),
    ));
  });

  it('shows context usage and token details in the composer', async () => {
    const messages: HermesUIMessage[] = [{
      id: 'm-usage',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hello' },
        {
          type: 'data-context-usage',
          data: { usedTokens: 42, maxTokens: 100, modelName: 'gpt-test', estimated: false },
        },
      ],
    }];
    chatMocks.useChat.mockReturnValue({
      messages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'ready',
      error: undefined,
    });

    renderConversation({ initialMessages: messages });

    const meter = screen.getByRole('meter', { name: 'Context usage' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    await userEvent.hover(meter);
    expect((await screen.findAllByText('42 / 100 (42%)')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-test').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('syncs local messages when the active conversation changes', async () => {
    const firstMessages: HermesUIMessage[] = [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first' }] },
    ];
    const secondMessages: HermesUIMessage[] = [
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second' }] },
    ];
    const { props, rerender } = renderConversation({
      activeConversationId: 'conv-1',
      initialMessages: firstMessages,
    });

    rerender(
      <AgentConversation
        {...props}
        activeConversationId="conv-2"
        initialMessages={secondMessages}
      />,
    );

    await waitFor(() => expect(chatMocks.setMessages).toHaveBeenCalledWith(secondMessages));
  });

  it('keeps the conversation and work context when regenerating', async () => {
    renderConversation({ activeConversationId: 'conv-1', workSessionId: 'work-1' });

    await userEvent.click(screen.getByRole('button', { name: 'Retry response' }));

    await waitFor(() => expect(chatMocks.regenerate).toHaveBeenCalledWith(expect.objectContaining({
      body: { conversationId: 'conv-1', workSessionId: 'work-1' },
    })));
  });

  it('passes the persisted assistant id when regenerating a chat branch', async () => {
    renderConversation({ includeConversationIdInBody: false });

    await userEvent.click(screen.getByRole('button', { name: 'Retry response' }));

    await waitFor(() => expect(chatMocks.regenerate).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'm1',
    })));
  });

  it('refreshes persisted branch state when a request finishes', () => {
    const onConversationChanged = vi.fn();
    renderConversation({ onConversationChanged });

    const config = chatMocks.useChat.mock.calls.at(-1)?.[0] as { onFinish?: () => void };
    config.onFinish?.();

    expect(onConversationChanged).toHaveBeenCalledOnce();
  });

  it('can disable regeneration for a transport that persists every submitted turn', () => {
    renderConversation({ allowRegenerate: false });

    expect(screen.queryByRole('button', { name: 'Retry response' })).not.toBeInTheDocument();
    expect(chatMocks.regenerate).not.toHaveBeenCalled();
  });

  it('creates a conversation before the first message is sent', async () => {
    const ensureConversation = vi.fn().mockResolvedValue('conv-new');
    renderConversation({
      activeConversationId: null,
      ensureConversation,
      initialMessages: [],
    });

    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Start here');
    await userEvent.click(screen.getByRole('button', { name: 'Send prompt' }));

    await waitFor(() => {
      expect(ensureConversation).toHaveBeenCalledOnce();
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: [{ type: 'text', text: 'Start here' }],
        }),
        expect.objectContaining({ body: { conversationId: 'conv-new' } }),
      );
    });
  });

  it('enables attachments for stored native uploads and Hermes', async () => {
    const { props, rerender } = renderConversation();

    const toolsButton = screen.getByRole('button', { name: 'Open tools' });
    expect(toolsButton).toBeEnabled();
    await userEvent.click(toolsButton);
    expect(screen.getByRole('menuitem', { name: /Add attachment/ })).toBeDisabled();
    expect(screen.getByText('Attachments are not available for this runtime or sandbox.')).toBeInTheDocument();

    rerender(<AgentConversation {...props} attachmentUploadUrl="/api/v1/workspaces/workspace-1/attachments" />);

    expect(screen.getByRole('menuitem', { name: /Add attachment/ })).toBeEnabled();

    rerender(<AgentConversation {...props} runtimeKind="hermes" />);

    expect(screen.getByRole('menuitem', { name: /Add attachment/ })).toBeEnabled();
  });

  it('uploads a native attachment as an internal file part', async () => {
    apiMocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'attachment-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      url: '/api/v1/attachments/attachment-1',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    renderConversation({
      attachmentUploadUrl: '/api/v1/workspaces/workspace-1/attachments',
      runtimeKind: 'pi',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Add attachment/ }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Read this');
    await userEvent.click(screen.getByRole('button', { name: 'Send prompt' }));

    await waitFor(() => expect(apiMocks.fetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/workspace-1/attachments?filename=notes.txt',
      expect.objectContaining({ method: 'POST', body: expect.any(File) }),
    ));
    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: 'file',
            filename: 'notes.txt',
            mediaType: 'text/plain',
            url: '/api/v1/attachments/attachment-1',
          }),
        ]),
      }),
      expect.objectContaining({ body: { conversationId: 'conv-new' } }),
    ));
  });

  it('restores the composer when a Hermes attachment upload fails', async () => {
    apiMocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Hermes storage is unavailable.',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    renderConversation({ runtimeKind: 'hermes' });

    await userEvent.click(screen.getByRole('button', { name: 'Open tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Add attachment/ }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, new File(['one'], 'one.txt', { type: 'text/plain' }));
    const composer = screen.getByPlaceholderText('Message this agent');
    await userEvent.type(composer, 'Keep the file and text');
    await userEvent.click(screen.getByRole('button', { name: 'Send prompt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Hermes storage is unavailable.');
    expect(composer).toHaveValue('Keep the file and text');
    expect(screen.getByText('one.txt')).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('stops a streaming response', async () => {
    const streamingMessages: HermesUIMessage[] = [
      { id: 'm-streaming', role: 'assistant', parts: [] },
    ];
    chatMocks.useChat.mockReturnValue({
      messages: streamingMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'streaming',
      error: undefined,
    });
    renderConversation({ initialMessages: streamingMessages });

    await userEvent.click(screen.getByRole('button', { name: 'Stop generating' }));

    expect(chatMocks.stop).toHaveBeenCalledOnce();
  });

  it('renders reasoning and tool activity inside the assistant message', async () => {
    const messages = [{
      id: 'm-process',
      role: 'assistant' as const,
      parts: [
        { type: 'reasoning', text: 'Checking the available sources.' },
        {
          type: 'tool-web_search',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { query: 'ToolPlane' },
          output: { content: [{ type: 'text', text: 'Search result with citation' }] },
        },
        { type: 'text', text: 'Here is the answer.' },
      ],
    }] as HermesUIMessage[];
    chatMocks.useChat.mockReturnValue({
      messages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'ready',
      error: undefined,
    });

    renderConversation({ initialMessages: messages });

    const reasoning = screen.getByRole('button', { name: 'Thought' });
    expect(reasoning).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(reasoning);
    expect(reasoning).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Checking the available sources.')).toBeInTheDocument();
    const tool = screen.getByRole('button', { name: /web_search/ });
    expect(tool).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(tool);
    expect(tool).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Search result with citation/)).toBeInTheDocument();
    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
    expect(screen.queryByText('Agent is responding')).not.toBeInTheDocument();
  });

  it('renders live reasoning and tools directly without a generic process heading', async () => {
    const messages = [{
      id: 'm-live-process',
      role: 'assistant' as const,
      parts: [
        { type: 'reasoning', text: 'Checking the available sources.', state: 'streaming' },
        {
          type: 'tool-mcp__tp_1_dep-one__read/file',
          toolCallId: 'call-1',
          state: 'input-available',
          input: { path: 'README.md' },
        },
      ],
    }] as HermesUIMessage[];
    chatMocks.useChat.mockReturnValue({
      messages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: 'streaming',
      error: undefined,
    });

    renderConversation({ initialMessages: messages });

    await waitFor(() => expect(screen.getByText('Checking the available sources.')).toBeVisible());
    expect(screen.getByRole('button', { name: /read\/file/ })).toBeInTheDocument();
    expect(screen.queryByText('mcp__tp_1_dep-one__read/file')).not.toBeInTheDocument();
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();
    expect(screen.queryByText('Processed')).not.toBeInTheDocument();
  });

  it.each(['menu', 'slash', 'pinned'])('shows web search state and sends it when toggled from %s', async (entry) => {
    const user = userEvent.setup();
    if (entry === 'pinned') {
      window.localStorage.setItem('toolplane.conversation.composer.toolbar', '["web-search"]');
    }
    renderConversation({ webSearchAvailable: true });

    if (entry === 'pinned') {
      await user.click(screen.getByRole('button', { name: 'Enable web search', pressed: false }));
    } else {
      if (entry === 'slash') {
        await user.type(screen.getByPlaceholderText('Message this agent'), '/');
      } else {
        await user.click(screen.getByRole('button', { name: 'Open tools' }));
      }
      await user.click(await screen.findByRole('menuitem', { name: 'Enable web search' }));
    }
    const toggle = screen.getByRole('button', { name: 'Disable web search', pressed: true });
    expect(toggle).toBeVisible();
    expect(document.querySelectorAll('[data-composer-shortcut="web-search"]')).toHaveLength(1);
    const input = screen.getByPlaceholderText('Message this agent');
    await user.type(input, 'Find current sources');
    await user.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ body: expect.objectContaining({ webSearchEnabled: true }) }),
    ));

    await user.click(toggle);
    expect(screen.queryByRole('button', { name: 'Disable web search' })).not.toBeInTheDocument();
    if (entry === 'pinned') {
      expect(screen.getByRole('button', { name: 'Enable web search', pressed: false })).toBeVisible();
    }
    await user.type(input, 'Answer without searching');
    await user.click(screen.getByRole('button', { name: 'Send prompt' }));
    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ body: expect.objectContaining({ webSearchEnabled: false }) }),
    ));
  });

  it('reuses assistant chat tools for + and /, including attachments', async () => {
    const user = userEvent.setup();
    const onNewConversation = vi.fn();
    renderConversation({
      attachmentUploadUrl: '/attachments',
      mcpPromptApiPath: '/prompts',
      mcpResourceApiPath: '/composer',
      onNewConversation,
      webSearchAvailable: true,
    });

    const tools = screen.getByRole('button', { name: 'Open tools' });
    await user.click(tools);
    const plusMenu = await screen.findByRole('menu', { name: 'Tools' });
    expect(within(plusMenu).getByRole('menuitem', { name: /Add attachment/ })).toBeInTheDocument();
    expect(within(plusMenu).getByRole('menuitem', { name: 'MCP' })).toBeInTheDocument();
    expect(within(plusMenu).getByRole('menuitem', { name: 'MCP resources' })).toBeInTheDocument();
    expect(within(plusMenu).getByRole('menuitem', { name: 'MCP prompts' })).toBeInTheDocument();
    expect(within(plusMenu).getByRole('menuitem', { name: /Clear context/ })).toBeInTheDocument();
    expect(within(plusMenu).getByRole('menuitem', { name: 'Enable web search' })).toBeInTheDocument();
    await user.click(tools);

    await user.type(screen.getByPlaceholderText('Message this agent'), '/');
    const menu = await screen.findByRole('menu', { name: 'Tools' });
    expect(within(menu).getByRole('menuitem', { name: 'Add attachment' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'MCP' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'MCP resources' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'MCP prompts' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Clear context/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Enable web search' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: /Clear context/ }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('pins MCP resources in the toolbar and inserts the selected resource', async () => {
    const user = userEvent.setup();
    apiMocks.fetch.mockImplementation(async (input, init) => {
      if (String(input) === '/composer?section=resources') {
        return Response.json({ items: [{
          kind: 'resource',
          id: 'docs://plan',
          deploymentId: 'dep-1',
          label: 'Project plan',
          description: 'Workspace docs',
        }] });
      }
      if (String(input) === '/composer' && init?.method === 'POST') {
        return Response.json({ text: 'Reference material (resource): Project plan\ndocs://plan\nShip it.' });
      }
      return Response.json({ conversationId: 'conv-new' });
    });
    renderConversation({ mcpResourceApiPath: '/composer' });

    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Customize toolbar' }));
    const customizer = await screen.findByRole('dialog', { name: 'Customize toolbar' });
    await user.click(within(customizer).getByRole('checkbox', { name: 'Add attachment' }));
    await user.click(within(customizer).getByRole('checkbox', { name: 'MCP resources' }));
    const resources = within(customizer).getByRole('checkbox', { name: 'MCP resources' });
    const attachment = within(customizer).getByRole('checkbox', { name: 'Add attachment' });
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(resources.closest('[draggable]')!, { dataTransfer });
    fireEvent.dragOver(attachment.closest('[draggable]')!, { dataTransfer });
    fireEvent.drop(attachment.closest('[draggable]')!, { dataTransfer });
    expect([...document.querySelectorAll('[data-composer-shortcut]')].map((el) => el.getAttribute('aria-label'))).toEqual(['MCP resources', 'Add attachment']);
    await user.click(within(customizer).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: 'MCP resources' }));
    const picker = await screen.findByRole('dialog', { name: 'MCP resources' });
    await user.click(await within(picker).findByRole('button', { name: /Project plan/ }));
    await waitFor(() => expect((screen.getByPlaceholderText('Message this agent') as HTMLTextAreaElement).value).toContain('docs://plan'));

    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Customize toolbar' }));
    const resetDialog = await screen.findByRole('dialog', { name: 'Customize toolbar' });
    await user.click(within(resetDialog).getByRole('button', { name: 'Restore default toolbar' }));
    expect(document.querySelector('[data-composer-shortcut]')).toBeNull();
    await user.click(within(resetDialog).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(await screen.findByRole('menuitem', { name: 'MCP resources' })).toBeInTheDocument();
  });

  it('offers runtime slash commands and sends them through the command endpoint', async () => {
    const user = userEvent.setup();
    const onConversationChanged = vi.fn();
    renderConversation({ runtimeKind: 'dsh', onConversationChanged });

    const input = screen.getByPlaceholderText('Message this agent');
    await user.type(input, '/');
    const menu = await screen.findByRole('menu', { name: 'Tools' });
    expect(within(menu).getByRole('menuitem', { name: /compact/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /goal/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /compact/ }));
    expect(input).toHaveValue('/compact ');

    await user.type(input, 'preserve paths');
    await user.click(screen.getByRole('button', { name: 'Send prompt' }));

    await waitFor(() => expect(apiMocks.fetch).toHaveBeenCalledWith(
      '/api/v1/agents/agent-1/conversations/conv-new/commands',
      expect.objectContaining({ body: '{"line":"/compact preserve paths"}' }),
    ));
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    expect(onConversationChanged).toHaveBeenCalledTimes(1);
  });

  it('shows supported thinking efforts and snapshots the selection for send and regenerate', async () => {
    renderConversation({
      activeConversationId: 'conv-1',
      initialReasoningEffort: 'medium',
      reasoningAvailable: true,
    });

    const effort = screen.getByRole('button', { name: 'Thinking effort: Medium' });
    await userEvent.click(effort);
    const slider = screen.getByRole('slider', { name: 'Thinking effort' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuetext', 'High');
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Think carefully');
    await userEvent.click(screen.getByRole('button', { name: 'Send prompt' }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({
        body: expect.objectContaining({ conversationId: 'conv-1', reasoningEffort: 'high' }),
      }),
    ));

    await userEvent.click(screen.getByRole('button', { name: 'Retry response' }));
    await waitFor(() => expect(chatMocks.regenerate).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ conversationId: 'conv-1', reasoningEffort: 'high' }),
    })));
  });
});
