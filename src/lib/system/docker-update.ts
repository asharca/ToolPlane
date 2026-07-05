import 'server-only';

import { spawn } from 'node:child_process';

const DEFAULT_TOOLPLANE_IMAGE = 'ghcr.io/asharca/toolplane:latest';
const DEFAULT_HELPER_DELAY_MS = 1200;
const DOCKER_MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type DockerContainerInspect = {
  Id: string;
  Name: string;
  Image: string;
  Config?: Record<string, unknown> & {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: Record<string, unknown>;
  NetworkSettings?: {
    Networks?: Record<string, DockerNetworkAttachment>;
  };
};

type DockerNetworkAttachment = {
  Aliases?: string[] | null;
  Links?: string[] | null;
  IPAMConfig?: Record<string, unknown> | null;
  DriverOpts?: Record<string, string> | null;
  [key: string]: unknown;
};

type DockerImageInspect = {
  Id: string;
  RepoDigests?: string[];
  RepoTags?: string[];
  Created?: string;
};

type DockerCreateResponse = {
  Id: string;
  Warnings?: string[];
};

export type SystemUpdateStatus = {
  enabled: boolean;
  canUpdate: boolean;
  targetImage: string;
  containerName: string | null;
  currentImage: string | null;
  currentImageId: string | null;
  targetImageId: string | null;
  remoteDigest: string | null;
  updateAvailable: boolean | null;
  reason: string | null;
};

export type SystemUpdateResult =
  | {
      ok: true;
      status: 'up_to_date' | 'restarting';
      targetImage: string;
      currentImageId: string | null;
      targetImageId: string | null;
      helperContainerId?: string;
      message?: string;
    }
  | {
      ok: false;
      status: 'disabled' | 'unavailable' | 'failed';
      targetImage: string;
      message: string;
    };

export type RegistryImageRef = {
  registry: string;
  repository: string;
  reference: string;
};

type ReplacementPlan = {
  oldContainerId: string;
  newContainerId: string;
  networkName: string;
  targetImage: string;
  originalName: string;
  failedName: string;
};

function updateEnabled(): boolean {
  return process.env.TOOLPLANE_UPDATE_ENABLED !== 'false';
}

function targetImageRef(): string {
  return process.env.TOOLPLANE_IMAGE || DEFAULT_TOOLPLANE_IMAGE;
}

function currentContainerRef(): string | null {
  return process.env.TOOLPLANE_CONTAINER_NAME || process.env.HOSTNAME || null;
}

function dockerHttpBase(): string | null {
  const host = process.env.DOCKER_HOST;
  if (!host) return null;
  if (host.startsWith('tcp://')) return `http://${host.slice('tcp://'.length).replace(/\/$/, '')}`;
  if (host.startsWith('http://') || host.startsWith('https://')) return host.replace(/\/$/, '');
  return null;
}

function dockerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST ?? '',
  };
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function containerName(container: DockerContainerInspect): string {
  return container.Name.replace(/^\//, '');
}

async function dockerFetch(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const base = dockerHttpBase();
  if (!base) {
    throw new Error('DOCKER_HOST must point to the socket proxy over tcp://');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Docker API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function dockerJson<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const response = await dockerFetch(path, init, timeoutMs);
  return (await response.json()) as T;
}

async function dockerPost(path: string, timeoutMs?: number): Promise<void> {
  await dockerFetch(path, { method: 'POST' }, timeoutMs);
}

async function inspectContainer(ref: string): Promise<DockerContainerInspect> {
  return dockerJson<DockerContainerInspect>(`/containers/${encodeURIComponent(ref)}/json`);
}

async function inspectImage(ref: string): Promise<DockerImageInspect> {
  return dockerJson<DockerImageInspect>(`/images/${encodeURIComponent(ref)}/json`);
}

async function tryInspectImage(ref: string): Promise<DockerImageInspect | null> {
  try {
    return await inspectImage(ref);
  } catch {
    return null;
  }
}

function runDocker(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: dockerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`docker ${args[0]} timed out`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 20_000) stdout = stdout.slice(-20_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`docker ${args.join(' ')} failed with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export function parseRegistryImageRef(image: string): RegistryImageRef | null {
  let name = image;
  let reference = 'latest';

  const digestIndex = image.indexOf('@');
  if (digestIndex > -1) {
    name = image.slice(0, digestIndex);
    reference = image.slice(digestIndex + 1);
  } else {
    const lastSlash = image.lastIndexOf('/');
    const lastColon = image.lastIndexOf(':');
    if (lastColon > lastSlash) {
      name = image.slice(0, lastColon);
      reference = image.slice(lastColon + 1);
    }
  }

  const parts = name.split('/');
  const first = parts[0];
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (!hasRegistry || parts.length < 2) return null;

  return {
    registry: first,
    repository: parts.slice(1).join('/'),
    reference,
  };
}

async function fetchRegistryDigest(image: string): Promise<string | null> {
  const parsed = parseRegistryImageRef(image);
  if (!parsed) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      `https://${parsed.registry}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.reference)}`,
      {
        method: 'HEAD',
        headers: { accept: DOCKER_MANIFEST_ACCEPT },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    return response.headers.get('docker-content-digest');
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function hasRemoteDigest(image: DockerImageInspect | null, digest: string | null): boolean {
  if (!digest) return false;
  return Boolean(image?.RepoDigests?.some((repoDigest) => repoDigest.endsWith(`@${digest}`)));
}

export async function getSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const targetImage = targetImageRef();
  const containerRef = currentContainerRef();

  if (!updateEnabled()) {
    return disabledStatus(targetImage, containerRef, 'Updates are disabled.');
  }
  if (!dockerHttpBase()) {
    return disabledStatus(targetImage, containerRef, 'Docker socket proxy is not configured.');
  }
  if (!containerRef) {
    return disabledStatus(targetImage, null, 'The app container cannot be identified.');
  }

  try {
    const container = await inspectContainer(containerRef);
    const currentImage = await tryInspectImage(container.Image);
    const localTargetImage = await tryInspectImage(targetImage);
    const remoteDigest = await fetchRegistryDigest(targetImage);
    const updateAvailable = remoteDigest
      ? !hasRemoteDigest(currentImage, remoteDigest)
      : localTargetImage
        ? localTargetImage.Id !== container.Image
        : null;

    return {
      enabled: true,
      canUpdate: true,
      targetImage,
      containerName: containerName(container),
      currentImage: container.Config?.Image ?? null,
      currentImageId: shortId(container.Image),
      targetImageId: shortId(localTargetImage?.Id),
      remoteDigest,
      updateAvailable,
      reason: null,
    };
  } catch (error) {
    return disabledStatus(targetImage, containerRef, displayError(error));
  }
}

function disabledStatus(targetImage: string, containerRef: string | null, reason: string): SystemUpdateStatus {
  return {
    enabled: updateEnabled(),
    canUpdate: false,
    targetImage,
    containerName: containerRef,
    currentImage: null,
    currentImageId: null,
    targetImageId: null,
    remoteDigest: null,
    updateAvailable: null,
    reason,
  };
}

export async function applySystemUpdate(): Promise<SystemUpdateResult> {
  const targetImage = targetImageRef();
  if (!updateEnabled()) {
    return { ok: false, status: 'disabled', targetImage, message: 'Updates are disabled.' };
  }
  if (!dockerHttpBase()) {
    return { ok: false, status: 'unavailable', targetImage, message: 'Docker socket proxy is not configured.' };
  }

  const containerRef = currentContainerRef();
  if (!containerRef) {
    return { ok: false, status: 'unavailable', targetImage, message: 'The app container cannot be identified.' };
  }

  try {
    const container = await inspectContainer(containerRef);
    await runDocker(['pull', targetImage], 10 * 60_000);
    const targetImageInfo = await inspectImage(targetImage);
    if (targetImageInfo.Id === container.Image) {
      return {
        ok: true,
        status: 'up_to_date',
        targetImage,
        currentImageId: shortId(container.Image),
        targetImageId: shortId(targetImageInfo.Id),
      };
    }

    const plan = await createReplacementContainer(container, targetImage);
    const helper = await startUpdateHelper(plan);
    return {
      ok: true,
      status: 'restarting',
      targetImage,
      currentImageId: shortId(container.Image),
      targetImageId: shortId(targetImageInfo.Id),
      helperContainerId: helper.stdout.trim() || undefined,
      message: 'A helper container is switching ToolPlane to the pulled image.',
    };
  } catch (error) {
    return { ok: false, status: 'failed', targetImage, message: displayError(error) };
  }
}

export function buildReplacementCreatePayload(
  container: DockerContainerInspect,
  targetImage: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(container.Config ?? {}), Image: targetImage };
  delete config.Hostname;
  delete config.Domainname;

  return {
    ...config,
    HostConfig: container.HostConfig ?? {},
    NetworkingConfig: {
      EndpointsConfig: buildEndpointsConfig(container.NetworkSettings?.Networks ?? {}),
    },
  };
}

function buildEndpointsConfig(
  networks: Record<string, DockerNetworkAttachment>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(networks).map(([name, network]) => {
      const endpoint: Record<string, unknown> = {};
      if (network.Aliases?.length) endpoint.Aliases = network.Aliases;
      if (network.Links?.length) endpoint.Links = network.Links;
      if (network.IPAMConfig) endpoint.IPAMConfig = network.IPAMConfig;
      if (network.DriverOpts) endpoint.DriverOpts = network.DriverOpts;
      return [name, endpoint];
    }),
  );
}

export function selectUpdateNetwork(container: DockerContainerInspect): string | null {
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  return process.env.TOOLPLANE_UPDATE_NETWORK || networks[0] || null;
}

async function createReplacementContainer(
  container: DockerContainerInspect,
  targetImage: string,
): Promise<ReplacementPlan> {
  const originalName = containerName(container);
  const oldContainerId = container.Id;
  const networkName = selectUpdateNetwork(container);
  if (!networkName) {
    throw new Error('The app container is not attached to a Docker network.');
  }

  const suffix = Date.now().toString(36);
  const backupName = `${originalName}-previous-${suffix}`;
  let renamedOld = false;
  let newContainerId: string | null = null;

  try {
    await dockerPost(`/containers/${encodeURIComponent(oldContainerId)}/rename?name=${encodeURIComponent(backupName)}`);
    renamedOld = true;
    const created = await dockerJson<DockerCreateResponse>(
      `/containers/create?name=${encodeURIComponent(originalName)}`,
      {
        method: 'POST',
        body: JSON.stringify(buildReplacementCreatePayload(container, targetImage)),
      },
    );
    newContainerId = created.Id;
    return {
      oldContainerId,
      newContainerId,
      networkName,
      targetImage,
      originalName,
      failedName: `${originalName}-failed-${suffix}`,
    };
  } catch (error) {
    if (newContainerId) {
      await dockerPost(
        `/containers/${encodeURIComponent(newContainerId)}/rename?name=${encodeURIComponent(`${originalName}-failed-${suffix}`)}`,
      ).catch(() => undefined);
    }
    if (renamedOld) {
      await dockerPost(
        `/containers/${encodeURIComponent(oldContainerId)}/rename?name=${encodeURIComponent(originalName)}`,
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function startUpdateHelper(plan: ReplacementPlan): Promise<{ stdout: string; stderr: string }> {
  const helperName = `toolplane-update-${Date.now().toString(36)}`;
  const dockerHost = process.env.DOCKER_HOST ?? 'tcp://socket-proxy:2375';
  const script = [
    'set -eu',
    `sleep ${Math.max(1, Math.round(DEFAULT_HELPER_DELAY_MS / 1000))}`,
    `docker stop -t 10 ${quoteShell(plan.oldContainerId)} || true`,
    `if docker start ${quoteShell(plan.newContainerId)}; then exit 0; fi`,
    `docker rename ${quoteShell(plan.newContainerId)} ${quoteShell(plan.failedName)} || true`,
    `docker rename ${quoteShell(plan.oldContainerId)} ${quoteShell(plan.originalName)} || true`,
    `docker start ${quoteShell(plan.oldContainerId)} || true`,
    'exit 1',
  ].join('\n');

  return runDocker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      helperName,
      '--network',
      plan.networkName,
      '-e',
      `DOCKER_HOST=${dockerHost}`,
      '--entrypoint',
      'sh',
      plan.targetImage,
      '-lc',
      script,
    ],
    120_000,
  );
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
