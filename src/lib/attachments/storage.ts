import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ATTACHMENT_VOLUME_PREFIX = 'toolplane_attachment_';
const ATTACHMENT_MOUNT_PATH = '/attachments';
const HELPER_IMAGE = process.env.SANDBOX_VOLUME_HELPER_IMAGE?.trim() || 'alpine:3.20';
const HELPER_TIMEOUT_MS = 15 * 60_000;
const MAX_DOCKER_ERROR_BYTES = 64 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STORAGE_PATH = /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/i;

export class AttachmentTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Attachment exceeds ${maxBytes} bytes.`);
    this.name = 'AttachmentTooLargeError';
  }
}

export class EmptyAttachmentError extends Error {
  constructor() {
    super('A non-empty attachment is required.');
    this.name = 'EmptyAttachmentError';
  }
}

export class AttachmentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentStorageError';
  }
}

export function workspaceAttachmentVolumeName(workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId)) throw new AttachmentStorageError('Invalid workspace id.');
  return `${ATTACHMENT_VOLUME_PREFIX}${workspaceId}`;
}

export function safeAttachmentFilename(value: string): string {
  return (value.replace(/\\/g, '/').split('/').at(-1) || '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'attachment';
}

function checkedStoragePath(storagePath: string): string {
  if (!STORAGE_PATH.test(storagePath)) {
    throw new AttachmentStorageError('Invalid attachment storage path.');
  }
  return `${ATTACHMENT_MOUNT_PATH}/${storagePath}`;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function appendError(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, 'utf8') >= MAX_DOCKER_ERROR_BYTES) return current;
  return Buffer.concat([
    Buffer.from(current, 'utf8'),
    chunk,
  ]).subarray(0, MAX_DOCKER_ERROR_BYTES).toString('utf8');
}

function runDocker(args: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AttachmentStorageError(`Docker command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendError(stderr, chunk); });
    child.once('error', (error) => finish(new AttachmentStorageError(error.message)));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new AttachmentStorageError(stderr.trim() || `Docker command failed (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

function helperArgs(
  volumeName: string,
  script: string,
  scriptArgs: string[],
  options: { input?: boolean; readOnly?: boolean } = {},
): string[] {
  return [
    'run',
    '--rm',
    ...(options.input ? ['-i'] : []),
    '--label', 'toolplane.attachment-helper=true',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.25',
    '--pids-limit', '32',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volumeName},dst=${ATTACHMENT_MOUNT_PATH}${options.readOnly ? ',readonly' : ''}`,
    HELPER_IMAGE,
    'sh',
    '-c',
    script,
    'toolplane-attachment-helper',
    ...scriptArgs,
  ];
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stderr });
    };
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendError(stderr, chunk); });
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

async function streamIntoHelper(
  args: string[],
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  const child = spawn('docker', args, { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  const resultPromise = waitForChild(child);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      callback(size > maxBytes ? new AttachmentTooLargeError(maxBytes) : null, chunk);
    },
  });
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Attachment upload timed out.')), HELPER_TIMEOUT_MS);

  try {
    await pipeline(Readable.fromWeb(body as never), limiter, child.stdin, { signal: controller.signal });
    const result = await resultPromise;
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new AttachmentStorageError(
        result.stderr.trim() || `Docker attachment helper failed (${result.signal ?? result.code ?? 'unknown'}).`,
      );
    }
    return size;
  } catch (error) {
    child.kill('SIGKILL');
    await resultPromise;
    if (error instanceof AttachmentTooLargeError) throw error;
    if (controller.signal.aborted) {
      throw new AttachmentStorageError(signal?.aborted ? 'Attachment upload was aborted.' : 'Attachment upload timed out.');
    }
    throw error instanceof AttachmentStorageError
      ? error
      : new AttachmentStorageError(error instanceof Error ? error.message : 'Attachment upload failed.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function writeWorkspaceAttachment(input: {
  workspaceId: string;
  filename: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ storagePath: string; size: number }> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new AttachmentStorageError('Invalid attachment byte limit.');
  }
  const volumeName = workspaceAttachmentVolumeName(input.workspaceId);
  const objectId = randomUUID();
  const storagePath = `objects/${objectId}-${safeAttachmentFilename(input.filename)}`;
  const target = checkedStoragePath(storagePath);
  const temporary = `${ATTACHMENT_MOUNT_PATH}/.uploads/${objectId}`;
  await runDocker(['volume', 'create', volumeName]);

  try {
    const size = await streamIntoHelper(
      helperArgs(
        volumeName,
        'set -eu; mkdir -p "$(dirname "$1")"; cat > "$1"',
        [temporary],
        { input: true },
      ),
      input.body,
      input.maxBytes,
      input.signal,
    );
    if (size === 0) throw new EmptyAttachmentError();
    await runDocker(helperArgs(
      volumeName,
      'set -eu; test -f "$1"; test "$(wc -c < "$1")" -eq "$3"; mkdir -p "$(dirname "$2")"; chmod 600 "$1"; mv -f "$1" "$2"',
      [temporary, target, String(size)],
    ));
    return { storagePath, size };
  } catch (error) {
    await runDocker(helperArgs(volumeName, 'rm -f "$1"', [temporary])).catch(() => undefined);
    throw error;
  }
}

