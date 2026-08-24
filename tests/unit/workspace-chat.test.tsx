import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { WorkspaceChat } from '@/components/dashboard/agents/WorkspaceChat';

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: ({ agentId, activeConversationId, ensureConversation }: {
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
  deleteConversationAction: vi.fn(),
  renameConversationAction: vi.fn(),
  updateAgentModelAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const agents = [
  { id: 'agent-1', name: 'Research agent', providerId: 'provider-1', providerIds: [], model: 'gpt-5', providerLabel: 'OpenAI · gpt-5', ready: true, runtimeKind: 'native' },
  { id: 'agent-2', name: 'Support agent', providerLabel: 'Anthropic · Claude', ready: false, runtimeKind: 'hermes' },
];

function renderChat(conversations: ComponentProps<typeof WorkspaceChat>['conversations'] = []) {
  return render(
    <WorkspaceChat
      slug="acme"
      agentId="agent-1"
      conversationId="conversation-1"
      initialMessages={[]}
      providers={[{ id: 'provider-1', name: 'OpenAI', models: ['gpt-5'] }]}
      agents={agents}
      conversations={conversations}
    />,
  );
}

describe('WorkspaceChat', () => {
  it('renders a Cherry-style agent rail with a create action and selected agent', () => {
    renderChat();

    expect(screen.getByRole('link', { name: 'Add agent' })).toHaveAttribute('href', '/app/acme/agents/new');
    expect(screen.getByRole('button', { name: 'Research agent' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Support agent' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'New chat · Research agent' }).closest('form')).toHaveFormValues({
      workspace: 'acme',
      agentId: 'agent-1',
    });
    expect(screen.getByRole('button', { name: 'New chat · Support agent' }).closest('form')).toHaveFormValues({
      workspace: 'acme',
      agentId: 'agent-2',
    });
  });

  it('expands another agent conversations without switching the active chat', () => {
    renderChat([
      { id: 'support-chat', agentId: 'agent-2', title: 'Support queue', createdAt: 'Aug 24', lastMessageAt: null, source: null, editable: true },
    ]);

    expect(screen.queryByRole('link', { name: 'Support queue' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Support agent' }));
    expect(screen.getByRole('button', { name: 'Support agent' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Support queue' })).toHaveAttribute('href', '/app/acme/chat?agent=agent-2&c=support-chat');
    expect(screen.getByText('agent-1:conversation-1')).toBeInTheDocument();
  });

  it('opens model configuration from the chat header', () => {
    renderChat();

    expect(screen.queryByRole('link', { name: 'Start work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model configuration' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Model configuration');
    expect(screen.getByDisplayValue('gpt-5')).toBeInTheDocument();
  });

  it('filters nested conversations', () => {
    renderChat([
      { id: 'today', agentId: 'agent-1', title: 'Today notes', createdAt: 'Aug 24', lastMessageAt: 'Aug 24', source: null, editable: true },
      { id: 'old', agentId: 'agent-1', title: 'Old research', createdAt: 'Aug 10', lastMessageAt: null, source: null, editable: true },
      { id: 'channel', agentId: 'agent-1', title: 'Channel session', createdAt: 'Aug 24', lastMessageAt: null, source: { platform: 'discord', chatType: 'channel', chatId: 'support' }, editable: false },
    ]);

    expect(screen.getByRole('link', { name: 'discord · support' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Actions for discord · support' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations...' }), { target: { value: 'research' } });
    expect(screen.queryByRole('link', { name: 'Today notes' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Old research' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'discord · support' })).not.toBeInTheDocument();
  });
});
