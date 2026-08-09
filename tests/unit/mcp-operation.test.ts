import { describe, expect, it, vi } from 'vitest';
import { closeWorkspaceOperations } from '@/lib/workspace/operation-gate';
import { runMcpDeploymentOperation } from '@/lib/workspace/mcp-operation';

describe('MCP deployment operation queue', () => {
  it('serializes operations for one deployment', async () => {
    const workspaceId = `mcp-operation-workspace-${Date.now()}`;
    const deploymentId = `mcp-operation-deployment-${Date.now()}`;
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = runMcpDeploymentOperation(workspaceId, deploymentId, async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const second = runMcpDeploymentOperation(workspaceId, deploymentId, async () => {
      events.push('second');
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases the queue after an operation throws', async () => {
    const workspaceId = `mcp-operation-error-workspace-${Date.now()}`;
    const deploymentId = `mcp-operation-error-deployment-${Date.now()}`;
    await expect(runMcpDeploymentOperation(workspaceId, deploymentId, async () => {
      throw new Error('failed operation');
    })).rejects.toThrow('failed operation');

    const next = await runMcpDeploymentOperation(workspaceId, deploymentId, async () => 'recovered');
    expect(next).toEqual({ accepted: true, value: 'recovered' });
  });

  it('rejects new work after workspace teardown begins', async () => {
    const workspaceId = `mcp-operation-closed-workspace-${Date.now()}`;
    await closeWorkspaceOperations(workspaceId);

    const operation = vi.fn();
    await expect(runMcpDeploymentOperation(
      workspaceId,
      `mcp-operation-closed-deployment-${Date.now()}`,
      operation,
    )).resolves.toEqual({ accepted: false });
    expect(operation).not.toHaveBeenCalled();
  });
});
