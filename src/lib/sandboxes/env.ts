import type { Prisma } from '@prisma/client';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_BYTES = 8192;
const MAX_ENV_TOTAL_BYTES = 64 * 1024;

export type SandboxEnv = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function readSandboxEnv(config: unknown): SandboxEnv {
  if (!isRecord(config) || !isRecord(config.env)) return {};
  const env: SandboxEnv = {};
  for (const [key, value] of Object.entries(config.env)) {
    if (ENV_KEY_RE.test(key) && typeof value === 'string') env[key] = value;
  }
  return env;
}

export function sandboxEnvToText(env: SandboxEnv): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function parseSandboxEnvText(input: FormDataEntryValue | string | null): SandboxEnv {
  const env: SandboxEnv = {};
  let totalBytes = 0;

  for (const rawLine of String(input ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) throw new Error(`Invalid environment variable line: ${line}`);

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1);
    if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`);

    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) {
      throw new Error(`Environment variable ${key} is too large.`);
    }
    if (totalBytes > MAX_ENV_TOTAL_BYTES) {
      throw new Error('Environment variables are too large.');
    }

    env[key] = value;
    if (Object.keys(env).length > MAX_ENV_VARS) {
      throw new Error(`Too many environment variables; max ${MAX_ENV_VARS}.`);
    }
  }

  return env;
}

export function sandboxConfigWithEnv(config: unknown, env: SandboxEnv): Prisma.InputJsonValue | undefined {
  const base = isRecord(config) ? { ...config } : {};
  if (Object.keys(env).length) {
    base.env = env;
  } else {
    delete base.env;
  }
  return Object.keys(base).length ? (base as Prisma.InputJsonValue) : undefined;
}