export function readWorkspaceAttachment(
  workspaceId: string,
  storagePath: string,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AttachmentStorageError('Invalid attachment byte limit.');
  }
  const volumeName = workspaceAttachmentVolumeName(workspaceId);
  const target = checkedStoragePath(storagePath);
  const child = spawn('docker', helperArgs(volumeName, 'cat "$1"', [target], { readOnly: true }), {
    env: dockerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let size = 0;
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        callback(new AttachmentTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
  const timer = setTimeout(() => {
    output.destroy(new AttachmentStorageError('Attachment read timed out.'));
    child.kill('SIGKILL');
  }, HELPER_TIMEOUT_MS);

  child.stdout.pipe(output, { end: false });
  child.stderr.on('data', (chunk: Buffer) => { stderr = appendError(stderr, chunk); });
  child.once('error', (error) => output.destroy(new AttachmentStorageError(error.message)));
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) output.end();
    else output.destroy(new AttachmentStorageError(
      stderr.trim() || `Docker attachment helper failed (${signal ?? code ?? 'unknown'}).`,
    ));
  });
  output.once('close', () => {
    clearTimeout(timer);
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  });

  return Readable.toWeb(output) as ReadableStream<Uint8Array>;
}

export async function deleteWorkspaceAttachmentFile(
  workspaceId: string,
  storagePath: string,
): Promise<void> {
  const volumeName = workspaceAttachmentVolumeName(workspaceId);
  const target = checkedStoragePath(storagePath);
  try {
    await runDocker(['volume', 'inspect', volumeName]);
  } catch (error) {
    if (error instanceof Error && /no such volume/i.test(error.message)) return;
    throw error;
  }
  await runDocker(helperArgs(volumeName, 'rm -f "$1"', [target]));
}

export async function removeWorkspaceAttachmentVolume(workspaceId: string): Promise<void> {
  const volumeName = workspaceAttachmentVolumeName(workspaceId);
  try {
    await runDocker(['volume', 'rm', '-f', volumeName]);
  } catch (error) {
    if (error instanceof Error && /no such volume/i.test(error.message)) return;
    throw error;
  }
}

export async function copyWorkspaceAttachmentToDockerVolume(input: {
  workspaceId: string;
  storagePath: string;
  destinationVolume: string;
  destinationPath: string;
}): Promise<void> {
  const sourceVolume = workspaceAttachmentVolumeName(input.workspaceId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(input.destinationVolume)) {
    throw new AttachmentStorageError('Invalid sandbox volume name.');
  }
  if (
    !/^[A-Za-z0-9._/-]{1,1000}$/.test(input.destinationPath)
    || input.destinationPath.startsWith('/')
    || input.destinationPath.split('/').includes('..')
  ) {
    throw new AttachmentStorageError('Invalid sandbox attachment path.');
  }
  if (!STORAGE_PATH.test(input.storagePath)) {
    throw new AttachmentStorageError('Invalid attachment storage path.');
  }
  await runDocker([
    'run',
    '--rm',
    '--label', 'toolplane.attachment-helper=true',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.25',
    '--pids-limit', '32',
    '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${sourceVolume},dst=/from,readonly`,
    '--mount', `type=volume,src=${input.destinationVolume},dst=/to`,
    HELPER_IMAGE,
    'sh',
    '-c',
    'set -eu; test -f "$1"; mkdir -p "$(dirname "$2")"; cp "$1" "$2"; chmod 600 "$2"',
    'toolplane-attachment-helper',
    `/from/${input.storagePath}`,
    `/to/${input.destinationPath}`,
  ], HELPER_TIMEOUT_MS);
}
