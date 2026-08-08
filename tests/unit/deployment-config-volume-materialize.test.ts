// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decryptSecretText: vi.fn(),
  findMany: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/lib/db', () => ({
  db: { deploymentConfigFile: { findMany: mocks.findMany } },
}));
vi.mock('@/lib/security/secrets', () => ({ decryptSecretText: mocks.decryptSecretText }));

import { materializeDeploymentConfigVolume } from '@/lib/process/deployment-config-volume';

function child({
  archive,
  input,
  command = 'docker',
}: {
  archive?: Buffer;
  input?: (value: Buffer) => void;
  command?: 'docker' | 'tar';
} = {}) {
  const stdin = input
    ? Object.assign(new EventEmitter(), { end: vi.fn(input) })
    : null;
  const result = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stderr: new EventEmitter(),
    stdin,
    stdout: new EventEmitter(),
  });
  queueMicrotask(() => {
    if (archive) result.stdout.emit('data', archive);
    result.emit(command === 'tar' ? 'close' : 'exit', 0, null);
  });
  return result;
}

describe('deployment configuration volume materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams the staged archive to a one-shot read-only Docker helper', async () => {
    const content = '{"host":"switch"}\n';
    const archive = Buffer.from('tar archive');
    const inputs: Buffer[] = [];
    mocks.findMany.mockResolvedValue([{
      id: 'file-1',
      path: 'ssh-config.json',
      encryptedContent: { ciphertext: 'ignored' },
      size: Buffer.byteLength(content),
    }]);
    mocks.decryptSecretText.mockReturnValue(content);
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === 'tar') return child({ archive, command: 'tar' });
      if (command === 'docker' && args[0] === 'run') {
        return child({ input: (value) => inputs.push(value) });
      }
      if (command === 'docker' && args[0] === 'volume') return child();
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const result = await materializeDeploymentConfigVolume('deployment-1');
    expect(result.hasFiles).toBe(true);
    expect(result.redactionValues).toContain(content);

    const calls = mocks.spawn.mock.calls.map(([command, args]) => ({ command, args: args as string[] }));
    expect(calls[0]).toMatchObject({
      command: 'tar',
      args: expect.arrayContaining(['-cf', '-', '.']),
    });
    expect(calls[1]).toEqual({
      command: 'docker',
      args: ['volume', 'create', 'toolplane_mcp_config_deployment-1'],
    });
    expect(calls[2]).toMatchObject({
      command: 'docker',
      args: expect.arrayContaining(['run', '--rm', '-i', '--read-only']),
    });
    expect(calls).toHaveLength(3);
    expect(calls.filter(({ command }) => command === 'docker').map(({ args }) => args[0])).toEqual([
      'volume',
      'run',
    ]);
    expect(inputs).toEqual([archive]);
  });
});
