import 'server-only';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { decryptSecretText } from '@/lib/security/secrets';
import {
  MAX_RUNTIME_TEXT_FILE_BYTES,
  MAX_RUNTIME_TEXT_FILES,
  MAX_RUNTIME_TEXT_FILES_BYTES,
  RUNTIME_FILE_MOUNT_PATH,
  isPlainText,
  safeRuntimeFilePath,
} from '@/lib/workspace/runtime-files';

/**
 * The only path at which deployment-provided files are exposed to an MCP
 * container.  Spawn specs mount the named volume here as read-only.
 */
export const DEPLOYMENT_CONFIG_MOUNT_PATH = RUNTIME_FILE_MOUNT_PATH;

const CONFIG_VOLUME_PREFIX = 'toolplane_mcp_config_';
const CONFIG_HELPER_IMAGE = process.env.MCP_CONFIG_VOLUME_HELPER_IMAGE?.trim()
  || process.env.SANDBOX_VOLUME_HELPER_IMAGE?.trim()
  || 'alpine:3.20';
const CONFIG_HELPER_TIMEOUT_MS = 2 * 60_000;
/**
 * A helper normally exists for seconds. Leave a generous window across a
 * server restart before considering a stopped helper orphaned.
 */
export const DEPLOYMENT_CONFIG_MATERIALIZER_STALE_AFTER_MS = 10 * 60_000;
const MAX_DOCKER_ERROR_BYTES = 64 * 1024;
const MAX_REDACTION_VALUE_BYTES = 16 * 1024;
const MAX_REDACTION_VALUES = 512;
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;
const CONFIG_MATERIALIZER_LABEL = 'toolplane.mcp-config-materializer=true';
const STOPPED_CONFIG_MATERIALIZER_STATES = new Set(['created', 'exited', 'dead']);

type DeploymentConfigFileRow = {
  id: string;
  path: string;
  encryptedContent: unknown;
  size: number;
};

// Kept structurally typed so this module can land in the same change as the
// Prisma schema/migration without requiring a generated client in every
// intermediate checkout. At runtime this is Prisma's deploymentConfigFile
// delegate.
type DeploymentConfigFileDelegate = {
  findMany(args: {
    where: { deploymentId: string };
    select: {
      id: true;
      path: true;
      encryptedContent: true;
      size: true;
    };
    orderBy: Array<{ path: 'asc' } | { id: 'asc' }>;
  }): Promise<DeploymentConfigFileRow[]>;
};

export type DeploymentConfigVolumeMaterialization = {
  hasFiles: boolean;
  /**
   * In-memory only values to append to the deployment stderr redactor. Never
   * put these values in a runtime registry, Docker argv, or log message.
   */
  redactionValues: string[];
};

type MaterializedConfigFile = {
  path: string;
  content: string;
};

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

function runDocker(
  args: string[],
  timeoutMs = CONFIG_HELPER_TIMEOUT_MS,
  input?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: dockerEnv(),
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
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

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DOCKER_ERROR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stderr.length);
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_DOCKER_ERROR_BYTES) {
        stdout += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stdout.length);
      }
    });
    child.stdin?.once('error', (error) => finish(error));
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Docker command failed (${signal ?? code ?? 'unknown'}).`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * Runtime configuration is bounded to 2 MiB, so a short in-memory tar stream
 * avoids a host bind mount while remaining safe to pass to a remote Docker
 * daemon over stdin.
 */
function createStagedConfigArchive(stagingDirectory: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-C', stagingDirectory, '-cf', '-', '.'], {
      env: dockerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Configuration archive command timed out after ${CONFIG_HELPER_TIMEOUT_MS}ms.`));
    }, CONFIG_HELPER_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DOCKER_ERROR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stderr.length);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Configuration archive command failed (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

async function runDockerIdempotent(args: string[], missingPattern: RegExp): Promise<void> {
  try {
    await runDocker(args);
  } catch (error) {
    if (error instanceof Error && missingPattern.test(error.message)) return;
    throw error;
  }
}

function safeDeploymentIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!normalized) throw new Error('Deployment id is required.');
  // Docker object names have a 255-byte ceiling. Deployment ids are normally
  // cuid values, but retaining a bounded fallback keeps this helper safe when
  // it is called with an externally supplied id.
  return normalized.slice(0, 180);
}

