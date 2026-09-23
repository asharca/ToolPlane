import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentA2ARemotes } from '@/components/dashboard/agents/AgentA2ARemotes';
const fetcher = vi.fn(); let hidden = false;
const view = (canManage = true) => ({ canManage, agents: [{ id: 'remote-1', name: '<script>untrusted</script>', rpcUrl: 'https://agent.example/rpc', cardUrl: 'https://agent.example/card', revision: 2, allowed: false, enabled: false }] });
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hidden = false;
  vi.stubGlobal('fetch', fetcher); vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  fetcher.mockImplementation(async (_url, init) => Response.json(init?.method === 'POST' ? { ok: true, id: 'remote-1' } : view()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const show = () => render(<AgentA2ARemotes base="/api/console" />);
describe('remote Agent registration controls', () => {
  it('never registers/calls automatically and renders peer names as text', async () => {
    show(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].method).toBeUndefined();
    expect(screen.getByText('<script>untrusted</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull();
  });
  it('keeps registration, enabling and authorizing the current Agent separate', async () => {
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Enable remote service' })); await flush();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'configure', id: 'remote-1', revision: 2, enabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize current Agent' })); await flush();
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ action: 'configure', id: 'remote-1', revision: 2, allowCurrentAgent: true });
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });
  it('does not expose management to a non-admin', async () => {
    fetcher.mockResolvedValue(Response.json(view(false))); show(); await flush();
    expect(screen.queryByRole('button', { name: 'Enable remote service' })).toBeNull();
    expect(screen.queryByLabelText('Remote Bearer key (optional)')).toBeNull();
  });
  it('clears entered secrets on visibility loss and timeout, without persistent storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); show(); await flush();
    const input = screen.getByLabelText('Remote Bearer key (optional)'); fireEvent.change(input, { target: { value: 'sensitive' } });
    expect(input).toHaveValue('sensitive'); hidden = true; fireEvent(document, new Event('visibilitychange')); await flush(); expect(input).toHaveValue('');
    hidden = false; fireEvent.change(input, { target: { value: 'another' } }); await flush(180_000); expect(input).toHaveValue(''); expect(storage).not.toHaveBeenCalled();
  });
  it('requires confirmation and never automatically retries a failed registration', async () => {
    show(); await flush(); vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Enable remote service' })); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true); fetcher.mockRejectedValue(new Error('Network unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable remote service' })); await flush(60_000); expect(fetcher).toHaveBeenCalledTimes(2); expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
