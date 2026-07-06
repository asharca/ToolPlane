import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';

const chatMocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
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

vi.mock('@/lib/agents/actions', () => ({
  createConversationAction: vi.fn(),
}));

function renderChat({
  conversationId = 'conv-1',
  initialMessages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }] as UIMessage[],
}: {
  conversationId?: string | null;
  initialMessages?: UIMessage[];
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
      channels={[]}
      ready
      agentName="Test agent"
      providerLabel="Provider · model"
    />,
  );
}

describe('AgentChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatMocks.useChat.mockReturnValue({
      messages: [{ id: 'local-1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }],
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      status: 'ready',
      error: undefined,
    });
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
        channels={[]}
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

    expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      { text: 'Need status' },
      { body: { conversationId: 'conv-2' } },
    );
  });
});
