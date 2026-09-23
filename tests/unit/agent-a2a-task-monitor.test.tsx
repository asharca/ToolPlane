import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentA2ATaskMonitor } from '@/components/dashboard/agents/AgentA2ATaskMonitor';
import type { ConsoleTaskTree } from '@/lib/a2a/console-tasks';

const fetcher = vi.fn();
const notify = vi.fn();
let hidden = false;
const tree = (state = 'TASK_STATE_WORKING', selected = 'root'): ConsoleTaskTree => ({
  rootTaskId: 'root', restricted: false,
  nodes: [
    { id: 'root', parentTaskId: null, name: 'Coordinator', agentId: 'a', state, phase: state === 'TASK_STATE_WORKING' ? 'waiting' : 'done', cancelRequested: false, resumeCount: 0, updatedAt: '2026-09-23T00:00:00Z' },
    { id: 'child', parentTaskId: 'root', name: 'Reviewer', agentId: 'b', state: 'TASK_STATE_COMPLETED', phase: 'done', cancelRequested: false, resumeCount: 0, updatedAt: '2026-09-23T00:00:00Z' },
  ], selectedTask: { id: selected, status: { state }, artifacts: [{ artifactId: 'result', parts: [{ text: '<script>untrusted output</script>' }] }] },
});
const flush = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockImplementation(async () => new Response(JSON.stringify(tree())));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const show = () => render(<AgentA2ATaskMonitor base="/api/console" rootTaskId="root" onRootState={notify} />);

describe('read-only A2A task monitoring', () => {
  it('shows parent-child hierarchy, renders output as text and never sends work', async () => {
    show(); await flush();
    expect(screen.getByText('Coordinator')).toBeInTheDocument(); expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('<script>untrusted output</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull();
    expect(notify).toHaveBeenCalledWith('TASK_STATE_WORKING');
    await flush(2500); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) { expect(init.method).toBeUndefined(); expect(init.cache).toBe('no-store'); expect(init.credentials).toBe('same-origin'); }
  });
  it('stops automatic reads when every node is terminal', async () => {
    fetcher.mockImplementation(async () => new Response(JSON.stringify(tree('TASK_STATE_COMPLETED'))));
    show(); await flush(); await flush(30_000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('pauses monitoring and does not restart automatically when visibility changes', async () => {
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Pause updates' })); await flush();
    const count = fetcher.mock.calls.length;
    hidden = true; fireEvent(document, new Event('visibilitychange'));
    hidden = false; fireEvent(document, new Event('visibilitychange')); await flush(30_000);
    expect(fetcher).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole('button', { name: 'Resume updates' })); await flush(); expect(fetcher.mock.calls.length).toBeGreaterThan(count);
  });
  it('selects child output through the owned root, not a standalone child URL', async () => {
    fetcher.mockImplementation(async (url) => new Response(JSON.stringify(tree('TASK_STATE_WORKING', new URL(url, 'https://test').searchParams.get('selectedTaskId')!))));
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: /Reviewer/ })); await flush();
    expect(fetcher.mock.lastCall![0]).toContain('rootTaskId=root&selectedTaskId=child');
    expect(screen.getByRole('region', { name: 'Selected task result' })).toHaveTextContent('child');
  });
  it('has a bounded retry budget and preserves the last successful snapshot on errors', async () => {
    show(); await flush(); fetcher.mockRejectedValue(new Error('offline'));
    await flush(2500); await flush(5000); await flush(10_000); const count = fetcher.mock.calls.length;
    await flush(60_000); expect(fetcher).toHaveBeenCalledTimes(count);
    expect(screen.getByText('Coordinator')).toBeInTheDocument(); expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  it('aborts a hanging observation on unmount and does not update a stale view', async () => {
    let resolve: (value: Response) => void;
    fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const rendered = show(); await flush(); const signal = fetcher.mock.lastCall![1].signal as AbortSignal;
    rendered.unmount(); expect(signal.aborted).toBe(true);
    resolve!(new Response(JSON.stringify(tree()))); await flush(); expect(notify).not.toHaveBeenCalled();
  });
});


describe('workbench history and revoked access', () => {
  it('loads bounded history explicitly and renders messages without interpreting markup', async () => {
    const value = tree('TASK_STATE_COMPLETED');
    value.selectedTask.history = [{ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: '<img src=x onerror=alert(1)>' }] }];
    fetcher.mockImplementation(async () => Response.json(value));
    render(<AgentA2ATaskMonitor base="/api/console" rootTaskId="root" onRootState={notify} showHistory />);
    await flush();
    expect(fetcher.mock.lastCall![0]).toContain('historyLength=32');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('list', { name: 'Task message history' })).toBeInTheDocument();
  });
  it.each([401, 403, 404])('drops the last snapshot and stops automatic reads after access status %s', async (status) => {
    const missing = vi.fn();
    render(<AgentA2ATaskMonitor base="/api/console" rootTaskId="root" onRootState={notify} onUnavailable={missing} />);
    await flush(); expect(screen.getByText('Coordinator')).toBeInTheDocument();
    fetcher.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status }));
    await flush(2500); const count = fetcher.mock.calls.length;
    expect(screen.queryByText('Coordinator')).not.toBeInTheDocument(); expect(missing).toHaveBeenCalledTimes(1);
    await flush(30_000); expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
