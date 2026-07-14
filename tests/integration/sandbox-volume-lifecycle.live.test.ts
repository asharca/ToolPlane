// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  copyDockerVolume,
  removeDockerVolumeStrict,
} from '@/lib/sandboxes/runtime';

const RUN = process.env.SANDBOX_DOCKER_SMOKE === '1';
const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const sourceVolume = `toolplane_test_source_${suffix}`;
const snapshotVolume = `toolplane_test_snapshot_${suffix}`;
const cloneVolume = `toolplane_test_clone_${suffix}`;
const volumes = [sourceVolume, snapshotVolume, cloneVolume];

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync('docker', args, { timeout: 120_000 });
  return result.stdout.trim();
}

async function alpine(volume: string, script: string): Promise<string> {
  return docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--mount',
    `type=volume,src=${volume},dst=/data`,
    'alpine:3.20',
    'sh',
    '-c',
    script,
  ]);
}

(RUN ? describe : describe.skip)('Docker sandbox volume lifecycle (live)', () => {
  beforeAll(async () => {
    await docker(['volume', 'create', sourceVolume]);
    await alpine(sourceVolume, [
      'set -eu',
      "printf 'original' > '/data/file with spaces.txt'",
      "printf 'hidden' > /data/.hidden",
      "printf 'AAEC/w==' | base64 -d > /data/binary.bin",
      "printf 'locked' > /data/locked",
      'chmod 000 /data/locked',
      "ln -s 'file with spaces.txt' /data/link",
    ].join('; '));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(volumes.map((volume) => (
      removeDockerVolumeStrict(volume).catch(() => undefined)
    )));
  });

  it('creates, restores, and independently clones workspace data', async () => {
    await copyDockerVolume(sourceVolume, snapshotVolume);
    await alpine(sourceVolume, [
      "printf 'changed' > '/data/file with spaces.txt'",
      'rm -f /data/.hidden /data/link',
      "printf 'stale' > /data/stale",
    ].join('; '));

    await copyDockerVolume(snapshotVolume, sourceVolume, { replace: true });
    expect(await alpine(sourceVolume, [
      "cat '/data/file with spaces.txt'",
      "printf '|'",
      'cat /data/.hidden',
      "printf '|'",
      "base64 /data/binary.bin | tr -d '\\n'",
      "printf '|'",
      "stat -c '%a' /data/locked | tr -d '\\n'",
      "printf '|'",
      "readlink /data/link | tr -d '\\n'",
      'test ! -e /data/stale',
    ].join('; '))).toBe('original|hidden|AAEC/w==|0|file with spaces.txt');

    await copyDockerVolume(sourceVolume, cloneVolume);
    await alpine(cloneVolume, "printf 'clone' > '/data/file with spaces.txt'");
    expect(await alpine(sourceVolume, "cat '/data/file with spaces.txt'")).toBe('original');
    expect(await alpine(cloneVolume, "cat '/data/file with spaces.txt'")).toBe('clone');
  }, 120_000);
});
