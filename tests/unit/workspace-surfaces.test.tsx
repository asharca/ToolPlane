import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceKnowledge } from '@/components/dashboard/knowledge/WorkspaceKnowledge';
import { WorkspaceWork } from '@/components/dashboard/work/WorkspaceWork';

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: () => <div>Conversation surface</div>,
}));

vi.mock('@/components/dashboard/sandboxes/SandboxConsole', () => ({
  SandboxConsole: () => <div>Sandbox surface</div>,
}));

describe('Chat, Work, and Knowledge surfaces', () => {
  it('opens the Work workspace drawer for a selected session', () => {
    render(<WorkspaceWork
      slug="acme"
      agents={[{ id: 'agent-1', name: 'Builder', ready: true, runtimeKind: 'native', sandboxes: [] }]}
      sessions={[{
        id: 'work-1', agentId: 'agent-1', title: 'Ship release', task: 'Ship release', status: 'active',
        conversationId: 'conversation-1', messages: [],
        sandbox: { id: 'sandbox-1', name: 'Workspace', deploymentId: 'deployment-1', running: true },
      }]}
      selectedWorkSessionId="work-1"
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(screen.getByRole('dialog', { name: 'Work sandbox' })).toHaveTextContent('Sandbox surface');
  });

  it('switches Knowledge task views without stacking all controls', () => {
    render(<WorkspaceKnowledge
      slug="acme"
      providers={[{ id: 'provider-1', name: 'OpenAI', models: ['text-embedding-3-small'] }]}
      sandboxes={[]}
      agents={[{ id: 'agent-1', name: 'Researcher' }]}
      initialBases={[{
        id: 'base-1', name: 'Handbook', providerName: 'OpenAI', embeddingModel: 'text-embedding-3-small',
        chunkSize: 1200, chunkOverlap: 200, topK: 6, threshold: 0.2, agentIds: [], documents: [],
      }]}
    />);

    expect(screen.getByText('No documents indexed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recall test' }));
    expect(screen.getByText('Test semantic retrieval')).toBeInTheDocument();
    expect(screen.queryByText('No documents indexed')).not.toBeInTheDocument();
  });
});
