import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('uses the Cherry composer geometry and expand control', async () => {
    renderConversation();

    const input = screen.getByPlaceholderText('Message this agent');
    expect(input).toHaveAttribute('rows', '2');
    expect(input).toHaveClass('min-h-[46px]', 'max-h-[max(220px,40vh)]', 'pl-[15px]', 'pr-11', 'pb-0');
    expect(input.closest('form')).toHaveClass('group/composer', 'rounded-[20px]', 'border-[0.5px]', 'border-border', 'transition-all', 'hover:border-foreground/25', 'focus-within:border-foreground/25');
    expect(screen.getByRole('button', { name: 'Open tools' }).querySelector('svg')).toHaveClass('lucide-plus');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('size-[30px]', 'text-brand');
    const expand = screen.getByRole('button', { name: 'Expand composer' });
    expect(expand).toHaveClass('group-hover/composer:opacity-100', 'group-focus-within/composer:opacity-100');
    await userEvent.click(expand);
    expect(input).toHaveClass('max-h-[max(220px,50vh)]');
    expect(screen.getByRole('button', { name: 'Restore composer' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Restore composer' }));
    expect(input).toHaveClass('max-h-[max(220px,40vh)]');
    const copyButton = screen.getByRole('button', { name: 'Copy' });
    expect(copyButton.closest('[data-ui="assistant-reply"]')).toBeInTheDocument();
    expect(screen.getByText('Test agent').closest('[data-ui="assistant-reply"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
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
    expect(screen.getByText('hello').closest('[data-ui="assistant-reply"]')).toHaveAttribute('id', 'chat-message-m1');
  });

  it('disables the composer while a branch switch is being committed', () => {
    renderConversation({ branchBusy: true });

    expect(screen.getByPlaceholderText('Message this agent')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ toolplaneEditMessageId: 'u1' }),
        parts: [{ type: 'text', text: 'edited question' }],
      }),
      expect.any(Object),
    ));
  });

  it('shows Cherry-style context usage beside the send button', async () => {
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

    const meter = screen.getByRole('meter', { name: 'Context usage 42%' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    await userEvent.hover(meter);
    expect((await screen.findAllByText('42 / 100 (42%)')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-test').length).toBeGreaterThan(0);
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

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(chatMocks.regenerate).toHaveBeenCalledWith(expect.objectContaining({
      body: { conversationId: 'conv-1', workSessionId: 'work-1' },
    })));
  });

  it('passes the persisted assistant id when regenerating a chat branch', async () => {
    renderConversation({ includeConversationIdInBody: false });

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

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

    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
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
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!);

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
    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeDisabled();
    expect(screen.getByText('Attachments are not available for this runtime or sandbox.')).toBeInTheDocument();

    rerender(<AgentConversation {...props} attachmentUploadUrl="/api/v1/workspaces/workspace-1/attachments" />);

    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeEnabled();

    rerender(<AgentConversation {...props} runtimeKind="hermes" />);

    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeEnabled();
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
    await userEvent.click(screen.getByRole('button', { name: /Add attachment/ }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    await userEvent.type(screen.getByPlaceholderText('Message this agent'), 'Read this');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

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
    await userEvent.click(screen.getByRole('button', { name: /Add attachment/ }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, new File(['one'], 'one.txt', { type: 'text/plain' }));
    const composer = screen.getByPlaceholderText('Message this agent');
    await userEvent.type(composer, 'Keep the file and text');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Hermes storage is unavailable.');
    expect(composer).toHaveValue('Keep the file and text');
    expect(screen.getByText('one.txt')).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('stops a streaming response', async () => {
    chatMocks.useChat.mockReturnValue({
      messages: initialMessages,
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
    renderConversation();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(chatMocks.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveClass('text-destructive');
    expect(screen.getByRole('button', { name: 'Stop' }).querySelector('svg')).toHaveClass('lucide-circle-pause');
    expect(screen.getByRole('status')).toHaveTextContent('Agent is responding');
    expect(document.querySelectorAll('[data-ui="conversation-pending-dot"]')).toHaveLength(3);
  });
});
