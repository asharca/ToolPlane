import 'server-only';
import { spawn } from 'node:child_process';
import { sandboxContainerName, sandboxVolumeName } from '@/lib/process/sandbox';

export { DEFAULT_SANDBOX_IMAGE } from './images';
export { sandboxContainerName, sandboxVolumeName };

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
