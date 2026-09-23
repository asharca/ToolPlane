import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentA2APanel } from '@/components/dashboard/agents/AgentA2APanel';
import type { A2AConsoleView } from '@/lib/a2a/connection-info';
vi.mock('@/components/dashboard/agents/AgentA2ARemotes', () => ({ AgentA2ARemotes: () => <div>Remote connections</div> }));
vi.mock('@/components/dashboard/agents/AgentA2ATaskMonitor', () => ({ AgentA2ATaskMonitor: () => <div>Task tree</div> }));
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
const show = async () => { const rendered = render(<AgentA2APanel slug="team" agentId="agent" runtimeKind="pi" />); await screen.findByText('Connection details & examples'); return rendered; };
const posts = () => fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');

describe('Agent A2A console panel', () => {
  it('only reads settings on mount and keeps credentials out of generated examples', async () => {
    await show(); expect(posts()).toHaveLength(0);
    expect(screen.getAllByText('https://tp.example/local', { selector: 'code' })).toHaveLength(2);
    expect(screen.getAllByText(/TOOLPLANE_ACCOUNT_TOKEN/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /External A2A guide/ })).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('disables admin controls for members while leaving local task submission available', async () => {
    current.canManage = false; await show();
    expect(screen.getByRole('button', { name: 'Disable internal A2A' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Create client & key' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task message / additional input'), { target: { value: 'Review' } });
    expect(screen.getByRole('button', { name: 'Submit new task' })).toBeEnabled();
  });
  it('requires explicit confirmation for access changes', async () => {
    await show(); vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Disable internal A2A' })); expect(posts()).toHaveLength(0);
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disable internal A2A' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: 'set-local', enabled: false });
  });
  it('preserves the one-time credential when a subsequent list refresh fails; no automatic retry', async () => {
    await show();
    fetchMock.mockImplementation((_url, init) => init?.method === 'POST' ? json({ ok: true, token: 'tp_agent_ONE_TIME_FIXTURE' }) : json({}, 500));
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'integration' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create client & key' }));
    expect(await screen.findByText('tp_agent_ONE_TIME_FIXTURE')).toBeInTheDocument();
    expect(await screen.findByText(/change succeeded, but refreshing/)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create client & key' })).toBeDisabled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    for (const pre of document.querySelectorAll('pre')) expect(pre.textContent).not.toContain('tp_agent_ONE_TIME_FIXTURE');
    fireEvent.click(screen.getByRole('button', { name: 'Saved — hide key' }));
    expect(screen.queryByText('tp_agent_ONE_TIME_FIXTURE')).not.toBeInTheDocument();
  });
  it('submits native SendMessage explicitly, without embedding an account token', async () => {
    await show(); fetchMock.mockImplementation((_url, init) => init?.method === 'POST' ? json({ result: { task: { id: 'task-1', contextId: 'context-1', status: { state: 'TASK_STATE_SUBMITTED' } } } }) : json(current));
    fireEvent.change(screen.getByLabelText('Task message / additional input'), { target: { value: 'Review this change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit new task' }));
    await screen.findByText('TASK_STATE_SUBMITTED');
    const [url, init] = posts()[0]; expect(url).toMatch(/a2a\/console\/rpc$/);
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ method: 'SendMessage', params: { message: { role: 'ROLE_USER', parts: [{ text: 'Review this change' }] }, configuration: { returnImmediately: true } } });
    expect(screen.getByText(/Task accepted, not completed/)).toBeInTheDocument();
  });
  it('shows protocol errors instead of claiming task completion', async () => {
    await show(); fetchMock.mockImplementation((_url, init) => init?.method === 'POST' ? json({ error: { code: -32001 } }) : json(current));
    fireEvent.change(screen.getByLabelText('Task message / additional input'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit new task' }));
    await screen.findByRole('alert'); expect(screen.queryByText(/Task accepted, not completed/)).not.toBeInTheDocument();
  });
});
