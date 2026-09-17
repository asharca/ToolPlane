import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/en.json';
import { AgentCollaborationPanel } from '@/components/dashboard/agents/AgentCollaborationPanel';
const fetcher = vi.fn();
const task = (state: string) => ({ id: 'task-1', callerAgentId: 'a', targetAgentId: 'b', targetName: 'Reviewer', message: 'Review the patch.',
  status: { state, question: state === 'input-required' ? 'Which branch?' : null, errorCode: null },
  result: null, artifacts: [], cancelRequested: false, deadlineAt: '2030-01-01T00:00:00Z' });
function mount() { return render(<NextIntlClientProvider locale="en" messages={messages}><AgentCollaborationPanel slug="team" agentId="a" /></NextIntlClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetcher); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('collaboration task panel', () => {
  it('shows explicit human authorization and never approves during polling', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ tasks: [task('auth-required')] })));
    // Response streams can only be read once; each poll/action gets a fresh object.
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ tasks: [task('auth-required')] })));
    mount(); await screen.findByText('Reviewer');
    const label = messages.console.agents.collaboration.approve;
    expect(fetcher.mock.calls.every((call) => !call[1]?.method)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(fetcher.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true));
    const body = fetcher.mock.calls.find((call) => call[1]?.method === 'POST')![1].body;
    expect(JSON.parse(body)).toEqual({ action: 'approve', taskId: 'task-1' });
    expect(screen.getByRole('link', { name: 'Reviewer' }).getAttribute('href')).toContain('/agents/b');
  });
  it('reuses the continuation ID after a failed HTTP response', async () => {
    let attempts = 0;
    fetcher.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? new Response('{}', { status: ++attempts === 1 ? 503 : 200 })
      : new Response(JSON.stringify({ tasks: [task('input-required')] })));
    mount(); await screen.findByText('Which branch?');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'main' } });
    const button = screen.getByRole('button', { name: messages.console.agents.collaboration.continue });
    fireEvent.click(button); await screen.findByRole('alert');
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(attempts).toBe(2));
    const posts = fetcher.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => JSON.parse(call[1].body));
    expect(posts[0].messageId).toBe(posts[1].messageId); expect(posts[0].message).toBe('main');
  });
  it('renders artifacts as text, not injected HTML', async () => {
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ tasks: [{ ...task('completed'),
      artifacts: [{ artifactId: 'report', name: 'Report', text: '<img src=x onerror=alert(1)>' }] }] })));
    const { container } = mount(); await screen.findByText('Report');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });
});