/** Derive a deterministic, Docker-safe named volume for a deployment. */
export function configVolumeName(deploymentId: string): string {
  return `${CONFIG_VOLUME_PREFIX}${safeDeploymentIdentifier(deploymentId)}`;
}

/**
 * Allow portable relative file paths, including arbitrary file extensions and
 * no extension at all. Paths are later resolved below a newly-created staging
 * root as a second defence against traversal.
 */
export const safeDeploymentConfigFilePath = safeRuntimeFilePath;

/**
 * Text values are already UTF-8 JavaScript strings after decryption. Reject
 * NUL and lone UTF-16 surrogates so writing the value cannot silently turn it
 * into a different byte sequence. Upload validation should additionally use
 * a fatal UTF-8 decoder before encrypting raw bytes.
 */
export const isDeploymentConfigText = isPlainText;

function isPathInside(root: string, target: string): boolean {
  return target.startsWith(`${root}${path.sep}`);
}

function assertDockerVolumeName(value: string): void {
  if (!DOCKER_VOLUME_NAME.test(value)) throw new Error('Invalid Docker volume name.');
}

/**
 * A short-lived init container receives the staged tar archive on stdin, then
 * copies it into the named volume without network access. This intentionally
 * avoids a host bind mount: Docker may be reached through a remote socket.
 */
