import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceAssistantChat } from '@/components/dashboard/chat/WorkspaceAssistantChat';

const mocks = vi.hoisted(() => ({ conversation: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock('@/components/dashboard/agents/AgentConversation', () => ({
  AgentConversation: (props: unknown) => {
    mocks.conversation(props);
    const conversation = props as {
      onBranchChange?: (messageId: string) => void;
      onStartBranch?: (messageId: string) => void;
    };
    return (
      <div>
        Chat surface
        <div id="chat-message-a1">Active message</div>
        <button type="button" onClick={() => conversation.onBranchChange?.('a1')}>Test active branch</button>
        <button type="button" onClick={() => conversation.onStartBranch?.('a1')}>Test new branch</button>
      </div>
    );
  },
}));

function renderChat(
  branch?: Parameters<typeof WorkspaceAssistantChat>[0]['branch'],
  startCreating = false,
  providers: Parameters<typeof WorkspaceAssistantChat>[0]['providers'] = [
    { id: 'provider-1', name: 'Provider', format: 'openai', models: ['model-1'] },
    { id: 'provider-2', name: 'Second provider', format: 'anthropic', models: ['model-2'] },
  ],
  marketTemplate: Parameters<typeof WorkspaceAssistantChat>[0]['marketTemplate'] = null,
  marketTemplates: Parameters<typeof WorkspaceAssistantChat>[0]['marketTemplates'] = [],
  assistants: Parameters<typeof WorkspaceAssistantChat>[0]['assistants'] = [{
    id: 'assistant-1',
    name: 'Helper',
    systemPrompt: null,
    modelProviderId: 'provider-1',
    model: 'model-1',
    maxSteps: 8,
    providerName: 'Provider',
    deploymentIds: [],
    threads: [{
      id: 'thread-1',
      title: 'First thread',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastMessageAt: null,
    }],
  }],
) {
  return render(<WorkspaceAssistantChat
    assistants={assistants}
    deployments={[]}
    initialMessages={[]}
    providers={providers}
    reasoningAvailable
    selectedAssistantId="assistant-1"
    selectedThreadId="thread-1"
    slug="acme"
    startCreating={startCreating}
    marketTemplate={marketTemplate}
    marketTemplates={marketTemplates}
    workspaceId="workspace-1"
    branch={branch}
  />);
}

describe('WorkspaceAssistantChat', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('uses the API step limit and enables persisted branch regeneration', async () => {
    renderChat();

    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({
      allowRegenerate: true,
      attachmentUploadUrl: '/api/v1/workspaces/workspace-1/attachments',
      supportsAttachments: true,
      initialReasoningEffort: 'default',
      reasoningAvailable: true,
    }));

    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));
    expect(screen.getByRole('spinbutton', { name: 'Maximum MCP steps' })).toHaveAttribute('max', '20');
  });

  it('moves a dragged chat to another assistant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      thread: { id: 'thread-1', assistantId: 'assistant-2' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderChat(undefined, false, undefined, null, [], [
      {
        id: 'assistant-1',
        name: 'Helper',
        systemPrompt: null,
        modelProviderId: 'provider-1',
        model: 'model-1',
        maxSteps: 8,
        providerName: 'Provider',
        deploymentIds: [],
        threads: [{
          id: 'thread-1',
          title: 'First thread',
          createdAt: '2026-08-25T00:00:00.000Z',
          lastMessageAt: null,
        }],
      },
      {
        id: 'assistant-2',
        name: 'Writer',
        systemPrompt: null,
        modelProviderId: 'provider-1',
        model: 'model-1',
        maxSteps: 8,
        providerName: 'Provider',
        deploymentIds: [],
        threads: [],
      },
    ]);
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    const sourceAssistant = screen.getByRole('link', { name: 'Helper' });
    const targetAssistant = screen.getByRole('link', { name: 'Writer' });
    const sourceDisclosure = screen.getByRole('button', { name: 'Helper' });
    const targetDisclosure = screen.getByRole('button', { name: 'Writer' });
    expect(sourceAssistant.firstElementChild).toHaveClass('size-6');
    expect(sourceAssistant.parentElement?.lastElementChild).toBe(sourceDisclosure);
    expect(targetAssistant.parentElement?.lastElementChild).toBe(targetDisclosure);
    expect(sourceDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(targetDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
    fireEvent.click(targetDisclosure);
    expect(targetDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
    fireEvent.click(targetDisclosure);
    const source = screen.getByRole('link', { name: 'First thread' }).closest('li')!;
    const target = targetAssistant.parentElement!;

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/threads/thread-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantId: 'assistant-2' }),
      });
      expect(mocks.push).toHaveBeenCalledWith('/app/acme/chat?assistant=assistant-2&thread=thread-1');
    });
  });

  it('keeps editor values and shows the server error when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Provider rejected the configuration',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));
    renderChat();
    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));

    const name = screen.getByRole('textbox', { name: 'Name' });
    const prompt = screen.getByRole('textbox', { name: 'System prompt' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Unsaved helper');
    await userEvent.type(prompt, 'Keep this prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider rejected the configuration');
    expect(name).toHaveValue('Unsaved helper');
    expect(prompt).toHaveValue('Keep this prompt');
  });

  it('steps through assistant creation without losing entered values', async () => {
    renderChat(undefined, true);

    expect(screen.getByRole('navigation', { name: 'Assistant configuration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-current', 'step');

    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.type(name, 'Research helper');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('button', { name: 'System prompt' })).toHaveAttribute('aria-current', 'step');
    const prompt = screen.getByRole('textbox', { name: 'System prompt' });
    await userEvent.type(prompt, 'Use primary sources.');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(name).toHaveValue('Research helper');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(prompt).toHaveValue('Use primary sources.');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('button', { name: 'MCP access' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Create assistant' })).toBeInTheDocument();
  });

  it('validates the name but allows a draft without a model', async () => {
    renderChat(undefined, true, []);

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();
    await userEvent.click(next);
    expect(screen.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-current', 'step');

    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft helper');
    await userEvent.click(next);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  });

  it('prefills a selected market assistant template', async () => {
    renderChat(undefined, true, undefined, {
      releaseId: 'release-1',
      name: 'Market researcher',
      summary: 'Researches primary sources.',
      tags: ['research'],
      systemPrompt: 'Use primary sources.',
      maxSteps: 12,
      providerFormat: 'anthropic',
      model: 'model-2',
      deploymentIds: [],
    });

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Market researcher');
    expect(screen.getByRole('button', { name: 'Model: model-2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Market template selected' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('textbox', { name: 'System prompt' })).toHaveValue('Use primary sources.');
  });

  it('shows unresolved market template MCP requirements before creation', async () => {
    renderChat(undefined, true, undefined, {
      releaseId: 'release-1',
      name: 'Market researcher',
      summary: null,
      tags: [],
      systemPrompt: null,
      maxSteps: 8,
      providerFormat: null,
      model: null,
      deploymentIds: [],
      missingMcpNames: ['Search MCP'],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Required MCP servers are not installed: Search MCP.');
    expect(screen.getByRole('link', { name: 'Browse MCP market' })).toHaveAttribute('href', '/app/acme/market/mcp');
  });

  it('selects an assistant market template without leaving the creator', async () => {
    const user = userEvent.setup();
    const template = {
      releaseId: 'release-1',
      name: 'Market researcher',
      summary: 'Researches primary sources.',
      tags: ['research'],
      systemPrompt: 'Use primary sources.',
      maxSteps: 12,
      providerFormat: 'anthropic',
      model: 'model-2',
      deploymentIds: [],
    };
    renderChat(undefined, true, undefined, null, [template]);

    expect(screen.queryByRole('link', { name: 'Choose from assistant market' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose from assistant market' }));
    await user.click(screen.getByRole('button', { name: /Market researcher/ }));

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Market researcher');
    expect(screen.getByRole('button', { name: 'Model: model-2' })).toBeInTheDocument();
  });

  it('switches the active assistant model from the shared picker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Keep page mounted' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Model: model-1' }));
    await userEvent.click(screen.getByRole('option', { name: 'model-2' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelProviderId: 'provider-2', model: 'model-2' }),
    });
  });

  it('always exposes branches and creates one from an assistant message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      branch: { activeMessageId: 'draft-1', activated: true },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderChat({
      activeMessageId: 'a1',
      branchCount: 1,
      navigation: [],
      nodes: [{
        id: 'a1',
        parentId: null,
        role: 'assistant',
        status: 'success',
        modelId: 'model-1',
        createdAt: '2026-08-25T00:00:00.000Z',
        preview: 'Answer',
        active: true,
        awaitingInput: false,
      }],
    });

    expect(screen.getByRole('button', { name: 'Show conversation branches' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test new branch' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/threads/thread-1/branches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'a1' }),
      });
      expect(mocks.refresh).toHaveBeenCalled();
    });
  });

  it('locates an active-path node without issuing a branch switch', async () => {
    const fetchMock = vi.fn();
    const scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    Element.prototype.scrollIntoView = scrollIntoView;
    renderChat({
      activeMessageId: 'a1',
      branchCount: 1,
      navigation: [],
      nodes: [{
        id: 'a1',
        parentId: null,
        role: 'assistant',
        status: 'success',
        modelId: 'model-1',
        createdAt: '2026-08-25T00:00:00.000Z',
        preview: 'Answer',
        active: true,
        awaitingInput: false,
      }],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Test active branch' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
