import { describe, expect, it, vi } from 'vitest';
import {
  beginWorkspaceOperation,
  closeWorkspaceOperations,
} from '@/lib/workspace/operation-gate';

describe('workspace operation gate', () => {
  it('blocks new operations and drains work that began before teardown', async () => {
    const workspaceId = `workspace-drain-${Date.now()}`;
    const release = beginWorkspaceOperation(workspaceId);
    expect(release).toBeTypeOf('function');

    const drained = vi.fn();
    const closing = closeWorkspaceOperations(workspaceId).then(drained);
    await Promise.resolve();

    expect(drained).not.toHaveBeenCalled();
    expect(beginWorkspaceOperation(workspaceId)).toBeNull();

    release?.();
    await closing;
    expect(drained).toHaveBeenCalledOnce();
    expect(beginWorkspaceOperation(workspaceId)).toBeNull();
  });

  it('does not block unrelated workspaces', async () => {
    const closedWorkspaceId = `workspace-closed-${Date.now()}`;
    const openWorkspaceId = `workspace-open-${Date.now()}`;
    await closeWorkspaceOperations(closedWorkspaceId);

    const release = beginWorkspaceOperation(openWorkspaceId);
    expect(release).toBeTypeOf('function');
    release?.();
  });
});
