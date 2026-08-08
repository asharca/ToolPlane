import 'server-only';
import { spawn } from 'node:child_process';

const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const MAX_DOCKER_ERROR_BYTES = 64 * 1024;

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const key of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function safeDeploymentIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!normalized) throw new Error('Deployment id is required.');
  return normalized.slice(0, 180);
}

/** Derive the deterministic Docker container name for a bridge deployment. */
export function deploymentContainerName(deploymentId: string): string {
  return `toolplane-mcp-${safeDeploymentIdentifier(deploymentId)}`;
}

function isMissingDockerContainer(error: unknown): boolean {
  return error instanceof Error && /no such (object|container)/i.test(error.message);
}

/**
 * Remove a managed bridge container left behind by an interrupted Docker CLI
 * or a failed startup. The name is generated from a deployment id rather than
 * supplied by the user, and a concurrently removed container is harmless.
 */
export async function removeDeploymentContainer(deploymentId: string): Promise<void> {
  const containerName = deploymentContainerName(deploymentId);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['rm', '-f', containerName], {
      env: dockerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      try { child.kill('SIGKILL'); } catch { /* Docker CLI may already have exited. */ }
      finish(new Error(`Docker runtime container cleanup timed out after ${DOCKER_COMMAND_TIMEOUT_MS}ms.`));
    }, DOCKER_COMMAND_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_DOCKER_ERROR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_DOCKER_ERROR_BYTES - stderr.length);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(
        stderr.trim() || `Docker runtime container cleanup failed (${signal ?? code ?? 'unknown'}).`,
      );
      if (isMissingDockerContainer(error)) {
        finish();
      } else {
        finish(error);
      }
    });
  });
}
