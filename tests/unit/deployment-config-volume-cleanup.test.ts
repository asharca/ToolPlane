// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/lib/db', () => ({ db: {} }));

import {
  removeStaleDeploymentConfigMaterializerHelpers,
} from '@/lib/process/deployment-config-volume';

function dockerChild({ stdout = '', stderr = '', code = 0 }: {
  stdout?: string;
  stderr?: string;
  code?: number;
} = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', code, null);
  });
  return child;
}

describe('deployment configuration materializer crash recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes only stopped helpers older than the cutoff and never uses force', async () => {
    const created = '2026-08-07T00:00:00.000Z';
    const recent = '2026-08-07T01:00:00.000Z';
    const ids = {
      created: 'aaaaaaaaaaaa',
      exited: 'bbbbbbbbbbbb',
      dead: 'cccccccccccc',
      running: 'dddddddddddd',
      recent: 'eeeeeeeeeeee',
    };
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'ps') {
        return dockerChild({ stdout: `${Object.values(ids).join('\n')}\n` });
      }
      if (args[0] === 'inspect') {
        const id = args.at(-1);
        const status = id === ids.created ? 'created'
          : id === ids.exited ? 'exited'
            : id === ids.dead ? 'dead'
              : id === ids.running ? 'running'
                : 'exited';
        return dockerChild({ stdout: `${id === ids.recent ? recent : created}\t${status}\n` });
      }
      if (args[0] === 'rm') return dockerChild();
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    });

    await expect(removeStaleDeploymentConfigMaterializerHelpers(new Date('2026-08-07T00:30:00.000Z')))
      .resolves.toBe(3);

    const calls = mocks.spawn.mock.calls.map(([, args]) => args as string[]);
    expect(calls[0]).toEqual([
      'ps',
      '-aq',
      '--filter',
      'label=toolplane.mcp-config-materializer=true',
    ]);
    expect(calls.filter((args) => args[0] === 'rm')).toEqual([
      ['rm', ids.created],
      ['rm', ids.exited],
      ['rm', ids.dead],
    ]);
    expect(calls.flat()).not.toContain('-f');
  });

  it('leaves a helper alone when it becomes running between inspect and remove', async () => {
    const id = 'aaaaaaaaaaaa';
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'ps') return dockerChild({ stdout: `${id}\n` });
      if (args[0] === 'inspect') return dockerChild({ stdout: '2026-08-07T00:00:00.000Z\texited\n' });
      if (args[0] === 'rm') {
        return dockerChild({
          code: 1,
          stderr: 'Error response from daemon: cannot remove a running container',
        });
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    });

    await expect(removeStaleDeploymentConfigMaterializerHelpers(new Date('2026-08-07T00:30:00.000Z')))
      .resolves.toBe(0);
    expect(mocks.spawn.mock.calls.map(([, args]) => args)).toEqual([
      ['ps', '-aq', '--filter', 'label=toolplane.mcp-config-materializer=true'],
      ['inspect', '--format', '{{.Created}}\t{{.State.Status}}', id],
      ['rm', id],
    ]);
  });
});
