// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { removeDockerSandboxRuntimeStrict } from '@/lib/sandboxes/runtime';

describe('strict Docker sandbox cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
  });

  it('removes a retained Hermes sync container before the main container and volume', async () => {
    await removeDockerSandboxRuntimeStrict('sandbox-1', 'volume-1');

    expect(mocks.spawn.mock.calls.map(([, args]) => args)).toEqual([
      ['rm', '-f', 'toolplane-sandbox-sandbox-1-sync'],
      ['rm', '-f', 'toolplane-sandbox-sandbox-1'],
      ['volume', 'rm', '-f', 'volume-1'],
    ]);
  });
});
