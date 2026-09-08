// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { workspace: { findFirst: mocks.findFirst } } }));
import { revokeWorkspaceStreams, workspaceAccessStream } from '@/lib/workspace/access-stream';

beforeEach(() => { mocks.findFirst.mockReset().mockResolvedValue({ id: 'workspace' }); });
afterEach(() => { revokeWorkspaceStreams('workspace'); vi.useRealTimers(); });

describe('workspace live access', () => {
  it('closes a revoked member’s stream without interrupting other members', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const reader = workspaceAccessStream(body, 'workspace', 'member', new AbortController().signal).getReader();
    source.enqueue(new Uint8Array([1]));
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    revokeWorkspaceStreams('workspace', 'someone-else');
    source.enqueue(new Uint8Array([2]));
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    revokeWorkspaceStreams('workspace', 'member');
    expect((await reader.read()).done).toBe(true);
  });

  it('periodically detects revocation in another worker and cleans up the timer', async () => {
    vi.useFakeTimers();
    const reader = workspaceAccessStream(new ReadableStream(), 'workspace', 'member', new AbortController().signal).getReader();
    await vi.advanceTimersByTimeAsync(1);
    mocks.findFirst.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed on authorization errors and on already aborted requests', async () => {
    mocks.findFirst.mockRejectedValue(new Error('database unavailable'));
    const reader = workspaceAccessStream(new ReadableStream(), 'workspace', 'member', new AbortController().signal).getReader();
    expect((await reader.read()).done).toBe(true);
    vi.useFakeTimers();
    const stopped = workspaceAccessStream(new ReadableStream(), 'workspace', 'member', AbortSignal.abort()).getReader();
    expect((await stopped.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
