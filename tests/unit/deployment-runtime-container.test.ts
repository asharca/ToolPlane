// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { removeDeploymentContainer } from '@/lib/process/deployment-runtime-container';

function dockerChild({ code = 0, stderr = '' }: { code?: number; stderr?: string } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, null);
  });
  return child;
}

describe('managed deployment container cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockImplementation(() => dockerChild());
  });

  it('force-removes only the deterministic container name derived from a deployment id', async () => {
    await removeDeploymentContainer('dep/../with spaces');

    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'toolplane-mcp-dep_.._with_spaces'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('treats a concurrently removed container as successful cleanup', async () => {
    mocks.spawn.mockImplementation(() => dockerChild({
      code: 1,
      stderr: 'Error response from daemon: No such container: toolplane-mcp-dep1',
    }));

    await expect(removeDeploymentContainer('dep1')).resolves.toBeUndefined();
  });

  it('preserves Docker cleanup failures other than a missing container', async () => {
    mocks.spawn.mockImplementation(() => dockerChild({
      code: 1,
      stderr: 'Error response from daemon: 403 Forbidden',
    }));

    await expect(removeDeploymentContainer('dep1')).rejects.toThrow('403 Forbidden');
  });
});
