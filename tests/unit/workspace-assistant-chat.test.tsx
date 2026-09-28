import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { estimatePromptTokens, WorkspaceAssistantChat } from '@/components/dashboard/chat/WorkspaceAssistantChat';

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
      modelPicker?: ReactNode;
    };
    return (
      <div>
        Chat surface
        {conversation.modelPicker}
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
    pinned: false,
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
  initialSidebarOpen = true,
  initialExpandedAssistants: Parameters<typeof WorkspaceAssistantChat>[0]['initialExpandedAssistants'] = {},
  initialGroupPreferences: Parameters<typeof WorkspaceAssistantChat>[0]['initialGroupPreferences'] = undefined,
) {
  return render(<WorkspaceAssistantChat
    assistants={assistants}
    deployments={[]}
    initialMessages={[]}
    providers={providers}
    reasoningAvailable
    selectedAssistantId="assistant-1"
    selectedThreadId="thread-1"
    initialExpandedAssistants={initialExpandedAssistants}
    initialGroupPreferences={initialGroupPreferences}
    initialSidebarOpen={initialSidebarOpen}
    slug="acme"
    startCreating={startCreating}
    marketTemplate={marketTemplate}
    marketTemplates={marketTemplates}
    workspaceId="workspace-1"
    branch={branch}
  />);
}

function stubMutationFetch(fetchMock: typeof fetch) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('&running=1')
      ? Promise.resolve(Response.json({ runningThreadIds: [] }))
      : fetchMock(input, init));
}

const sidebarAssistants: Parameters<typeof WorkspaceAssistantChat>[0]['assistants'] = [1, 2, 3].map((id) => ({
  id: `assistant-${id}`,
  name: ['Match Alpha', 'Hidden assistant', 'Match Gamma'][id - 1],
  pinned: false,
  systemPrompt: null,
  modelProviderId: 'provider-1',
  model: 'model-1',
  maxSteps: 8,
  providerName: 'Provider',
  deploymentIds: [],
  threads: (id === 1 ? [1, 2, 3] : [id + 3]).map((threadId) => ({
    id: `thread-${threadId}`,
    title: threadId === 2 ? 'Hidden thread' : `Find thread ${threadId}`,
    createdAt: '2026-08-25T00:00:00.000Z',
    lastMessageAt: null,
  })),
}));