export function deploymentConfigVolumeHelperArgs(volumeName: string): string[] {
  assertDockerVolumeName(volumeName);
  const materializeScript = [
    'set -eu',
    'mkdir -p /tmp/toolplane-config',
    'tar -xof - -C /tmp/toolplane-config',
    `mkdir -p ${DEPLOYMENT_CONFIG_MOUNT_PATH}`,
    `rm -rf ${DEPLOYMENT_CONFIG_MOUNT_PATH}/* ${DEPLOYMENT_CONFIG_MOUNT_PATH}/.[!.]* ${DEPLOYMENT_CONFIG_MOUNT_PATH}/..?*`,
    `cp -R /tmp/toolplane-config/. ${DEPLOYMENT_CONFIG_MOUNT_PATH}/`,
    // The final mount is deployment-private and read-only. Files must still
    // be readable by a custom MCP image that declares a non-root USER.
    `find ${DEPLOYMENT_CONFIG_MOUNT_PATH} -type d -exec chmod 755 {} +`,
    `find ${DEPLOYMENT_CONFIG_MOUNT_PATH} -type f -exec chmod 444 {} +`,
  ].join('; ');

  return [
    'run',
    '--rm',
    '-i',
    '--label', 'toolplane.mcp-config-materializer=true',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volumeName},dst=${DEPLOYMENT_CONFIG_MOUNT_PATH}`,
    CONFIG_HELPER_IMAGE,
    'sh', '-c', materializeScript,
  ];
}

function deploymentConfigFileDelegate(): DeploymentConfigFileDelegate {
  const delegate = (db as unknown as { deploymentConfigFile?: DeploymentConfigFileDelegate })
    .deploymentConfigFile;
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new Error('DeploymentConfigFile Prisma model is unavailable. Run prisma generate after migrating.');
  }
  return delegate;
}

function redactionValue(values: Set<string>, raw: string): void {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_REDACTION_VALUE_BYTES) return;
  if (raw.length < 3 || values.size >= MAX_REDACTION_VALUES) return;
  values.add(raw);
}

function isSensitiveKey(raw: string): boolean {
  return /(?:api[_-]?key|token|secret|pass(?:word|wd)?|credential|authorization|cookie|private[_-]?key|access[_-]?key|client[_-]?secret)/i.test(raw);
}

function unquoteConfigValue(raw: string): string {
  const value = raw.trim().replace(/[,}\]]+\s*$/, '');
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))) {
    const quoted = value[0] === '"' ? value : null;
    if (quoted) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'string') return parsed;
      } catch {
        // Fall through to the literal content below.
      }
    }
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Produce bounded exact-match redactions from arbitrary text configuration.
 * The whole file and its lines catch direct echoes (including PEM files), and
 * the key/value pass catches an MCP which only prints a password or token.
 */
export function deploymentConfigRedactionValues(contents: readonly string[]): string[] {
  const values = new Set<string>();
  const allLines: string[] = [];
  const sensitiveLines: string[] = [];

  for (const content of contents) {
    redactionValue(values, content);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      allLines.push(trimmed);
      const keyValue = /^\s*["']?([^"':=]+?)["']?\s*[:=]\s*(.*)$/.exec(line);
      if (keyValue && isSensitiveKey(keyValue[1])) {
        sensitiveLines.push(trimmed);
        redactionValue(values, unquoteConfigValue(keyValue[2]));
      }
      for (const match of line.matchAll(/(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^:/@\s]+:([^@/\s]+)@/g)) {
        redactionValue(values, match[1]);
      }
    }
  }

  // Prioritize sensitive assignments if the generic line budget is reached.
  for (const value of sensitiveLines) redactionValue(values, value);
  for (const value of allLines) redactionValue(values, value);
  return [...values].sort((left, right) => right.length - left.length);
}

function materializeRows(rows: DeploymentConfigFileRow[]): MaterializedConfigFile[] {
  const files: MaterializedConfigFile[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  if (rows.length > MAX_RUNTIME_TEXT_FILES) {
    throw new Error(`Deployment configuration exceeds ${MAX_RUNTIME_TEXT_FILES} files.`);
  }
  for (const row of rows) {
    const safePath = safeDeploymentConfigFilePath(row.path);
    if (!safePath) throw new Error('Deployment configuration contains an unsafe file path.');
    // Docker containers on Linux distinguish case but user machines often do
    // not. Rejecting portable collisions keeps edits deterministic.
    const pathKey = safePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(pathKey)) throw new Error(`Deployment configuration contains duplicate file path: ${safePath}`);
    seen.add(pathKey);

    const content = decryptSecretText(row.encryptedContent);
    if (!isDeploymentConfigText(content)) {
      throw new Error(`Deployment configuration file is not valid text: ${safePath}`);
    }
    const actualSize = Buffer.byteLength(content, 'utf8');
    if (!Number.isSafeInteger(row.size) || row.size < 0 || actualSize !== row.size) {
      throw new Error(`Deployment configuration file size does not match its content: ${safePath}`);
    }
    if (actualSize > MAX_RUNTIME_TEXT_FILE_BYTES) {
      throw new Error(`Deployment configuration file exceeds ${MAX_RUNTIME_TEXT_FILE_BYTES} bytes: ${safePath}`);
    }
    totalSize += actualSize;
    if (totalSize > MAX_RUNTIME_TEXT_FILES_BYTES) {
      throw new Error(`Deployment configuration exceeds ${MAX_RUNTIME_TEXT_FILES_BYTES} bytes in total.`);
    }
    files.push({ path: safePath, content });
  }
  return files;
}

async function writeStagedConfigFiles(files: MaterializedConfigFile[]): Promise<string> {
  const root = await mkdtemp(path.join(/* turbopackIgnore: true */ os.tmpdir(), 'toolplane-mcp-config-'));
  await chmod(root, 0o700);
  try {
    for (const file of files) {
      const target = path.resolve(root, file.path);
      if (!isPathInside(root, target)) throw new Error('Deployment configuration path escaped its staging directory.');
      const directory = path.dirname(target);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(target, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(target, 0o600);
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Decrypt and project a deployment's text files into its dedicated Docker
 * volume. The temporary host directory crosses the Docker boundary as a tar
 * stream over stdin, which works with a remote Docker socket as well as local
 * Docker.
 */
export async function materializeDeploymentConfigVolume(
  deploymentId: string,
): Promise<DeploymentConfigVolumeMaterialization> {
  const volumeName = configVolumeName(deploymentId);
  const rows = await deploymentConfigFileDelegate().findMany({
    where: { deploymentId },
    select: { id: true, path: true, encryptedContent: true, size: true },
    orderBy: [{ path: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) {
    // A deleted final file must not leave a stale secret volume behind.
    await removeDeploymentConfigVolume(deploymentId);
    return { hasFiles: false, redactionValues: [] };
  }

  // Validate/decrypt everything before creating Docker resources. A malformed
  // ciphertext therefore never causes a partial runtime projection.
  const files = materializeRows(rows);
  const redactionValues = deploymentConfigRedactionValues(files.map((file) => file.content));
  const stagingDirectory = await writeStagedConfigFiles(files);
  let operationError: unknown;
  try {
    const archive = await createStagedConfigArchive(stagingDirectory);
    await runDocker(['volume', 'create', volumeName]);
    await runDocker(deploymentConfigVolumeHelperArgs(volumeName), CONFIG_HELPER_TIMEOUT_MS, archive);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && !operationError) {
      throw new AggregateError(cleanupErrors, 'Deployment configuration materializer cleanup failed.');
    }
  }

  return { hasFiles: true, redactionValues };
}

type DockerHelperInspection = {
  createdAt: number;
  status: string;
};

function parseDockerHelperInspection(output: string): DockerHelperInspection {
  const [created, status, ...extra] = output.trim().split('\t');
  const createdAt = Date.parse(created ?? '');
  if (!Number.isFinite(createdAt) || !status || extra.length > 0) {
    throw new Error('Docker returned an invalid deployment configuration helper inspection.');
  }
  return { createdAt, status };
}

function isMissingDockerContainer(error: unknown): boolean {
  return error instanceof Error && /no such (object|container)/i.test(error.message);
}

function isRunningDockerContainer(error: unknown): boolean {
  return error instanceof Error && /(?:is|container) running|cannot remove a running container/i.test(error.message);
}

/**
 * Remove stopped materializer helpers left by a process crash. It deliberately
 * uses `docker rm` without `--force`: a helper that becomes running after its
 * inspection is left alone rather than being killed by a recovery sweep.
 */
export async function removeStaleDeploymentConfigMaterializerHelpers(
  createdBefore = new Date(Date.now() - DEPLOYMENT_CONFIG_MATERIALIZER_STALE_AFTER_MS),
): Promise<number> {
  const cutoff = createdBefore.getTime();
  if (!Number.isFinite(cutoff)) throw new Error('Invalid deployment configuration helper cutoff.');

  const output = await runDocker([
    'ps',
    '-aq',
    '--filter',
    `label=${CONFIG_MATERIALIZER_LABEL}`,
  ]);
  const containerIds = output.split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const containerId of containerIds) {
    let inspection: DockerHelperInspection;
    try {
      inspection = parseDockerHelperInspection(await runDocker([
        'inspect',
        '--format',
        '{{.Created}}\t{{.State.Status}}',
        containerId,
      ]));
    } catch (error) {
      if (isMissingDockerContainer(error)) continue;
      throw error;
    }
    if (inspection.createdAt >= cutoff || !STOPPED_CONFIG_MATERIALIZER_STATES.has(inspection.status)) {
      continue;
    }
    try {
      await runDocker(['rm', containerId]);
      removed += 1;
    } catch (error) {
      // A concurrently-started helper is never an excuse to use `rm -f`.
      if (isMissingDockerContainer(error) || isRunningDockerContainer(error)) continue;
      throw error;
    }
  }
  return removed;
}

/** Remove a deployment's configuration volume, ignoring an already-removed volume. */
export async function removeDeploymentConfigVolume(deploymentId: string): Promise<void> {
  const volumeName = configVolumeName(deploymentId);
  await runDockerIdempotent(['volume', 'rm', '-f', volumeName], /no such volume/i);
}
