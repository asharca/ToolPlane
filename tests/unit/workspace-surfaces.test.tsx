import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceKnowledge } from '@/components/dashboard/knowledge/WorkspaceKnowledge';
import { WorkspaceWork } from '@/components/dashboard/work/WorkspaceWork';

const surfaceMocks = vi.hoisted(() => ({ sandboxConsole: vi.fn() }));

vi.mock('@/lib/agents/actions', () => ({ deleteAgentAction: vi.fn() }));
vi.mock('@/lib/sandboxes/actions', () => ({ startSandboxAction: vi.fn() }));

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: () => <div>Conversation surface</div>,
}));

vi.mock('@/components/dashboard/agents/AgentModelDialog', () => ({
  AgentModelDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

vi.mock('@/components/dashboard/sandboxes/SandboxConsole', () => ({
  SandboxConsole: (props: { filesOnly?: boolean; terminalOnly?: boolean }) => {
    surfaceMocks.sandboxConsole(props);
    return <div>{props.filesOnly ? 'Files surface' : 'Terminal surface'}</div>;
  },
}));

class WorkEventSource {
  static latest: WorkEventSource | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    WorkEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  WorkEventSource.latest = null;
  vi.unstubAllGlobals();
});

describe('Chat, Work, and Knowledge surfaces', () => {
  it('starts Work from the chat composer without a task form', () => {
    render(<WorkspaceWork
      slug="acme"
      workspaceId="workspace-1"
      agents={[{
        id: 'agent-1',
        name: 'Builder',
        supportsWork: true,
        ready: true,
        runtimeKind: 'pi',
        sandboxes: [{ id: 'sandbox-1', name: 'Workspace', kind: 'docker', deploymentId: 'deployment-1', running: true, isDefault: true }],
      }, {
        id: 'agent-hermes',
        name: 'Hermes researcher',
        supportsWork: true,
        ready: true,
        runtimeKind: 'hermes',
        providerIds: ['provider-hermes'],
        providerLabel: 'OpenAI',
        sandboxes: [{ id: 'sandbox-hermes', name: 'Hermes runtime', kind: 'hermes', deploymentId: 'deployment-hermes', running: false, isDefault: true }],
      }]}
      sessions={[]}
      selectedWorkSessionId={null}
    />);

    const input = screen.getByPlaceholderText('What should the Agent accomplish?');
    expect(input).toHaveAttribute('rows', '2');
    expect(input.closest('form')).toHaveClass('group/composer', 'hover:border-foreground/25', 'focus-within:border-foreground/25');
    const expand = screen.getByRole('button', { name: 'Expand composer' });
    expect(expand).toHaveClass('group-hover/composer:opacity-100');
    fireEvent.click(expand);
    expect(Number(input.getAttribute('rows'))).toBeGreaterThan(2);
    expect(screen.getByRole('button', { name: 'Restore composer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveTextContent('Builder');
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sandbox' })).toHaveTextContent('Workspace');
    expect(screen.getByRole('button', { name: 'Working directory' })).toHaveTextContent('/workspace');
    expect(screen.getByRole('link', { name: 'Add agent' })).toHaveAttribute(
      'href',
      '/app/acme/agents?create=1&returnTo=%2Fapp%2Facme%2Fwork',
    );
    expect(screen.queryByRole('link', { name: 'Manage agents' })).not.toBeInTheDocument();
    const hermesRow = screen.getByRole('button', { name: 'Hermes researcher' }).parentElement!;
    expect(screen.getByRole('button', { name: 'New work · Hermes researcher' })).toBeInTheDocument();
    fireEvent.contextMenu(hermesRow, { clientX: 80, clientY: 120 });
    expect(screen.getByRole('menuitem', { name: 'New work' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Chat' })).toHaveAttribute('href', '/app/acme/chat?agent=agent-hermes');
    const agentRow = screen.getByRole('button', { name: 'Builder' }).parentElement!;
    fireEvent.contextMenu(agentRow, { clientX: 80, clientY: 120 });
    expect(screen.getByRole('menuitem', { name: 'New work' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Chat' })).toHaveAttribute('href', '/app/acme/chat?agent=agent-1');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      expect.stringContaining('/app/acme/agents/agent-1?settings=agent'),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete agent' }));
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete agent' });
    expect(deleteDialog).toHaveTextContent('Delete this agent and all its conversations?');
    expect(deleteDialog.querySelector('input[name="returnTo"]')).toHaveValue('/app/acme/work');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('Acceptance criteria')).not.toBeInTheDocument();
    expect(screen.queryByText('Run budget')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('opens separate Work file and terminal drawers for a selected session', () => {
    render(<WorkspaceWork
      slug="acme"
      workspaceId="workspace-1"
      agents={[{ id: 'agent-1', name: 'Builder', supportsWork: true, ready: true, runtimeKind: 'pi', sandboxes: [] }]}
      sessions={[{
        id: 'work-1', agentId: 'agent-1', title: 'Ship release', task: 'Ship release',
        acceptanceCriteria: 'Release is live', runtimeKind: 'pi', status: 'completed',
        maxSteps: 12, stepCount: 0, waitingQuestion: null, result: null, error: null,
        artifacts: [], approvals: [], conversationId: 'conversation-1', messages: [
          { id: 'message-user', role: 'user', parts: [{ type: 'text', text: 'Ship it' }] },
          {
            id: 'message-assistant',
            role: 'assistant',
            parts: [
              { type: 'text', text: 'Release shipped' },
              { type: 'data-context-usage', data: { usedTokens: 64, maxTokens: 100, modelName: 'gpt-test', estimated: false } },
            ],
          },
        ],
        sandbox: { id: 'sandbox-1', name: 'Workspace', kind: 'docker', deploymentId: 'deployment-1', running: true },
      }]}
      selectedWorkSessionId="work-1"
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByRole('dialog', { name: 'Files' })).toHaveTextContent('Files surface');
    expect(surfaceMocks.sandboxConsole).toHaveBeenLastCalledWith(expect.objectContaining({
      filesOnly: true,
      terminalOnly: false,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('dialog', { name: 'Terminal' })).toHaveTextContent('Terminal surface');
    expect(surfaceMocks.sandboxConsole).toHaveBeenLastCalledWith(expect.objectContaining({
      filesOnly: false,
      terminalOnly: true,
    }));

    const agentGroup = screen.getByRole('button', { name: 'Builder' });
    expect(agentGroup).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Ship release')).toBeInTheDocument();
    fireEvent.click(agentGroup);
    expect(screen.queryByText('Ship release')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings: Builder' })).toHaveAttribute(
      'href',
      expect.stringContaining('/app/acme/agents/agent-1?settings=agent'),
    );
    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    expect(copyButtons).toHaveLength(2);
    expect(copyButtons[0]).toHaveClass('opacity-0', 'group-hover/message:opacity-100', 'group-focus-within/message:opacity-100');
    expect(screen.getByRole('meter', { name: 'Context usage 64%' })).toHaveAttribute('aria-valuenow', '64');
  });

  it('renders Work deltas before loading the final persisted reply', async () => {
    const finalSession = {
      id: 'work-1', agentId: 'agent-1', title: 'Stream reply', task: 'Stream reply',
      acceptanceCriteria: null, runtimeKind: 'pi', status: 'idle',
      maxSteps: 12, stepCount: 1, waitingQuestion: null, result: null, error: null,
      artifacts: [], approvals: [], conversationId: 'conversation-1', messages: [
        { id: 'message-user', role: 'user', parts: [{ type: 'text', text: 'Reply slowly' }] },
        { id: 'message-assistant', role: 'assistant', parts: [
          { type: 'work-tool', toolCallId: 'call-1', toolName: 'read_file', input: '{}', output: 'contents', isError: false, status: 'completed' as const },
          { type: 'text', text: 'Hello' },
        ] },
      ],
      sandbox: { id: 'sandbox-1', name: 'Workspace', kind: 'docker', deploymentId: 'deployment-1', running: true },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(finalSession), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', WorkEventSource);

    render(<WorkspaceWork
      slug="acme"
      workspaceId="workspace-1"
      agents={[{ id: 'agent-1', name: 'Builder', supportsWork: true, ready: true, runtimeKind: 'pi', sandboxes: [] }]}
      sessions={[{ ...finalSession, status: 'running', messages: finalSession.messages.slice(0, 1) }]}
      selectedWorkSessionId="work-1"
    />);

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    expect(WorkEventSource.latest?.url).toBe('/api/v1/work-sessions/work-1/events');
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => WorkEventSource.latest?.emit('activity', { activities: [{
      id: 'tool:call-1', type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'read_file', input: '{}',
    }] }));
    expect(await screen.findByText('Using read_file')).toBeInTheDocument();
    expect(screen.getAllByText('read_file')).toHaveLength(1);
    act(() => WorkEventSource.latest?.emit('activity', { activities: [{
      id: 'tool:call-1', type: 'tool', status: 'completed', toolCallId: 'call-1', toolName: 'read_file', input: '{}', output: 'contents',
    }] }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getAllByText('read_file')).toHaveLength(1);

    act(() => WorkEventSource.latest?.emit('delta', { delta: 'Hel' }));
    expect(await screen.findByText('Hel')).toBeInTheDocument();
    act(() => WorkEventSource.latest?.emit('delta', { delta: 'lo' }));
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => WorkEventSource.latest?.emit('done', {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('Hello')).toHaveLength(1));
    expect(screen.getAllByText('read_file')).toHaveLength(1);
  });

  it('switches Knowledge task views without stacking all controls', () => {
    render(<WorkspaceKnowledge
      slug="acme"
      providers={[{ id: 'provider-1', name: 'OpenAI', models: ['text-embedding-3-small'] }]}
      sandboxes={[]}
      agents={[{ id: 'agent-1', name: 'Researcher' }]}
      initialBases={[{
        id: 'base-1', name: 'Handbook', providerId: 'provider-1', providerName: 'OpenAI', embeddingModel: 'text-embedding-3-small',
        chunkSize: 1200, chunkOverlap: 200, topK: 6, threshold: 0.2, agentIds: [], documents: [],
      }]}
    />);

    expect(screen.getByText('No documents indexed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recall test' }));
    expect(screen.getByText('Test semantic retrieval')).toBeInTheDocument();
    expect(screen.queryByText('No documents indexed')).not.toBeInTheDocument();
  });
});
