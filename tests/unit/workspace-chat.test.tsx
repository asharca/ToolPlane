import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { WorkspaceChat } from '@/components/dashboard/agents/WorkspaceChat';

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: ({ agentId, activeConversationId, attachmentUploadUrl, ensureConversation, onBusyChange, onConversationChanged }: {
    agentId: string;
    activeConversationId: string | null;
    attachmentUploadUrl?: string;
    ensureConversation: () => Promise<string>;
    onBusyChange?: (busy: boolean) => void;
    onConversationChanged?: () => void | Promise<void>;
  }) => (
    <div>
      <div>{`${agentId}:${activeConversationId}`}</div>
      {attachmentUploadUrl ? <div>{attachmentUploadUrl}</div> : null}
      <button type="button" onClick={() => void ensureConversation()}>Ensure conversation</button>
      <button type="button" onClick={() => onBusyChange?.(true)}>Set chat busy</button>
      <button type="button" onClick={() => void onConversationChanged?.()}>Finish conversation</button>
    </div>
  ),
}));

const agentActions = vi.hoisted(() => ({
  createConversationAction: vi.fn(),
  deleteConversationAction: vi.fn(),
  generateConversationTitleAction: vi.fn(async (...args: [FormData]) => {
    void args;
    return {};
  }),
  renameConversationAction: vi.fn(),
  updateAgentModelAction: vi.fn(async (...args: [unknown, FormData]) => {
    void args;
    return {};
  }),
  updateHermesConversationSelectionAction: vi.fn(async (...args: [unknown, FormData]) => {
    void args;
    return {};
  }),
}));

vi.mock('@/lib/agents/actions', () => agentActions);

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const agents = [
  { id: 'agent-1', name: 'Research agent', providerId: 'provider-1', providerIds: [], model: 'gpt-5', providerLabel: 'OpenAI · gpt-5', ready: true, runtimeKind: 'pi' },
  { id: 'agent-2', name: 'Support agent', providerLabel: 'Anthropic · Claude', ready: false, runtimeKind: 'hermes' },
];

function renderChat(
  conversations: ComponentProps<typeof WorkspaceChat>['conversations'] = [],
  activeAgentId = 'agent-1',
) {
  return render(
    <WorkspaceChat
      slug="acme"
      workspaceId="workspace-1"
      agentId={activeAgentId}
      conversationId={activeAgentId === 'agent-1' ? 'conversation-1' : null}
      initialMessages={[]}
      providers={[
        { id: 'provider-1', name: 'OpenAI', format: 'openai', models: ['gpt-5', 'gpt-4.1'] },
        { id: 'provider-2', name: 'Anthropic', format: 'anthropic', models: ['claude-sonnet-4'] },
      ]}
      agents={agents}
      conversations={conversations}
    />,
  );
}

