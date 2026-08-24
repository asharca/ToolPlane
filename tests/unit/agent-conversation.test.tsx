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
    expect(input.closest('form')).toHaveClass('rounded-[20px]', 'border-[0.5px]', 'border-border', 'transition-all');
    expect(screen.getByRole('button', { name: 'Open tools' }).querySelector('svg')).toHaveClass('lucide-plus');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('size-[30px]', 'text-brand');
    await userEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    expect(input).toHaveClass('max-h-[max(220px,50vh)]');
    expect(screen.getByRole('button', { name: 'Restore composer' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Restore composer' }));
    expect(input).toHaveClass('max-h-[max(220px,40vh)]');
    const copyButton = screen.getByRole('button', { name: 'Copy' });
    expect(copyButton.parentElement?.parentElement).toHaveClass('min-h-[26px]');
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
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

  it('opens tools for every runtime and only enables Hermes attachments', async () => {
    const { props, rerender } = renderConversation();

    const toolsButton = screen.getByRole('button', { name: 'Open tools' });
    expect(toolsButton).toBeEnabled();
    await userEvent.click(toolsButton);
    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeDisabled();
    expect(screen.getByText('Attachments are available for Hermes agents only.')).toBeInTheDocument();

    rerender(<AgentConversation {...props} runtimeKind="hermes" />);

    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeEnabled();
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
  });
});
