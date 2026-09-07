import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function sidebarRow(kind: 'entity' | 'conversation', id: string) {
  return document.querySelector<HTMLElement>(`[data-sidebar-${kind}-id="${id}"]`)!;
}

function sidebarOrder(kind: 'entity' | 'conversation', root: ParentNode = document) {
  return Array.from(root.querySelectorAll(`[data-sidebar-${kind}-id]`), (row) => row.getAttribute(`data-sidebar-${kind}-id`));
}

function sidebarPreferences() {
  return JSON.parse(window.localStorage.getItem('toolplane:assistant-chat-groups:workspace-1') ?? '{}');
}

function dropSidebarRow(source: HTMLElement, target: HTMLElement, edge: 'before' | 'after') {
  const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
  const rect = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 100, top: 100, bottom: 132, left: 0, right: 200, width: 200, height: 32, toJSON: () => ({}),
  });
  fireEvent.dragStart(source, { dataTransfer });
  for (const type of ['dragOver', 'drop'] as const) {
    const event = createEvent[type](target, { dataTransfer });
    Object.defineProperty(event, 'clientY', { value: edge === 'before' ? 104 : 128 });
    fireEvent(target, event);
  }
  fireEvent.dragEnd(source, { dataTransfer });
  rect.mockRestore();
}