describe('WorkspaceAssistantChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.cookie = 'toolplane_assistant_chat_sidebar_workspace-1=; Path=/; Max-Age=0';
    document.cookie = 'toolplane_assistant_chat_expanded_workspace-1=; Path=/; Max-Age=0';
    document.cookie = 'toolplane_assistant_chat_group_preferences_workspace-1=; Path=/; Max-Age=0';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows running badges from server state and removes them when execution settles', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(Response.json({ runningThreadIds: ['thread-1'] }))
      .mockResolvedValueOnce(Response.json({ runningThreadIds: [] }));
    vi.stubGlobal('fetch', status);
    renderChat();
    expect(await screen.findByRole('status', { name: 'Helper: Running' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'First thread: Running' })).toBeVisible();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Helper: Running' })).not.toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'First thread: Running' })).not.toBeInTheDocument();
    });
  });

  it.each(['Close', 'Cancel', 'Escape', 'Dismiss modal'])('keeps assistant configuration mounted through the native exit after %s', async (method) => {
    renderChat();
    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));
    const panel = screen.getByRole('dialog', { name: 'Assistant settings' });
    await userEvent.clear(within(panel).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Name' }), 'Discarded');
    if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: method }));

    expect(panel).toBeInTheDocument();
    expect(panel.closest('[inert]')).not.toBeNull();
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Helper');
  });

  it('estimates mixed CJK and Latin system prompt tokens', () => {
    expect(estimatePromptTokens('你好 hello')).toBe(4);
    expect(estimatePromptTokens('   ')).toBe(0);
  });

  it('uses the sidebar header to add assistants and list existing conversations', async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'List options' }));
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'List options' }));
    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    expect(screen.getByRole('dialog', { name: 'Add assistant' })).toBeInTheDocument();
  });

  it('selects a thread from the assistant tree', async () => {
    const user = userEvent.setup();
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const tree = screen.getByRole('tree', { name: 'Assistants' });

    expect(within(tree).getByRole('treeitem', { name: /Match Alpha/ })).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: /Find thread 1/ })).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: /Find thread 3/ })).toBeInTheDocument();
    await user.click(within(tree).getByRole('treeitem', { name: /Find thread 3/ }));
    expect(mocks.push).toHaveBeenCalledWith('/app/acme/chat?assistant=assistant-1&thread=thread-3');
  });

  it('closes the mobile assistant drawer after selecting a thread', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);

    await user.click(screen.getByRole('button', { name: 'Show assistants and chats' }));
    await user.click(screen.getByRole('treeitem', { name: /Find thread 3/ }));

    expect(mocks.push).toHaveBeenCalledWith('/app/acme/chat?assistant=assistant-1&thread=thread-3');
    expect(screen.getByRole('button', { name: 'Show assistants and chats' })).toBeInTheDocument();
  });

  it('uses the API step limit and enables persisted branch regeneration', async () => {
    renderChat();

    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({
      allowRegenerate: true,
      attachmentUploadUrl: '/api/v1/workspaces/workspace-1/attachments',
      supportsAttachments: true,
      initialReasoningEffort: 'default',
      mcpResourceApiPath: '/api/v1/chat/threads/thread-1/composer',
      onNewConversation: expect.any(Function),
      reasoningAvailable: true,
    }));

    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));
    await userEvent.click(screen.getByRole('button', { name: 'MCP access' }));
    expect(screen.getByRole('spinbutton', { name: 'Maximum tool-call rounds' })).toHaveAttribute('max', '1000');
  });

  it('edits, pins, and confirms deletion from the assistant resource menu', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      assistant: { id: 'assistant-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const confirmMock = vi.fn().mockReturnValue(false);
    stubMutationFetch(fetchMock);
    vi.stubGlobal('confirm', confirmMock);
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Actions for Helper' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Assistant settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Actions for Helper' }));
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    }));

    await user.click(screen.getByRole('button', { name: 'Actions for Helper' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirmMock).toHaveBeenCalledWith('Delete this assistant and all of its chats?');
  });

  it('unpins an assistant from its resource menu', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      assistant: { id: 'assistant-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    stubMutationFetch(fetchMock);
    renderChat(undefined, false, undefined, null, [], [{
      id: 'assistant-1', name: 'Helper', pinned: true, systemPrompt: null,
      modelProviderId: 'provider-1', model: 'model-1', maxSteps: 8, providerName: 'Provider',
      deploymentIds: [], threads: [],
    }]);

    await user.click(screen.getByRole('button', { name: 'Actions for Helper' }));
    await user.click(screen.getByRole('button', { name: 'Unpin' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    }));
  });

  it('offers only deletion in thread actions while preserving drag moves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      thread: { id: 'thread-1', assistantId: 'assistant-2' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    stubMutationFetch(fetchMock);
    renderChat(undefined, false, undefined, null, [], [
      {
        id: 'assistant-1', name: 'Helper', pinned: false, systemPrompt: null,
        modelProviderId: 'provider-1', model: 'model-1', maxSteps: 8, providerName: 'Provider', deploymentIds: [],
        threads: [{ id: 'thread-1', title: 'First thread', createdAt: '2026-08-25T00:00:00.000Z', lastMessageAt: null }],
      },
      {
        id: 'assistant-2', name: 'Writer', pinned: false, systemPrompt: null,
        modelProviderId: 'provider-1', model: 'model-1', maxSteps: 8, providerName: 'Provider', deploymentIds: [], threads: [],
      },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for First thread' }));
    const menu = document.querySelector('[data-sidebar-resource-menu="thread:thread-1"]') as HTMLElement;
    expect(within(menu).getAllByRole('button').map((button) => button.textContent)).toEqual(['Delete chat']);
    await user.keyboard('{Escape}');
    const source = screen.getByRole('treeitem', { name: /First thread/ });
    const target = screen.getByRole('treeitem', { name: /Writer/ });
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 100, top: 100, bottom: 132, left: 0, right: 200, width: 200, height: 32, toJSON: () => ({}),
    });
    fireEvent.dragStart(source, { dataTransfer });
    const over = createEvent.dragOver(target, { dataTransfer });
    Object.defineProperty(over, 'clientY', { value: 116 });
    fireEvent(target, over);
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
    await userEvent.clear(name);
    await userEvent.type(name, 'Unsaved helper');
    await userEvent.click(screen.getByRole('button', { name: 'System prompt' }));
    const prompt = screen.getByRole('textbox', { name: 'System prompt' });
    await userEvent.type(prompt, 'Keep this prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider rejected the configuration');
    expect(name).toHaveValue('Unsaved helper');
    expect(prompt).toHaveValue('Keep this prompt');
  });

  it('generates a prompt and saves description and model parameters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        prompt: 'Find primary sources, cite them, and state uncertainty.',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Keep page mounted' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }));
    stubMutationFetch(fetchMock);
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: 'Assistant settings: Helper' }));
    const description = screen.getByRole('textbox', { name: 'Description' });
    await userEvent.type(description, 'Finds primary sources.');
    await userEvent.click(screen.getByRole('button', { name: 'System prompt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Generate prompt' }));

    expect(await screen.findByRole('textbox', { name: 'System prompt' }))
      .toHaveValue('Find primary sources, cite them, and state uncertainty.');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/chat/assistants/generate-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace-1',
        name: 'Helper',
        description: 'Finds primary sources.',
        systemPrompt: null,
        modelProviderId: 'provider-1',
        model: 'model-1',
      }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Preview system prompt' }));
    expect(screen.getByText('Find primary sources, cite them, and state uncertainty.')).toBeInTheDocument();
    expect(screen.getByText(`Estimated tokens: ${estimatePromptTokens('Find primary sources, cite them, and state uncertainty.')}`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Model parameters' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use custom temperature' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Temperature' }), { target: { value: '0.4' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use custom Top P' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Top P' }), { target: { value: '0.8' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use custom maximum output tokens' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max output tokens' }), { target: { value: '2048' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Custom parameter name' }), 'top_k');
    await userEvent.click(screen.getByRole('combobox', { name: 'Custom parameter type' }));
    await userEvent.click(screen.getByRole('option', { name: 'number' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Value: top_k' }), { target: { value: '40' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Helper',
        description: 'Finds primary sources.',
        systemPrompt: 'Find primary sources, cite them, and state uncertainty.',
        modelProviderId: 'provider-1',
        model: 'model-1',
        modelParameters: {
          temperature: 0.4,
          topP: 0.8,
          maxOutputTokens: 2048,
          customParameters: [{ name: 'top_k', type: 'number', value: 40 }],
        },
        maxSteps: 8,
        deploymentIds: [],
      }),
    }));
  });

  it('steps through assistant creation without losing entered values', async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    const dialog = screen.getByRole('dialog', { name: 'Add assistant' });

    expect(within(dialog).getByRole('navigation', { name: 'Assistant configuration' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-current', 'step');

    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'Research helper');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(within(dialog).getByRole('button', { name: 'System prompt' })).toHaveAttribute('aria-current', 'step');
    const prompt = within(dialog).getByRole('textbox', { name: 'System prompt' });
    await user.type(prompt, 'Use primary sources.');
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));

    expect(name).toHaveValue('Research helper');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(prompt).toHaveValue('Use primary sources.');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(within(dialog).getByRole('button', { name: 'Model parameters' })).toHaveAttribute('aria-current', 'step');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(within(dialog).getByRole('button', { name: 'MCP access' })).toHaveAttribute('aria-current', 'step');
    expect(within(dialog).getByRole('spinbutton', { name: 'Maximum tool-call rounds' })).toHaveValue(100);
    expect(within(dialog).getByRole('button', { name: 'Create assistant' })).toBeInTheDocument();
  });

  it('requires a name and model before advancing assistant creation', async () => {
    const user = userEvent.setup();
    renderChat(undefined, false, []);
    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    const dialog = screen.getByRole('dialog', { name: 'Add assistant' });

    const next = within(dialog).getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Draft helper');
    expect(next).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-current', 'step');
  });



  it('shows unresolved market template MCP requirements before creation', async () => {
    const user = userEvent.setup();
    const template = {
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
    };
    renderChat(undefined, false, undefined, null, [template]);
    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    let dialog = screen.getByRole('dialog', { name: 'Add assistant' });
    await user.click(within(dialog).getByRole('button', { name: 'Choose from assistant market' }));
    await user.click(within(dialog).getByRole('button', { name: /Market researcher/ }));
    dialog = await screen.findByRole('dialog', { name: 'Add assistant' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Required MCP servers are not installed: Search MCP.');
    expect(within(dialog).getByRole('link', { name: 'Browse MCP market' })).toHaveAttribute('href', '/app/acme/market/mcp');
  });

  it('selects a market template and prefills the assistant creator', async () => {
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
    renderChat(undefined, false, undefined, null, [template]);
    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    let dialog = screen.getByRole('dialog', { name: 'Add assistant' });
    await user.click(within(dialog).getByRole('button', { name: 'Choose from assistant market' }));
    await user.click(within(dialog).getByRole('button', { name: /Market researcher/ }));
    dialog = await screen.findByRole('dialog', { name: 'Add assistant' });

    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Market researcher');
    expect(within(dialog).getByRole('button', { name: 'Model: model-2' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Market template selected' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Edit system prompt' }));
    expect(within(dialog).getByRole('textbox', { name: 'System prompt' })).toHaveValue('Use primary sources.');
  });

  it('switches the active assistant model from the shared picker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Keep page mounted' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    stubMutationFetch(fetchMock);
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
    stubMutationFetch(fetchMock);
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
    stubMutationFetch(fetchMock);
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
