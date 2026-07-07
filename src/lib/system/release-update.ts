import 'server-only';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_UPDATE_REPO = 'asharca/ToolPlane';
const DEFAULT_UPDATE_ARTIFACT = 'toolplane-runtime-linux-amd64.tar.gz';
const UPDATE_DIR = '.toolplane-update';
const VERSION_FILE = '.toolplane-version';
const MAX_DOWNLOAD_BYTES = 1_500_000_000;
const TRUSTED_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export const RUNTIME_UPDATE_ENTRIES = [
  '.next',
  'node_modules',
  'public',
  'package.json',
  'next.config.ts',
  'scripts',
  'prisma',
  'prisma.config.ts',
  VERSION_FILE,
] as const;

type GitHubRelease = {
  tag_name: string;
  name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GitHubReleaseAsset[];
};

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size?: number;
};

export type SystemUpdateStatus = {
  enabled: boolean;
  canUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  releaseName: string | null;
  releaseUrl: string | null;
  artifactName: string;
  reason: string | null;
};

export type LocalSystemUpdateStatus = {
  currentVersion: string;
  artifactName: string;
};

export type SystemUpdateResult =
  | {
      ok: true;
      status: 'up_to_date' | 'restarting';
      currentVersion: string;
      latestVersion: string | null;
      artifactName: string;
      message?: string;
    }
  | {
      ok: false;
      status: 'disabled' | 'unavailable' | 'failed';
      currentVersion: string;
      latestVersion: string | null;
      artifactName: string;
      message: string;
    };

type ReplacementRecord = {
  entry: string;
  backupPath: string;
  hadExisting: boolean;
};

function updateEnabled(): boolean {
  return process.env.TOOLPLANE_UPDATE_ENABLED !== 'false';
}

function updateRepo(): string {
  return process.env.TOOLPLANE_UPDATE_REPO || DEFAULT_UPDATE_REPO;
}

function updateArtifactName(): string {
  return process.env.TOOLPLANE_UPDATE_ARTIFACT || DEFAULT_UPDATE_ARTIFACT;
}

function runtimeRoot(): string | null {
  return process.env.TOOLPLANE_RUNTIME_ROOT || null;
}