describe('WorkspaceAssistantChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.cookie = 'toolplane_assistant_chat_sidebar_workspace-1=; Path=/; Max-Age=0';
    document.cookie = 'toolplane_assistant_chat_expanded_workspace-1=; Path=/; Max-Age=0';
    document.cookie = 'toolplane_assistant_chat_group_preferences_workspace-1=; Path=/; Max-Age=0';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('estimates mixed CJK and Latin system prompt tokens', () => {
    expect(estimatePromptTokens('你好 hello')).toBe(4);
    expect(estimatePromptTokens('   ')).toBe(0);
  });

  it('uses the agent chat header spacing', () => {
    renderChat();

    expect(screen.getByRole('button', { name: 'Hide assistants and chats' }).closest('header')).toHaveClass('h-11', 'px-2.5');
  });

  it('restores the collapsed assistant sidebar after a refresh', async () => {
    const user = userEvent.setup();
    const firstRender = renderChat();

    await user.click(screen.getByRole('button', { name: 'Hide assistants and chats' }));
    expect(window.localStorage.getItem('toolplane:assistant-chat-sidebar:workspace-1')).toBe('false');
    firstRender.unmount();

    renderChat();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show assistants and chats', pressed: false }))
      .toHaveAttribute('aria-pressed', 'false'));
  });

  it('restores individual assistant conversation disclosures after a refresh', async () => {
    const user = userEvent.setup();
    const firstRender = renderChat();

    await user.click(screen.getByRole('button', { name: 'Helper' }));
    expect(JSON.parse(window.localStorage.getItem('toolplane:assistant-chat-expanded:workspace-1')!)).toEqual({
      'assistant-1': false,
    });
    expect(document.cookie).toContain('toolplane_assistant_chat_expanded_workspace-1=%7B%22assistant-1%22%3Afalse%7D');
    firstRender.unmount();

    renderChat();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helper' }))
      .toHaveAttribute('aria-expanded', 'false'));
  });

  it('uses server-seeded assistant disclosures on the first render', async () => {
    renderChat(undefined, false, undefined, null, [], undefined, true, { 'assistant-1': false });

    expect(screen.getByRole('button', { name: 'Helper' })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(document.cookie)
      .toContain('toolplane_assistant_chat_expanded_workspace-1=%7B%22assistant-1%22%3Afalse%7D'));
  });

  it('uses the server-seeded collapsed state before hydrating browser preferences', async () => {
    renderChat(undefined, false, undefined, null, [], undefined, false);

    expect(screen.getByRole('button', { name: 'Show assistants and chats', pressed: false }))
      .toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(document.cookie).toContain('toolplane_assistant_chat_sidebar_workspace-1=false'));
  });

  it('uses the sidebar header to add assistants and list existing conversations', async () => {
    const user = userEvent.setup();
    renderChat();

    expect(screen.getByRole('button', { name: 'Add assistant' })).toHaveTextContent('Add assistant');
    await user.click(screen.getByRole('button', { name: 'List options' }));
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose from assistant market' })).toHaveAttribute(
      'href',
      '/app/acme/market/assistants',
    );
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('First thread')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add assistant' }));
    expect(screen.getByRole('dialog', { name: 'Add assistant' })).toBeInTheDocument();
  });

  it('groups assistants, opens the target group after a drop, and persists the workspace preference', async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'List options' }));
    await user.click(screen.getByRole('button', { name: 'New group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Research');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const group = screen.getByText('Research').closest('[data-sidebar-group-id]') as HTMLElement;
    await user.click(screen.getByRole('button', { name: 'Hide Research' }));
    expect(screen.getByRole('button', { name: 'Show Research' })).toHaveAttribute('aria-expanded', 'false');

    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move to group' }), { dataTransfer });
    fireEvent.dragOver(group.firstElementChild!, { dataTransfer });
    fireEvent.drop(group.firstElementChild!, { dataTransfer });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide Research' })).toHaveAttribute('aria-expanded', 'true');
      expect(within(group).getByRole('link', { name: 'Helper' })).toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem('toolplane:assistant-chat-groups:workspace-1')!)).toEqual(expect.objectContaining({
        groups: [expect.objectContaining({ name: 'Research' })],
        assignments: { 'assistant-1': expect.any(String) },
      }));
    });
  });

  it('uses server-seeded assistant groups before browser preferences load', () => {
    renderChat(undefined, false, undefined, null, [], undefined, true, {}, {
      groups: [{ id: 'group-research', name: 'Research' }],
      assignments: { 'assistant-1': 'group-research' },
      collapsed: { 'group-research': true },
    });

    expect(screen.getByRole('button', { name: 'Show Research' })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([false, true])('orders assistants by row halves and restores preferences (grouped=%s)', (grouped) => {
    const preferences: Parameters<typeof WorkspaceAssistantChat>[0]['initialGroupPreferences'] = {
      groups: grouped ? [{ id: 'research', name: 'Research' }] : [],
      assignments: grouped ? Object.fromEntries(sidebarAssistants.map(({ id }) => [id, 'research'])) : {},
      collapsed: grouped ? { research: false } : {},
    };
    const mount = () => renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, preferences);
    const firstRender = mount();
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-3')).getByRole('button', { name: 'Move to group' }),
      sidebarRow('entity', 'assistant-1'), 'before',
    );
    expect(sidebarOrder('entity')).toEqual(['assistant-3', 'assistant-1', 'assistant-2']);
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' }),
      sidebarRow('entity', 'assistant-2'), 'after',
    );
    const order = ['assistant-3', 'assistant-2', 'assistant-1'];
    expect(sidebarOrder('entity')).toEqual(order);
    expect(sidebarPreferences()).toEqual({
      ...preferences,
      collapsed: { [grouped ? 'research' : '__ungrouped__']: false },
      entityOrder: order,
    });
    expect(document.cookie).toContain(encodeURIComponent(JSON.stringify(sidebarPreferences())));
    expect(mocks.push).not.toHaveBeenCalled();
    firstRender.unmount();
    mount();
    expect(sidebarOrder('entity')).toEqual(order);
  });

  it('adopts the target assistant group, allows cross-group pin moves, and can return to ungrouped', () => {
    const assistants = sidebarAssistants.map((assistant) => ({ ...assistant, pinned: assistant.id === 'assistant-1' }));
    renderChat(undefined, false, undefined, null, [], assistants, true, {}, {
      groups: [{ id: 'research', name: 'Research' }],
      assignments: { 'assistant-2': 'research' },
      collapsed: {},
    });
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' }),
      sidebarRow('entity', 'assistant-2'), 'after',
    );
    const research = document.querySelector('[data-sidebar-group-id="research"]')!;
    expect(sidebarOrder('entity', research)).toEqual(['assistant-1', 'assistant-2']);
    expect(sidebarPreferences().assignments).toEqual({ 'assistant-1': 'research', 'assistant-2': 'research' });
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' }),
      sidebarRow('entity', 'assistant-3'), 'after',
    );
    expect(sidebarPreferences().assignments).toEqual({ 'assistant-2': 'research' });
    expect(sidebarOrder('entity', document.querySelector('[data-sidebar-group-id="__ungrouped__"]')!))
      .toEqual(['assistant-1', 'assistant-3']);
  });

  it.each(['header', 'row'] as const)('opens collapsed Ungrouped after an assistant drop onto its %s', (target) => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, {
      groups: [{ id: 'research', name: 'Research' }],
      assignments: { 'assistant-1': 'research' },
      collapsed: { research: false, __ungrouped__: true },
    });
    expect(screen.getByRole('button', { name: 'Show Ungrouped' })).toHaveAttribute('aria-expanded', 'false');
    const group = document.querySelector<HTMLElement>('[data-sidebar-group-id="__ungrouped__"]')!;
    if (target === 'row') fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Match' } });
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' }),
      target === 'header' ? group.firstElementChild as HTMLElement : sidebarRow('entity', 'assistant-3'),
      'before',
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(sidebarPreferences().assignments).toEqual({});
    expect(sidebarPreferences().collapsed).toEqual({ research: false, __ungrouped__: false });
    expect(screen.getByRole('button', { name: 'Hide Ungrouped' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(group).getByRole('link', { name: 'Match Alpha' })).toBeInTheDocument();
  });

  it('opens a collapsed Ungrouped owner after transferring a chat through search results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      thread: { id: 'thread-1', assistantId: 'assistant-3' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, {
      groups: [{ id: 'research', name: 'Research' }],
      assignments: { 'assistant-1': 'research' },
      collapsed: { __ungrouped__: true },
    });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Match' } });
    dropSidebarRow(sidebarRow('conversation', 'thread-1'), sidebarRow('entity', 'assistant-3'), 'after');
    await waitFor(() => expect(sidebarPreferences().collapsed.__ungrouped__).toBe(false));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Hide Ungrouped' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Match Gamma' })).toBeInTheDocument();
    expect(mocks.push).toHaveBeenCalledWith('/app/acme/chat?assistant=assistant-3&thread=thread-1');
  });

  it('ignores assistant row and keyboard reorders across the same-group pin boundary', () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants.map((assistant) => ({
      ...assistant, pinned: assistant.id === 'assistant-2',
    })));
    const handle = within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' });
    dropSidebarRow(handle, sidebarRow('entity', 'assistant-2'), 'before');
    fireEvent.keyDown(handle, { altKey: true, key: 'ArrowUp' });
    expect(sidebarOrder('entity')).toEqual(['assistant-2', 'assistant-1', 'assistant-3']);
    expect(sidebarPreferences().entityOrder).toBeUndefined();
  });

  it('keeps hidden assistants in the full saved order when dragging search results', () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, {
      groups: [], assignments: {}, collapsed: {}, entityOrder: ['assistant-3', 'assistant-2', 'assistant-1'],
    });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Match' } });
    expect(sidebarOrder('entity')).toEqual(['assistant-3', 'assistant-1']);
    dropSidebarRow(
      within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' }),
      sidebarRow('entity', 'assistant-3'), 'before',
    );
    expect(sidebarPreferences().entityOrder).toEqual(['assistant-1', 'assistant-3', 'assistant-2']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(sidebarOrder('entity')).toEqual(['assistant-1', 'assistant-3', 'assistant-2']);
  });

  it('orders threads within their assistant, preserves other owners, and restores the order', () => {
    const preferences = {
      groups: [], assignments: {}, collapsed: {}, conversationOrder: { 'assistant-2': ['thread-5'] },
    };
    const mount = () => renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, preferences);
    const firstRender = mount();
    dropSidebarRow(sidebarRow('conversation', 'thread-3'), sidebarRow('conversation', 'thread-1'), 'before');
    expect(sidebarOrder('conversation').slice(0, 3)).toEqual(['thread-3', 'thread-1', 'thread-2']);
    dropSidebarRow(sidebarRow('conversation', 'thread-1'), sidebarRow('conversation', 'thread-2'), 'after');
    const order = ['thread-3', 'thread-2', 'thread-1'];
    expect(sidebarPreferences().conversationOrder).toEqual({ 'assistant-1': order, 'assistant-2': ['thread-5'] });
    expect(document.cookie).toContain(encodeURIComponent(JSON.stringify(sidebarPreferences())));
    expect(mocks.push).not.toHaveBeenCalled();
    firstRender.unmount();
    mount();
    expect(sidebarOrder('conversation').slice(0, 3)).toEqual(order);
  });

  it('keeps hidden threads in the full saved owner order when dragging search results', () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants, true, {}, {
      groups: [], assignments: {}, collapsed: {}, conversationOrder: { 'assistant-1': ['thread-3', 'thread-2', 'thread-1'] },
    });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Find' } });
    expect(sidebarOrder('conversation').slice(0, 2)).toEqual(['thread-3', 'thread-1']);
    dropSidebarRow(sidebarRow('conversation', 'thread-1'), sidebarRow('conversation', 'thread-3'), 'before');
    expect(sidebarPreferences().conversationOrder['assistant-1']).toEqual(['thread-1', 'thread-3', 'thread-2']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(sidebarOrder('conversation').slice(0, 3)).toEqual(['thread-1', 'thread-3', 'thread-2']);
  });

  it('supports Alt+Arrow ordering on handles and focused thread links without navigation', () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const handle = within(sidebarRow('entity', 'assistant-2')).getByRole('button', { name: 'Move to group' });
    handle.focus();
    expect(fireEvent.keyDown(handle, { altKey: true, key: 'ArrowUp' })).toBe(false);
    expect(handle).toHaveFocus();
    expect(sidebarPreferences().entityOrder).toEqual(['assistant-2', 'assistant-1', 'assistant-3']);
    fireEvent.keyDown(handle, { altKey: true, key: 'ArrowDown' });
    expect(sidebarPreferences().entityOrder).toEqual(['assistant-1', 'assistant-2', 'assistant-3']);
    const link = screen.getByRole('link', { name: 'Find thread 1' });
    link.focus();
    expect(fireEvent.keyDown(link, { altKey: true, key: 'ArrowDown' })).toBe(false);
    expect(link).toHaveFocus();
    expect(sidebarPreferences().conversationOrder['assistant-1']).toEqual(['thread-2', 'thread-1', 'thread-3']);
    fireEvent.keyDown(link, { altKey: true, key: 'ArrowUp' });
    expect(sidebarPreferences().conversationOrder['assistant-1']).toEqual(['thread-1', 'thread-2', 'thread-3']);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('uses visible keyboard neighbors while preserving hidden assistant and thread order', () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Match' } });
    const handle = within(sidebarRow('entity', 'assistant-1')).getByRole('button', { name: 'Move to group' });
    fireEvent.keyDown(handle, { altKey: true, key: 'ArrowDown' });
    expect(sidebarOrder('entity')).toEqual(['assistant-3', 'assistant-1']);
    expect(sidebarPreferences().entityOrder).toEqual(['assistant-2', 'assistant-3', 'assistant-1']);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Find' } });
    fireEvent.keyDown(screen.getByRole('link', { name: 'Find thread 3' }), { altKey: true, key: 'ArrowUp' });
    expect(sidebarOrder('conversation', document.getElementById('assistant-chat-threads-assistant-1')!))
      .toEqual(['thread-3', 'thread-1']);
    expect(sidebarPreferences().conversationOrder['assistant-1']).toEqual(['thread-3', 'thread-1', 'thread-2']);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(sidebarOrder('entity')).toEqual(['assistant-2', 'assistant-3', 'assistant-1']);
    expect(sidebarOrder('conversation', document.getElementById('assistant-chat-threads-assistant-1')!))
      .toEqual(['thread-3', 'thread-1', 'thread-2']);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('ignores wrong-owner thread row drops and external drag payloads', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    dropSidebarRow(sidebarRow('conversation', 'thread-1'), sidebarRow('conversation', 'thread-5'), 'before');
    const dataTransfer = { getData: () => 'thread-1', dropEffect: 'none' };
    fireEvent.dragOver(sidebarRow('entity', 'assistant-2'), { dataTransfer });
    fireEvent.drop(sidebarRow('entity', 'assistant-2'), { dataTransfer });
    expect(sidebarPreferences().conversationOrder).toBeUndefined();
    expect(sidebarOrder('conversation')).toEqual(['thread-1', 'thread-2', 'thread-3', 'thread-5', 'thread-6']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('rejects a stale thread owner when assistant props change during the drag', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const view = renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    fireEvent.dragStart(sidebarRow('conversation', 'thread-1'), { dataTransfer });
    view.rerender(<WorkspaceAssistantChat
      assistants={sidebarAssistants.map((assistant) => ({
        ...assistant,
        threads: assistant.id === 'assistant-1' ? assistant.threads.slice(1)
          : assistant.id === 'assistant-2' ? [...assistant.threads, sidebarAssistants[0].threads[0]] : assistant.threads,
      }))}
      deployments={[]}
      initialMessages={[]}
      providers={[]}
      reasoningAvailable
      selectedAssistantId="assistant-1"
      selectedThreadId={null}
      slug="acme"
      workspaceId="workspace-1"
    />);
    fireEvent.dragOver(sidebarRow('entity', 'assistant-3'), { dataTransfer });
    fireEvent.drop(sidebarRow('entity', 'assistant-3'), { dataTransfer });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sidebarPreferences().conversationOrder).toBeUndefined();
  });

  it.each(['entity', 'conversation'] as const)('clears %s insertion highlights on leave, drag end, and drop', (kind) => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const source = kind === 'entity'
      ? within(sidebarRow(kind, 'assistant-1')).getByRole('button', { name: 'Move to group' })
      : sidebarRow(kind, 'thread-1');
    const target = sidebarRow(kind, kind === 'entity' ? 'assistant-2' : 'thread-2');
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveClass('relative', 'before:bg-brand');
    fireEvent.dragLeave(target, { dataTransfer });
    expect(target).not.toHaveClass('before:bg-brand');
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(target).not.toHaveClass('before:bg-brand');
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(target).not.toHaveClass('before:bg-brand');
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

  it('shows Edit, Pin, and Delete in order in the assistant actions menu', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      assistant: { id: 'assistant-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', confirmMock);
    renderChat();

    const actionsButton = screen.getByRole('button', { name: 'Actions for Helper' });

    await user.click(actionsButton);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Edit', 'Pin', 'Delete']);

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Assistant settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(actionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    }));

    await user.click(actionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(confirmMock).toHaveBeenCalledWith('Delete this assistant and all of its chats?');
  });

  it('shows Unpin and persists false for a pinned assistant', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      assistant: { id: 'assistant-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderChat(undefined, false, undefined, null, [], [{
      id: 'assistant-1',
      name: 'Helper',
      pinned: true,
      systemPrompt: null,
      modelProviderId: 'provider-1',
      model: 'model-1',
      maxSteps: 8,
      providerName: 'Provider',
      deploymentIds: [],
      threads: [],
    }]);

    await user.click(screen.getByRole('button', { name: 'Actions for Helper' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Edit', 'Unpin', 'Delete']);
    await user.click(screen.getByRole('menuitem', { name: 'Unpin' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    }));
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
      },
      {
        id: 'assistant-2',
        name: 'Writer',
        pinned: false,
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
    expect(sourceDisclosure.nextElementSibling).toHaveAttribute('data-toolplane-ui', 'sidebar-action-rail');
    expect(targetDisclosure.nextElementSibling).toHaveAttribute('data-toolplane-ui', 'sidebar-action-rail');
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
    vi.stubGlobal('fetch', fetchMock);
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
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Custom parameter type' }), 'number');
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

    expect(screen.getByRole('button', { name: 'Model parameters' })).toHaveAttribute('aria-current', 'step');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('button', { name: 'MCP access' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('spinbutton', { name: 'Maximum tool-call rounds' })).toHaveValue(100);
    expect(screen.getByRole('button', { name: 'Create assistant' })).toBeInTheDocument();
  });

  it('requires a name and model before advancing assistant creation', async () => {
    renderChat(undefined, true, []);

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft helper');
    expect(next).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-current', 'step');
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
    expect(screen.getByRole('button', { name: 'Edit system prompt' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit system prompt' }));
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