describe('WorkspaceChat', () => {
  it('renders a Cherry-style agent rail with a create action and selected agent', () => {
    renderChat();

    expect(screen.getByRole('link', { name: 'Add agent' })).toHaveAttribute(
      'href',
      '/app/acme/agents?create=1&returnTo=%2Fapp%2Facme%2Fchat%3Fagent%3Dagent-1%26c%3Dconversation-1',
    );
    const rail = screen.getByRole('complementary', { name: 'Agents' });
    const researchDisclosure = within(rail).getByRole('button', { name: 'Research agent' });
    const supportDisclosure = within(rail).getByRole('button', { name: 'Support agent' });
    expect(researchDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(supportDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(researchDisclosure.parentElement?.lastElementChild).toBe(researchDisclosure);
    expect(within(rail).getByText('No conversations yet.')).toBeInTheDocument();
    fireEvent.click(researchDisclosure);
    expect(within(rail).queryByText('No conversations yet.')).not.toBeInTheDocument();
    expect(screen.getByText('/api/v1/workspaces/workspace-1/attachments')).toBeInTheDocument();
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

  it('opens the Cherry model picker, filters groups, and saves on selection', async () => {
    renderChat();

    expect(screen.queryByRole('link', { name: 'Start work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model configuration' }));
    const picker = screen.getByRole('dialog', { name: 'Model configuration' });
    expect(picker).toHaveClass('h-[440px]', 'w-[400px]');
    expect(within(picker).getByRole('option', { name: 'gpt-5' })).toHaveAttribute('aria-selected', 'true');
    expect(within(picker).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    fireEvent.change(within(picker).getByRole('textbox', { name: 'Search models...' }), { target: { value: 'claude' } });
    expect(within(picker).queryByRole('option', { name: 'gpt-5' })).not.toBeInTheDocument();
    expect(within(picker).getByRole('group', { name: 'Anthropic' })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('option', { name: 'claude-sonnet-4' }));

    await waitFor(() => expect(agentActions.updateAgentModelAction).toHaveBeenCalledTimes(1));
    const formData = agentActions.updateAgentModelAction.mock.calls[0][1] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('providerId')).toBe('provider-2');
    expect(formData.get('model')).toBe('claude-sonnet-4');
  });

  it('selects a Hermes profile and conversation model instead of changing agent providers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/hermes/profiles')) {
        return Response.json({
          profiles: [{ name: 'default', isDefault: true, provider: 'openrouter', model: 'model-a', description: '' }],
          profileChatSupported: true,
        });
      }
      return Response.json({
        profile: 'default',
        provider: 'openrouter',
        model: 'model-a',
        providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] }],
      });
    }));
    renderChat([], 'agent-2');

    fireEvent.click(screen.getByRole('button', { name: 'Model configuration' }));
    const dialog = screen.getByRole('dialog', { name: 'Model configuration' });
    expect(await within(dialog).findByRole('combobox', { name: 'Hermes profile' })).toHaveValue('default');
    const useDefault = within(dialog).getByRole('checkbox', { name: /Use profile default model/ });
    expect(useDefault).toBeChecked();
    fireEvent.click(useDefault);
    fireEvent.click(await within(dialog).findByRole('button', { name: /model-a/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'model-b' }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(agentActions.updateHermesConversationSelectionAction).toHaveBeenCalledTimes(1));
    const formData = agentActions.updateHermesConversationSelectionAction.mock.calls[0][1] as FormData;
    expect(formData.get('profile')).toBe('default');
    expect(formData.get('provider')).toBe('openrouter');
    expect(formData.get('model')).toBe('model-b');
  });

  it('disables conversation model changes while a reply is streaming', () => {
    renderChat([], 'agent-2');
    const modelButton = screen.getByRole('button', { name: 'Model configuration' });
    expect(modelButton).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set chat busy' }));
    expect(modelButton).toBeDisabled();
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

  it('uses Cherry hover actions and inline rename instead of an overflow expander', () => {
    renderChat([
      { id: 'conversation-1', agentId: 'agent-1', title: 'Today notes', createdAt: 'Aug 24', lastMessageAt: 'Aug 24', source: null, editable: true },
    ]);

    const conversation = screen.getByRole('link', { name: 'Today notes' });
    const row = conversation.parentElement!;
    expect(screen.queryByRole('button', { name: 'Actions for Today notes' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete' }).querySelector('svg')).toHaveClass('lucide-x');

    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(within(row).getByRole('button', { name: 'Confirm' }).querySelector('svg')).toHaveClass('lucide-trash-2', 'text-destructive');

    fireEvent.doubleClick(conversation);
    expect(screen.getByRole('textbox', { name: 'Rename chat' })).toHaveValue('Today notes');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename chat' }), { key: 'Escape' });
    expect(screen.getByRole('link', { name: 'Today notes' })).toBeInTheDocument();
  });

  it('generates a title after a completed reply and refreshes the conversation list', async () => {
    renderChat([
      { id: 'conversation-1', agentId: 'agent-1', title: 'Plan our launch', createdAt: 'Aug 24', lastMessageAt: 'Aug 24', source: null, editable: true },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Finish conversation' }));

    await waitFor(() => expect(agentActions.generateConversationTitleAction).toHaveBeenCalledTimes(1));
    const formData = agentActions.generateConversationTitleAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('conversationId')).toBe('conversation-1');
    expect(formData.get('force')).toBeNull();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it('opens rename and destructive confirmation dialogs from the row context menu', async () => {
    const user = userEvent.setup();
    renderChat([
      { id: 'conversation-1', agentId: 'agent-1', title: 'Today notes', createdAt: 'Aug 24', lastMessageAt: 'Aug 24', source: null, editable: true },
    ]);

    const row = screen.getByRole('link', { name: 'Today notes' }).parentElement!;
    fireEvent.contextMenu(row, { clientX: 80, clientY: 120 });
    await user.click(await screen.findByRole('menuitem', { name: 'Generate chat title' }));
    await waitFor(() => expect(agentActions.generateConversationTitleAction).toHaveBeenCalledTimes(1));
    expect((agentActions.generateConversationTitleAction.mock.calls[0][0] as FormData).get('force')).toBe('1');

    fireEvent.contextMenu(row, { clientX: 80, clientY: 120 });
    await user.click(await screen.findByRole('menuitem', { name: 'Rename chat' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Rename chat');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Today notes');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.contextMenu(row, { clientX: 80, clientY: 120 });
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete chat');
    expect(screen.getByRole('dialog')).toHaveTextContent('This permanently deletes this chat and its messages.');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('ui-button-danger');
  });
});