function versionRoot(): string {
  return runtimeRoot() ?? process.cwd();
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function canWriteRuntime(root: string): Promise<boolean> {
  try {
    await access(root, 2);
    return true;
  } catch {
    return false;
  }
}

export async function readCurrentVersion(root = versionRoot()): Promise<string> {
  const versionPath = path.join(/* turbopackIgnore: true */ root, VERSION_FILE);
  try {
    const value = (await readFile(versionPath, 'utf8')).trim();
    if (value) return value;
  } catch {
    // Older images do not have a version file.
  }
  return process.env.TOOLPLANE_VERSION || 'unknown';
}

function githubHeaders(): HeadersInit {
  const token = process.env.TOOLPLANE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'ToolPlane updater',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const repo = updateRepo();
  const tag = process.env.TOOLPLANE_UPDATE_TAG;
  const endpoint = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetch(endpoint, {
    headers: githubHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
  }
  return (await response.json()) as GitHubRelease;
}

function findReleaseAsset(release: GitHubRelease, name: string): GitHubReleaseAsset | null {
  return release.assets?.find((asset) => asset.name === name) ?? null;
}

function sameVersion(current: string, latest: string | null): boolean {
  if (!latest) return false;
  return current.trim() === latest.trim();
}

export async function getSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const artifactName = updateArtifactName();
  const currentVersion = await readCurrentVersion();
  const root = runtimeRoot();

  if (!updateEnabled()) {
    return disabledStatus(currentVersion, artifactName, 'Updates are disabled.');
  }
  if (!root) {
    return disabledStatus(currentVersion, artifactName, 'Runtime directory is not configured.');
  }
  if (!(await canWriteRuntime(root))) {
    return disabledStatus(currentVersion, artifactName, 'Runtime directory is not writable.');
  }

  try {
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name || null;
    const artifact = findReleaseAsset(release, artifactName);
    if (!artifact) {
      return {
        enabled: true,
        canUpdate: false,
        currentVersion,
        latestVersion,
        updateAvailable: null,
        releaseName: release.name ?? latestVersion,
        releaseUrl: release.html_url ?? null,
        artifactName,
        reason: `Release artifact not found: ${artifactName}`,
      };
    }

    return {
      enabled: true,
      canUpdate: true,
      currentVersion,
      latestVersion,
      updateAvailable: latestVersion ? !sameVersion(currentVersion, latestVersion) : null,
      releaseName: release.name ?? latestVersion,
      releaseUrl: release.html_url ?? null,
      artifactName,
      reason: null,
    };
  } catch (error) {
    return disabledStatus(currentVersion, artifactName, displayError(error));
  }
}

export async function getLocalSystemUpdateStatus(): Promise<LocalSystemUpdateStatus> {
  return {
    currentVersion: await readCurrentVersion(),
    artifactName: updateArtifactName(),
  };
}

function disabledStatus(currentVersion: string, artifactName: string, reason: string): SystemUpdateStatus {
  return {
    enabled: updateEnabled(),
    canUpdate: false,
    currentVersion,
    latestVersion: null,
    updateAvailable: null,
    releaseName: null,
    releaseUrl: null,
    artifactName,
    reason,
  };
}

export async function applySystemUpdate(): Promise<SystemUpdateResult> {
  const artifactName = updateArtifactName();
  const currentVersion = await readCurrentVersion();
  const root = runtimeRoot();

  if (!updateEnabled()) {
    return { ok: false, status: 'disabled', currentVersion, latestVersion: null, artifactName, message: 'Updates are disabled.' };
  }
  if (!root) {
    return {
      ok: false,
      status: 'unavailable',
      currentVersion,
      latestVersion: null,
      artifactName,
      message: 'Runtime directory is not configured.',
    };
  }
  if (!(await canWriteRuntime(root))) {
    return {
      ok: false,
      status: 'unavailable',
      currentVersion,
      latestVersion: null,
      artifactName,
      message: 'Runtime directory is not writable.',
    };
  }

  try {
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name || null;
    if (sameVersion(currentVersion, latestVersion)) {
      return { ok: true, status: 'up_to_date', currentVersion, latestVersion, artifactName };
    }

    const artifact = findReleaseAsset(release, artifactName);
    if (!artifact) {
      return {
        ok: false,
        status: 'unavailable',
        currentVersion,
        latestVersion,
        artifactName,
        message: `Release artifact not found: ${artifactName}`,
      };
    }

    const checksumAsset = findReleaseAsset(release, `${artifactName}.sha256`);
    if (!checksumAsset) {
      return {
        ok: false,
        status: 'unavailable',
        currentVersion,
        latestVersion,
        artifactName,
        message: `Release checksum not found: ${artifactName}.sha256`,
      };
    }

    await downloadAndApplyRelease(root, artifact, checksumAsset);
    scheduleRestart();

    return {
      ok: true,
      status: 'restarting',
      currentVersion,
      latestVersion,
      artifactName,
      message: 'Release files updated. ToolPlane is restarting.',
    };
  } catch (error) {
    return { ok: false, status: 'failed', currentVersion, latestVersion: null, artifactName, message: displayError(error) };
  }
}

async function downloadAndApplyRelease(
  root: string,
  artifact: GitHubReleaseAsset,
  checksumAsset: GitHubReleaseAsset,
): Promise<void> {
  const updateRoot = path.join(/* turbopackIgnore: true */ root, UPDATE_DIR);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workRoot = path.join(/* turbopackIgnore: true */ updateRoot, `work-${stamp}`);
  const stagingRoot = path.join(/* turbopackIgnore: true */ workRoot, 'staging');
  const archivePath = path.join(/* turbopackIgnore: true */ workRoot, artifact.name);
  const checksumPath = path.join(/* turbopackIgnore: true */ workRoot, checksumAsset.name);

  await mkdir(stagingRoot, { recursive: true });

  try {
    await downloadFile(artifact.browser_download_url, archivePath);
    await downloadFile(checksumAsset.browser_download_url, checksumPath, 1_000_000);
    await verifyChecksum(archivePath, checksumPath, artifact.name);
    await extractArchive(archivePath, stagingRoot);

    const appRoot = path.join(/* turbopackIgnore: true */ stagingRoot, 'app');
    const payloadRoot = (await pathExists(appRoot)) ? appRoot : stagingRoot;
    await assertPayload(payloadRoot);
    await replaceRuntimeEntries(root, payloadRoot, path.join(/* turbopackIgnore: true */ updateRoot, `backup-${stamp}`));
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadFile(url: string, dest: string, maxBytes = MAX_DOWNLOAD_BYTES): Promise<void> {
  validateDownloadUrl(url);
  const response = await fetch(url, {
    headers: githubHeaders(),
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  validateDownloadUrl(response.url);

  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > maxBytes) {
    throw new Error(`Download is too large: ${size} bytes`);
  }

  const file = await open(dest, 'w', 0o600);
  try {
    let downloaded = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > maxBytes) {
        throw new Error(`Download exceeded ${maxBytes} bytes`);
      }
      await file.write(value);
    }
  } finally {
    await file.close();
  }
}

function validateDownloadUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS release downloads are allowed.');
  }
  if (!TRUSTED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`Release download host is not trusted: ${parsed.hostname}`);
  }
}

