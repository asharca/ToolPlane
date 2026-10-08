import { fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentA2APanel } from '@/components/dashboard/agents/AgentA2APanel';
import type { A2AConsoleView } from '@/lib/a2a/connection-info';
vi.mock('@/components/dashboard/agents/AgentA2ARemotes', () => ({ AgentA2ARemotes: () => <h3>Connect an external Agent</h3> }));
vi.mock('@/components/dashboard/CopyButton', () => ({ CopyButton: ({ text, label }: { text: string; label: string }) => <button type="button" data-copy={text}>{label}</button> }));
const view: A2AConsoleView = {
  canManage: true, local: { enabled: true, supported: true, ready: true },
  endpoint: { id: 'agep_test', enabled: true, ready: true, revision: 1, clients: [] },
  connections: { localRpc: 'https://tp.example/local', localCard: 'https://tp.example/local', publicRpc: 'https://tp.example/a2a', publicCard: 'https://tp.example/a2a/card', publicMcp: 'https://tp.example/a2a/mcp' },
};
let current: A2AConsoleView;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
beforeEach(() => {
  vi.clearAllMocks(); current = structuredClone(view); vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fetchMock.mockImplementation((_url, init) => init?.method === 'POST' ? json({ ok: true }) : json(current));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const show = async (runtimeKind = 'pi') => { const rendered = render(<AgentA2APanel slug="team" agentId="agent" runtimeKind={runtimeKind} />); await screen.findByRole('heading', { name: 'Let external services call this Agent' }); return rendered; };
const posts = () => fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');

describe('Agent A2A console panel', () => {
  it('opens ingress task history without requiring external A2A or submitting work', async () => {
    current.local.enabled = false;
    fetchMock.mockImplementation((url) => String(url).includes('/tasks?') ? json({
      rootTaskId: 'entry-task', restricted: false,
      nodes: [{ id: 'entry-task', parentTaskId: null, name: 'Pi', state: 'TASK_STATE_COMPLETED', phase: 'completed' }],
      selectedTask: { id: 'entry-task', history: [{ messageId: 'result', role: 'ROLE_AGENT', parts: [{ text: 'Pi task result' }] }] },
    }) : json(current));
    render(<AgentA2APanel slug="team" agentId="agent" runtimeKind="pi" initialTaskId="entry-task" />);
    expect(await screen.findByText('Pi task result')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execution records / pending approvals' })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it('opens pending approvals from a task deep link without deciding automatically', async () => {
    fetchMock.mockImplementation((url) => String(url).includes('/approvals?') ? json({
      approvals: [{ id: 'approval', taskId: 'entry-task', toolName: 'write', input: { path: 'report.txt' }, inputHash: 'hash', status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    }) : String(url).includes('/tasks?') ? json({
      rootTaskId: 'entry-task', restricted: false,
      nodes: [{ id: 'entry-task', parentTaskId: null, name: 'Pi', state: 'TASK_STATE_WORKING', phase: 'executing', pendingApprovals: 1 }],
      selectedTask: { id: 'entry-task' },
    }) : json(current));
    render(<AgentA2APanel slug="team" agentId="agent" runtimeKind="pi" initialTaskId="entry-task" />);
    expect(await screen.findByRole('button', { name: 'Deny' })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Native tool approvals' })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it('only reads settings on mount and links to public API documentation', async () => {
    await show(); expect(posts()).toHaveLength(0);
    expect(screen.getAllByText('https://tp.example/local', { selector: 'code' })).toHaveLength(2);
    expect(document.querySelector('pre')).not.toBeInTheDocument();
  });
  it('keeps internal selection and channel authorization without an execution playground', async () => {
    current.endpoint = null;
    current.channels = [{ id: 'channel', name: 'Operations', platform: 'telegram', enabled: true, mine: true }];
    await show();
    expect(screen.getByRole('heading', { name: 'Internal collaboration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect an external Agent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Let external services call this Agent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure allowed delegates' })).toHaveAttribute('href', '?settings=subAgents');
    expect(screen.getByText(/only explicitly authorized targets/)).toBeInTheDocument();
    expect(screen.getByText(/Never give your account token to third parties/)).toBeInTheDocument();
    expect(screen.queryByText(/Publish an active isolated Hermes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Published service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Task message / additional input' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execution records / pending approvals' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'External A2A & channel access' })).getByRole('heading', { name: 'Channel execution operator' })).toBeInTheDocument();
  });
  it('allows configuring internal delegates with external access disabled and no enablement prerequisite', async () => {
    current.local.enabled = false;
    await show();
    const internal = screen.getByRole('region', { name: 'Internal collaboration' });
    expect(within(internal).getByText(/Select sub-agents to allow internal delegation/)).toHaveTextContent('Neither this Agent nor the selected targets need an A2A switch enabled.');
    expect(within(internal).getByRole('link', { name: 'Configure allowed delegates' })).toHaveAttribute('href', '?settings=subAgents');
    expect(within(internal).queryByRole('button')).not.toBeInTheDocument();
    expect(within(internal).queryByText('Disabled')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'External A2A & channel access' })).getByRole('button', { name: 'Enable external & channel access' })).toBeEnabled();
    expect(posts()).toHaveLength(0);
  });
  it('retains Hermes publication and dedicated service credentials', async () => {
    await show('hermes');
    expect(screen.getByRole('heading', { name: 'Published service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable external A2A' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create client & key' })).toBeInTheDocument();
    expect(screen.getByText(/Use a dedicated A2A service key/)).toBeInTheDocument();
    expect(screen.getByText('https://tp.example/a2a', { selector: 'code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'External A2A & channel access' }));
    expect(screen.getByText(/Never give your account token to third parties/)).toBeInTheDocument();
  });
  it('disables admin controls for members while keeping integration documentation readable', async () => {
    current.canManage = false; current.connections = null; await show();
    expect(screen.getByRole('button', { name: 'Disable external & channel access' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Create client & key' })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it.each([false, true])('requires confirmation to change external access when enabled=%s', async (enabled) => {
    current.local.enabled = enabled;
    await show(); vi.mocked(window.confirm).mockReturnValue(false);
    const button = screen.getByRole('button', { name: enabled ? 'Disable external & channel access' : 'Enable external & channel access' });
    fireEvent.click(button); expect(posts()).toHaveLength(0);
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: 'set-local', enabled: !enabled });
  });
  it('preserves the one-time credential when a subsequent list refresh fails; no automatic retry', async () => {
    await show('hermes');
    fetchMock.mockImplementation((_url, init) => init?.method === 'POST' ? json({ ok: true, token: 'tp_agent_ONE_TIME_FIXTURE' }) : json({}, 500));
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'integration' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create client & key' }));
    expect(await screen.findByText('tp_agent_ONE_TIME_FIXTURE')).toBeInTheDocument();
    expect(await screen.findByText(/change succeeded, but refreshing/)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create client & key' })).toBeDisabled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Saved — hide key' }));
    expect(screen.queryByText('tp_agent_ONE_TIME_FIXTURE')).not.toBeInTheDocument();
  });
  it('switches connection URLs without submitting tasks or exposing credentials in docs', async () => {
    await show('hermes');
    expect(screen.getByText('https://tp.example/a2a', { selector: 'code' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'External A2A & channel access' }));
    expect(screen.queryByText('https://tp.example/a2a', { selector: 'code' })).not.toBeInTheDocument();
    expect(screen.getAllByText('https://tp.example/local', { selector: 'code' })).toHaveLength(2);
    expect(document.querySelector('pre')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
