// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  DEPLOYMENT_CONFIG_MOUNT_PATH,
  deploymentConfigVolumeHelperArgs,
} from '@/lib/process/deployment-config-volume';

// Live Docker regression; skipped unless explicitly requested with:
// SANDBOX_DOCKER_SMOKE=1 pnpm vitest run tests/integration/deployment-config-volume.live.test.ts
const RUN = process.env.SANDBOX_DOCKER_SMOKE === '1';
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const volume = `toolplane_test_mcp_config_${suffix}`;
let stagingDirectory = '';

async function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `docker exited with code ${code}`));
    });
  });
}

async function dockerWithInput(args: string[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin?.once('error', reject);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker exited with code ${code}`));
    });
    child.stdin?.end(input);
  });
}

(RUN ? describe : describe.skip)('deployment configuration volume materialization (live)', () => {
  beforeAll(async () => {
    stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'toolplane-mcp-config-live-'));
    await mkdir(path.join(stagingDirectory, 'nested'), { recursive: true });
    await writeFile(path.join(stagingDirectory, 'nested', 'ssh-config.json'), '{"host":"switch"}\n', {
      mode: 0o600,
    });
    await writeFile(path.join(stagingDirectory, '.hidden'), 'hidden\n', { mode: 0o600 });
    await docker(['volume', 'create', volume]);
  }, 120_000);

  afterAll(async () => {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
    await docker(['volume', 'rm', '-f', volume]).catch(() => undefined);
  }, 30_000);

  it('streams staged files into a volume while keeping both helper and final mount read-only', async () => {
    const archive = execFileSync('tar', ['-C', stagingDirectory, '-cf', '-', '.'], {
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
    });
    await dockerWithInput(deploymentConfigVolumeHelperArgs(volume), archive);

    const output = await docker([
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--mount',
      `type=volume,src=${volume},dst=${DEPLOYMENT_CONFIG_MOUNT_PATH},readonly`,
      'alpine:3.20',
      'sh',
      '-c',
      [
        'set -eu',
        `cat ${DEPLOYMENT_CONFIG_MOUNT_PATH}/nested/ssh-config.json`,
        'printf "|"',
        `cat ${DEPLOYMENT_CONFIG_MOUNT_PATH}/.hidden`,
        'printf "|"',
        `stat -c '%a' ${DEPLOYMENT_CONFIG_MOUNT_PATH}/nested/ssh-config.json`,
        'printf "|"',
        `stat -c '%a' ${DEPLOYMENT_CONFIG_MOUNT_PATH}/nested`,
        `! touch ${DEPLOYMENT_CONFIG_MOUNT_PATH}/blocked`,
      ].join('; '),
    ]);

    expect(output).toBe('{"host":"switch"}\n|hidden\n|444\n|755\n');
  }, 120_000);
});