async function verifyChecksum(archivePath: string, checksumPath: string, artifactName: string): Promise<void> {
  const checksumText = await readFile(checksumPath, 'utf8');
  const expected = parseChecksum(checksumText, artifactName);
  if (!expected) {
    throw new Error(`Checksum file does not contain ${artifactName}`);
  }
  const actual = await sha256File(archivePath);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${artifactName}`);
  }
}

export function parseChecksum(text: string, artifactName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file && path.basename(file) === artifactName && /^[a-fA-F0-9]{64}$/.test(hash)) {
      return hash.toLowerCase();
    }
  }
  return null;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr}`));
    });
  });
}

async function extractArchive(archivePath: string, dest: string): Promise<void> {
  await runCommand('tar', ['-xzf', archivePath, '-C', dest], 10 * 60_000);
}

async function assertPayload(payloadRoot: string): Promise<void> {
  for (const entry of RUNTIME_UPDATE_ENTRIES) {
    if (!(await pathExists(path.join(/* turbopackIgnore: true */ payloadRoot, entry)))) {
      throw new Error(`Release artifact is missing runtime entry: ${entry}`);
    }
  }
}

async function replaceRuntimeEntries(root: string, payloadRoot: string, backupRoot: string): Promise<void> {
  await mkdir(backupRoot, { recursive: true });
  const replacements: ReplacementRecord[] = [];
  const installed: string[] = [];

  try {
    for (const entry of RUNTIME_UPDATE_ENTRIES) {
      const dest = path.join(/* turbopackIgnore: true */ root, entry);
      const backupPath = path.join(/* turbopackIgnore: true */ backupRoot, entry);
      const hadExisting = await pathExists(dest);
      if (hadExisting) {
        await mkdir(path.dirname(backupPath), { recursive: true });
        await movePath(dest, backupPath);
      }
      replacements.push({ entry, backupPath, hadExisting });
      await movePath(path.join(/* turbopackIgnore: true */ payloadRoot, entry), dest);
      installed.push(entry);
    }
  } catch (error) {
    await rollbackRuntimeEntries(root, replacements, installed);
    throw error;
  }
}

async function rollbackRuntimeEntries(root: string, replacements: ReplacementRecord[], installed: string[]): Promise<void> {
  for (const entry of installed.reverse()) {
    await rm(path.join(/* turbopackIgnore: true */ root, entry), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const record of replacements.reverse()) {
    if (record.hadExisting) {
      await movePath(record.backupPath, path.join(/* turbopackIgnore: true */ root, record.entry)).catch(() => undefined);
    }
  }
}

async function movePath(source: string, dest: string): Promise<void> {
  try {
    await rename(source, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(source, dest, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    await rm(source, { recursive: true, force: true });
  }
}

function scheduleRestart(): void {
  const delay = Math.max(250, Number(process.env.TOOLPLANE_RESTART_DELAY_MS) || 750);
  setTimeout(() => {
    process.exit(0);
  }, delay).unref();
}
