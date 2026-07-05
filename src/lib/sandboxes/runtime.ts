import 'server-only';
import { spawn } from 'node:child_process';

export { DEFAULT_SANDBOX_IMAGE } from './images';

export function sandboxVolumeName(sandboxId: string): string {
  return `toolplane_sandbox_${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function sandboxContainerName(sandboxId: string): string {
  return `toolplane-sandbox-${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

function docker(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

export async function removeDockerSandboxRuntime(sandboxId: string, volumeName?: string | null): Promise<void> {
  await docker(['rm', '-f', sandboxContainerName(sandboxId)]);
  await docker(['volume', 'rm', '-f', volumeName || sandboxVolumeName(sandboxId)]);
}
