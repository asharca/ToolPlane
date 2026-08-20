import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceChat } from '@/components/dashboard/agents/WorkspaceChat';

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: ({
    agentId,
    activeConversationId,
    ensureConversation,
  }: {
    agentId: string;
    activeConversationId: string | null;
    ensureConversation: () => Promise<string>;
  }) => (
    <div>
      <div>{`${agentId}:${activeConversationId}`}</div>
      <button type="button" onClick={() => void ensureConversation()}>Ensure conversation</button>
    </div>
  ),
}));

vi.mock('@/lib/agents/actions', () => ({
  createConversationAction: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('WorkspaceChat', () => {
  it('keeps agent and conversation navigation in the standalone chat route', () => {
    render(
      <WorkspaceChat
        slug="acme"
        agentId="agent-1"
        conversationId="conversation-1"
        initialMessages={[]}
        agents={[
          { id: 'agent-1', name: 'Research agent', providerLabel: 'OpenAI · gpt-5', ready: true, runtimeKind: 'native' },
          { id: 'agent-2', name: 'Support agent', providerLabel: 'Anthropic · Claude', ready: false, runtimeKind: 'hermes' },
        ]}
        conversations={[
          { id: 'conversation-1', title: 'Plan the launch', createdAt: 'Jul 11', lastMessageAt: 'Jul 12', source: null },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: 'New chat' }).closest('form')).toHaveFormValues({
      workspace: 'acme',
      agentId: 'agent-1',
      destination: 'chat',
    });
    expect(screen.getByRole('link', { name: /Support agent/ })).toHaveAttribute(
      'href',
      '/app/acme/chat?agent=agent-2',
    );
    expect(screen.getByRole('link', { name: /Plan the launch/ })).toHaveAttribute(
      'href',
      '/app/acme/chat?agent=agent-1&c=conversation-1',
    );
    expect(screen.getByRole('link', { name: /Research agent/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /Plan the launch/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('agent-1:conversation-1')).toBeInTheDocument();
  });

  it('does not reuse a pending conversation from another agent', async () => {
    let resolveFirst: (response: Response) => void;
    let resolveSecond: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/app/acme/chat?agent=agent-1');

    const view = render(
      <WorkspaceChat
        slug="acme"
        agentId="agent-1"
        conversationId={null}
        initialMessages={[]}
        agents={[{ id: 'agent-1', name: 'Research agent', providerLabel: 'OpenAI · gpt-5', ready: true, runtimeKind: 'native' }]}
        conversations={[]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ensure conversation' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agents/agent-1/conversations',
      { method: 'POST' },
    ));

    window.history.replaceState({}, '', '/app/acme/chat?agent=agent-2');
    view.rerender(
      <WorkspaceChat
        slug="acme"
        agentId="agent-2"
        conversationId={null}
        initialMessages={[]}
        agents={[{ id: 'agent-2', name: 'Support agent', providerLabel: 'Anthropic · Claude', ready: true, runtimeKind: 'native' }]}
        conversations={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ensure conversation' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agents/agent-2/conversations',
      { method: 'POST' },
    ));

    await act(async () => { resolveFirst!(new Response(JSON.stringify({ conversationId: 'conversation-1' }))); });
    expect(window.location.search).toBe('?agent=agent-2');
    await act(async () => { resolveSecond!(new Response(JSON.stringify({ conversationId: 'conversation-2' }))); });
    expect(window.location.search).toBe('?agent=agent-2&c=conversation-2');
  });
});
