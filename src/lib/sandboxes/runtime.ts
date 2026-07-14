import 'server-only';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export { DEFAULT_SANDBOX_IMAGE } from './images';

const VOLUME_COPY_TIMEOUT_MS = 15 * 60_000;
const MAX_DOCKER_ERROR_BYTES = 64 * 1024;
const VOLUME_HELPER_IMAGE = process.env.SANDBOX_VOLUME_HELPER_IMAGE?.trim() || 'alpine:3.20';

export class DockerVolumeCopyCleanupError extends AggregateError {
  readonly helperName?: string;

  constructor(errors: unknown[], message: string, helperName?: string) {
    super(errors, message);
    this.name = 'DockerVolumeCopyCleanupError';
    this.helperName = helperName;
  }
}

export function sandboxVolumeName(sandboxId: string): string {
  return `toolplane_sandbox_${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function sandboxContainerName(sandboxId: string): string {
  return `toolplane-sandbox-${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function sandboxSyncContainerName(sandboxId: string): string {
  return `${sandboxContainerName(sandboxId)}-sync`;
}

export function sandboxSnapshotVolumeName(snapshotId: string): string {
  return `toolplane_snapshot_${snapshotId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

function validVolumeName(volumeName: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(volumeName);
}

function runDocker(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Docker command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_DOCKER_ERROR_BYTES) {
        stdout += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stdout.length);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DOCKER_ERROR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stderr.length);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Docker command failed (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

async function dockerBestEffort(args: string[]): Promise<void> {
  await runDocker(args).catch(() => undefined);
}

async function runDockerIdempotent(args: string[], missingPattern: RegExp): Promise<void> {
  try {
    await runDocker(args);
  } catch (error) {
    if (error instanceof Error && missingPattern.test(error.message)) return;
    throw error;
  }
}

export function dockerVolumeCopyArgs(
  sourceVolume: string,
  destinationVolume: string,
  replace = false,
  helperName?: string,
): string[] {
  if (!validVolumeName(sourceVolume) || !validVolumeName(destinationVolume)) {
    throw new Error('Invalid Docker volume name.');
  }
  if (sourceVolume === destinationVolume) {
    throw new Error('Source and destination Docker volumes must be different.');
  }
  if (helperName && !validVolumeName(helperName)) {
    throw new Error('Invalid Docker helper container name.');
  }

  const prepareDestination = replace
    ? 'rm -rf /to/* /to/.[!.]* /to/..?*'
    : 'test -z "$(find /to -mindepth 1 -print -quit)"';
  return [
    'run',
    '--rm',
    ...(helperName ? ['--name', helperName, '--label', 'toolplane.volume-copy=true'] : []),
    '--read-only',
    '--network',
    'none',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'DAC_OVERRIDE',
    '--cap-add',
    'FOWNER',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=volume,src=${sourceVolume},dst=/from,readonly`,
    '--mount',
    `type=volume,src=${destinationVolume},dst=/to`,
    VOLUME_HELPER_IMAGE,
    'sh',
    '-c',
    `set -euo pipefail; ${prepareDestination}; tar -C /from -cf - . | tar -C /to -xpf -`,
  ];
}

export async function copyDockerVolume(
  sourceVolume: string,
  destinationVolume: string,
  options: { replace?: boolean } = {},
): Promise<void> {
  if (!validVolumeName(destinationVolume)) throw new Error('Invalid Docker volume name.');
  if (!validVolumeName(sourceVolume)) throw new Error('Invalid Docker volume name.');
  await runDocker(['volume', 'inspect', sourceVolume]);
  await runDocker(['volume', 'create', destinationVolume]);
  const helperName = `toolplane-volume-copy-${randomUUID()}`;
  let copyError: unknown;
  try {
    await runDocker(
      dockerVolumeCopyArgs(sourceVolume, destinationVolume, options.replace, helperName),
      VOLUME_COPY_TIMEOUT_MS,
    );
  } catch (error) {
    copyError = error;
  }

  try {
    await removeDockerVolumeCopyHelper(helperName);
  } catch (cleanupError) {
    if (copyError) {
      throw new DockerVolumeCopyCleanupError(
        [copyError, cleanupError],
        'Docker volume copy failed and its helper container could not be removed.',
        helperName,
      );
    }
    throw new DockerVolumeCopyCleanupError(
      [cleanupError],
      'Docker volume copy helper container could not be removed.',
      helperName,
    );
  }
  if (copyError) throw copyError;
}

export async function removeDockerVolumeCopyHelper(helperName: string): Promise<void> {
  if (!validVolumeName(helperName)) throw new Error('Invalid Docker helper container name.');
  await runDockerIdempotent(['rm', '-f', helperName], /no such container/i);
}

export async function removeStaleDockerVolumeCopyHelpers(
  createdBefore = new Date(),
): Promise<number> {
  const output = await runDocker([
    'ps',
    '-aq',
    '--filter',
    'label=toolplane.volume-copy=true',
  ]);
  const containerIds = output.split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const containerId of containerIds) {
    let created: string;
    try {
      created = (await runDocker(['inspect', '--format', '{{.Created}}', containerId])).trim();
    } catch (error) {
      if (error instanceof Error && /no such (object|container)/i.test(error.message)) continue;
      throw error;
    }
    const createdAt = Date.parse(created);
    if (!Number.isFinite(createdAt)) {
      throw new Error(`Docker returned an invalid creation time for copy helper ${containerId}.`);
    }
    if (createdAt >= createdBefore.getTime()) continue;
    await runDockerIdempotent(['rm', '-f', containerId], /no such container/i);
    removed += 1;
  }
  return removed;
}

export async function removeDockerVolume(volumeName: string): Promise<void> {
  if (!validVolumeName(volumeName)) return;
  await dockerBestEffort(['volume', 'rm', '-f', volumeName]);
}

export async function removeDockerVolumeStrict(volumeName: string): Promise<void> {
  if (!validVolumeName(volumeName)) throw new Error('Invalid Docker volume name.');
  await runDockerIdempotent(['volume', 'rm', '-f', volumeName], /no such volume/i);
}

export async function removeDockerSandboxRuntime(sandboxId: string, volumeName?: string | null): Promise<void> {
  await dockerBestEffort(['rm', '-f', sandboxSyncContainerName(sandboxId)]);
  await dockerBestEffort(['rm', '-f', sandboxContainerName(sandboxId)]);
  await removeDockerVolume(volumeName || sandboxVolumeName(sandboxId));
}

export async function removeDockerSandboxContainer(sandboxId: string): Promise<void> {
  await dockerBestEffort(['rm', '-f', sandboxContainerName(sandboxId)]);
}

export async function removeDockerSandboxRuntimeStrict(
  sandboxId: string,
  volumeName?: string | null,
): Promise<void> {
  await runDockerIdempotent(
    ['rm', '-f', sandboxSyncContainerName(sandboxId)],
    /no such container/i,
  );
  await runDockerIdempotent(['rm', '-f', sandboxContainerName(sandboxId)], /no such container/i);
  await removeDockerVolumeStrict(volumeName || sandboxVolumeName(sandboxId));
}

export async function stopDockerSandboxContainer(sandboxId: string): Promise<void> {
  await runDockerIdempotent(
    ['stop', '--time', '10', sandboxContainerName(sandboxId)],
    /no such container/i,
  );
}
