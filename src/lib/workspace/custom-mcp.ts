import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

export type McpSource = 'npm' | 'pypi' | 'github' | 'docker';
export type StdioMcpCommand = 'npx' | 'uvx';
export const EDITABLE_MCP_SOURCES = ['npm', 'pypi', 'github', 'docker', 'config'] as const;
export type EditableMcpSource = (typeof EDITABLE_MCP_SOURCES)[number];

export function isEditableMcpSource(source: string | null): source is EditableMcpSource {
  return EDITABLE_MCP_SOURCES.includes(source as EditableMcpSource);
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 4_000;
const MAX_ARGS_LENGTH = 32_000;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_LENGTH = 16_000;
const MAX_ENV_LENGTH = 64_000;
const MASKED_SECRET = '********';

const OPTIONS_WITH_VALUE: Record<StdioMcpCommand, ReadonlySet<string>> = {
  npx: new Set([
    '-c',
    '-p',
    '--cache',
    '--call',
    '--node-options',
    '--npm',
    '--package',
    '--registry',
    '--userconfig',
  ]),
  uvx: new Set([
    '--config-file',
    '--default-index',
    '--directory',
    '--extra-index-url',
    '--find-links',
    '--fork-strategy',
    '--from',
    '--index',
    '--index-url',
    '--keyring-provider',
    '--link-mode',
    '--prerelease',
    '--project',
    '--python',
    '--python-downloads',
    '--python-preference',
    '--refresh-package',
    '--resolution',
    '--with',
    '--with-editable',
  ]),
};

const SENSITIVE_VALUE_ARG = /^(?:-H|--?(?:default-index|extra-index-url|header|headers|index-url|registry))$/i;
const CREDENTIAL_URL = /:\/\/[^/@\s]+@/;
const URL_WITH_QUERY = /^https?:\/\/\S+\?\S+/i;
const AUTHORIZATION_VALUE = /^(?:authorization\s*:\s*)?(?:basic|bearer)\s+\S+/i;

function isSensitiveArgName(value: string): boolean {
  const name = value.replace(/^-+/, '').toLowerCase();
  return /auth|credential|pass(?:word|wd)?|secret|token|(?:api|private|access)[-_]?key|key[-_]?id|(?:^|[-_])pat(?:$|[-_])/.test(name);
}

type StdioMcpInstallConfig = {
  command: StdioMcpCommand;
  args: string[];
  env: Record<string, string>;
  network?: 'none';
};

type PackageMcpInstallConfig = {
  env: Record<string, string>;
  startCommand?: string;
  network?: 'none';
};

export type ParsedMcpDeploymentConfig = {
  source: EditableMcpSource;
  ref: string;
  installCfg: StdioMcpInstallConfig | PackageMcpInstallConfig;
};

// Shared reference validator for a given source — reused by both the custom-MCP
// deploy form and the admin server-recipe parser so the rules can't drift.
export function isValidMcpRef(source: McpSource, ref: string): boolean {
  return source === 'npm' ? NPM_NAME.test(ref)
    : source === 'pypi' ? PYPI_NAME.test(ref)
    : source === 'github' ? GITHUB_URL.test(ref)
    : DOCKER_IMAGE.test(ref);
}

const schema = z
  .object({
    source: z.enum(['npm', 'pypi', 'github', 'docker']),
    ref: z.string().trim().min(1),
    name: z.string().trim().min(1, 'name is required').max(80),
    startCommand: z.string().trim().default(''),
    network: z.enum(['isolated', 'none']).default('isolated'),
  })
  .superRefine((v, ctx) => {
    if (!isValidMcpRef(v.source, v.ref))
      ctx.addIssue({ code: 'custom', path: ['ref'], message: `invalid ${v.source} reference` });
  });

export type ParsedCustomMcp = {
  source: McpSource | 'config';
  ref: string;
  name: string;
  installCfg:
    | PackageMcpInstallConfig
    | StdioMcpInstallConfig
    | null;
};

function serializedEnv(value: unknown, maskSecrets: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return env;
  for (const [key, envValue] of Object.entries(value as Record<string, unknown>)) {
    if (ENV_KEY.test(key) && typeof envValue === 'string') {
      env[key] = maskSecrets && envValue ? MASKED_SECRET : envValue;
    }
  }
  return env;
}

function serializedArgs(value: unknown, maskSecrets: boolean): string[] {
  const args = Array.isArray(value)
    ? value.filter((arg): arg is string => typeof arg === 'string')
    : [];
  if (!maskSecrets) return args;
  const masked = [...args];
  for (let index = 0; index < masked.length; index += 1) {
    const [flag, assigned] = masked[index].split('=', 2);
    const namedArgument = flag.startsWith('-')
      || (assigned !== undefined && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(flag));
    if ((namedArgument && isSensitiveArgName(flag)) || SENSITIVE_VALUE_ARG.test(flag)) {
      if (assigned !== undefined) masked[index] = `${flag}=${MASKED_SECRET}`;
      else if (masked[index + 1]) masked[index + 1] = MASKED_SECRET;
      continue;
    }
    if (assigned !== undefined
      && (CREDENTIAL_URL.test(assigned)
        || URL_WITH_QUERY.test(assigned)
        || AUTHORIZATION_VALUE.test(assigned))) {
      masked[index] = `${flag}=${MASKED_SECRET}`;
      continue;
    }
    if (CREDENTIAL_URL.test(masked[index])
      || URL_WITH_QUERY.test(masked[index])
      || AUTHORIZATION_VALUE.test(masked[index])) {
      masked[index] = MASKED_SECRET;
    }
  }
  return masked;
}

export function serializeMcpJsonConfig(
  installCfg: unknown,
  options: { maskSecrets?: boolean } = {},
): string {
  const stored = (installCfg ?? {}) as {
    command?: unknown;
    args?: unknown;
    env?: unknown;
    network?: unknown;
  };
  const command = stored.command === 'uvx' ? 'uvx' : 'npx';
  const args = serializedArgs(stored.args, Boolean(options.maskSecrets));
  const env = serializedEnv(stored.env, Boolean(options.maskSecrets));
  return JSON.stringify({
    command,
    args,
    ...(Object.keys(env).length ? { env } : {}),
  }, null, 2);
}

export function serializeMcpDeploymentConfig(
  deployment: { source: string | null; sourceRef: string | null; installCfg: unknown },
  options: { maskSecrets?: boolean } = {},
): string {
  if (deployment.source === 'config') {
    return serializeMcpJsonConfig(deployment.installCfg, options);
  }
  if (!isEditableMcpSource(deployment.source)) {
    throw new Error(`Unsupported editable MCP source: ${deployment.source ?? '(none)'}`);
  }

  const stored = (deployment.installCfg ?? {}) as {
    env?: unknown;
    startCommand?: unknown;
    network?: unknown;
  };
  const env = serializedEnv(stored.env, Boolean(options.maskSecrets));
  const rawStartCommand = typeof stored.startCommand === 'string' ? stored.startCommand : '';
  const startCommand = options.maskSecrets && rawStartCommand ? MASKED_SECRET : rawStartCommand;

  return JSON.stringify({
    source: deployment.source,
    ref: deployment.sourceRef ?? '',
    ...(deployment.source === 'docker' && startCommand ? { startCommand } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  }, null, 2);
}

function configError(message: string): never {
  throw new Error(`Invalid MCP JSON config: ${message}`);
}

function parsedArgs(value: unknown, required: boolean): string[] {
  const args = value ?? [];
  if (!Array.isArray(args)) return configError('args must be an array of strings.');
  if (required && !args.length) return configError('args must include the MCP package.');
  if (args.length > MAX_ARGS) return configError(`args cannot contain more than ${MAX_ARGS} values.`);
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_ARG_LENGTH)) {
    return configError(`each arg must be a string no longer than ${MAX_ARG_LENGTH} characters.`);
  }
  if (args.reduce((total, arg) => total + (arg as string).length, 0) > MAX_ARGS_LENGTH) {
    return configError(`args cannot exceed ${MAX_ARGS_LENGTH} characters in total.`);
  }
  return args as string[];
}

function parsedEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configError('env must be an object of string values.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) {
    return configError(`env cannot contain more than ${MAX_ENV_VARS} variables.`);
  }
  const env: Record<string, string> = {};
  let envLength = 0;
  for (const [key, envValue] of entries) {
    if (!ENV_KEY.test(key)) return configError(`invalid environment variable name: ${key}.`);
    if (typeof envValue !== 'string' || envValue.length > MAX_ENV_VALUE_LENGTH || envValue.includes('\0')) {
      return configError(`environment variable ${key} must be a bounded string.`);
    }
    envLength += key.length + envValue.length;
    env[key] = envValue;
  }
  if (envLength > MAX_ENV_LENGTH) {
    return configError(`env cannot exceed ${MAX_ENV_LENGTH} characters in total.`);
  }
  return env;
}

function parsedNetwork(value: unknown): 'none' | undefined {
  if (value === undefined || value === 'isolated') return undefined;
  if (value === 'none') return 'none';
  return configError('network must be isolated or none.');
}

function withNetworkMode<T extends Record<string, unknown>>(
  installCfg: T,
  value: unknown,
): T & { network?: 'none' } {
  const network = parsedNetwork(value);
  const next = { ...installCfg } as T & { network?: 'none' };
  if (network === 'none') next.network = 'none';
  else delete next.network;
  return next;
}

function normalizedCommand(command: unknown): StdioMcpCommand {
  if (typeof command !== 'string' || !command.trim()) configError('command is required.');
  const executable = command.trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.cmd$/, '');
  if (executable === 'npx' || executable === 'uvx') return executable;
  return configError('command must be npx or uvx.');
}

function packageNameFromArg(command: StdioMcpCommand, arg: string): string | null {
  if (!arg || arg.includes('://') || arg.includes('\\') || arg.includes('\0')) return null;
  if (command === 'npx') {
    let packageRef = arg;
    if (packageRef.startsWith('@')) {
      const slash = packageRef.indexOf('/');
      const versionAt = slash >= 0 ? packageRef.indexOf('@', slash + 1) : -1;
      if (versionAt >= 0) packageRef = packageRef.slice(0, versionAt);
    } else {
      const versionAt = packageRef.lastIndexOf('@');
      if (versionAt > 0) packageRef = packageRef.slice(0, versionAt);
    }
    if (!NPM_NAME.test(packageRef)) return null;
    const name = packageRef.split('/').pop() ?? '';
    return /[A-Za-z]/.test(name) ? name : null;
  }

  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[A-Za-z0-9_,.-]+\])?(?:[<>=!~].*)?$/.exec(arg);
  const name = match?.[1] ?? '';
  return PYPI_NAME.test(name) && /[A-Za-z]/.test(name) ? name : null;
}

function inferredConfigName(command: StdioMcpCommand, args: string[]): string {
  let optionsEnded = false;
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      const flag = arg.split('=', 1)[0];
      skipNext = !arg.includes('=') && OPTIONS_WITH_VALUE[command].has(flag);
      continue;
    }
    const name = packageNameFromArg(command, arg);
    if (name) return name.slice(0, 80);
  }
  return 'mcp-server';
}

export function parseMcpJsonConfig(raw: string, fallbackName?: string): ParsedCustomMcp {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    try {
      // MCP clients often show/copy one entry from inside `mcpServers` without
      // the surrounding braces. Accept that fragment as a single object entry.
      document = JSON.parse(`{${raw}}`);
    } catch {
      return configError('enter valid JSON.');
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return configError('the top level must be an object.');
  }

  const root = document as Record<string, unknown>;
  let explicitName = '';
  let config: Record<string, unknown>;
  const rootEntries = Object.entries(root);
  const isNamedSingleEntry = rootEntries.length === 1
    && rootEntries[0][1] !== null
    && typeof rootEntries[0][1] === 'object'
    && !Array.isArray(rootEntries[0][1]);
  if (!isNamedSingleEntry && ('command' in root || 'args' in root || 'env' in root)) {
    config = root;
  } else {
    let entries = rootEntries;
    if (entries.length === 1 && entries[0][0] === 'mcpServers') {
      const wrapped = entries[0][1];
      if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
        return configError('mcpServers must be an object.');
      }
      entries = Object.entries(wrapped as Record<string, unknown>);
    }
    if (entries.length !== 1) return configError('provide exactly one MCP server.');
    const [rawName, value] = entries[0];
    explicitName = rawName.trim();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return configError('the server config must be an object.');
    }
    config = value as Record<string, unknown>;
  }

  const allowedKeys = new Set(['command', 'args', 'env', 'network']);
  const unknownKey = Object.keys(config).find((key) => !allowedKeys.has(key));
  if (unknownKey) return configError(`unsupported field: ${unknownKey}.`);

  const command = normalizedCommand(config.command);
  const args = parsedArgs(config.args, true);
  const env = parsedEnv(config.env);
  const network = parsedNetwork(config.network);

  const name = explicitName || fallbackName?.trim() || inferredConfigName(command, args as string[]);
  if (!name || name.length > 80) return configError('the server name must be 1-80 characters.');

  return {
    source: 'config',
    ref: command,
    name,
    installCfg: { command, args, env, ...(network ? { network } : {}) },
  };
}

export function parseMcpDeploymentConfig(
  raw: string,
  expectedSource: EditableMcpSource,
  fallbackName?: string,
  networkOverride?: unknown,
): ParsedMcpDeploymentConfig {
  if (expectedSource === 'config') {
    const parsed = parseMcpJsonConfig(raw, fallbackName);
    if (!parsed.installCfg || !('command' in parsed.installCfg)) {
      return configError('the command configuration is invalid.');
    }
    return {
      source: 'config',
      ref: parsed.ref,
      installCfg: networkOverride === undefined
        ? parsed.installCfg
        : withNetworkMode(parsed.installCfg, networkOverride),
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return configError('enter valid JSON.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return configError('the top level must be an object.');
  }
  const config = document as Record<string, unknown>;
  const allowedKeys = new Set(['source', 'ref', 'startCommand', 'env', 'network']);
  const unknownKey = Object.keys(config).find((key) => !allowedKeys.has(key));
  if (unknownKey) return configError(`unsupported field: ${unknownKey}.`);
  if (config.source !== expectedSource) {
    return configError(`source must remain ${expectedSource}.`);
  }
  const ref = typeof config.ref === 'string' ? config.ref.trim() : '';
  if (!ref || ref.length > MAX_ARG_LENGTH || !isValidMcpRef(expectedSource, ref)) {
    return configError(`invalid ${expectedSource} reference.`);
  }

  const env = parsedEnv(config.env);
  const network = parsedNetwork(networkOverride === undefined ? config.network : networkOverride);
  let startCommand: string | undefined;
  if (config.startCommand !== undefined) {
    if (expectedSource !== 'docker') {
      return configError('startCommand is only supported for docker sources.');
    }
    if (typeof config.startCommand !== 'string'
      || config.startCommand.includes('\0')
      || config.startCommand.length > MAX_ARGS_LENGTH) {
      return configError(`startCommand must be a string no longer than ${MAX_ARGS_LENGTH} characters.`);
    }
    startCommand = config.startCommand.trim() || undefined;
  }

  return {
    source: expectedSource,
    ref,
    installCfg: {
      env,
      ...(startCommand ? { startCommand } : {}),
      ...(network ? { network } : {}),
    },
  };
}

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).source === 'config') {
    const input = raw as Record<string, unknown>;
    const config = input.config;
    if (typeof config !== 'string') return configError('config is required.');
    const parsed = parseMcpJsonConfig(config);
    // Older callers may omit this field and keep the value declared in JSON.
    // The create form always submits it, making the visible selector authoritative.
    if (input.network === undefined) return parsed;
    if (!parsed.installCfg || !('command' in parsed.installCfg)) {
      return configError('the command configuration is invalid.');
    }
    return { ...parsed, installCfg: withNetworkMode(parsed.installCfg, input.network) };
  }
  const v = schema.parse(raw);
  const installCfg = v.source === 'docker' && v.startCommand || v.network === 'none'
    ? {
        env: {},
        ...(v.source === 'docker' && v.startCommand ? { startCommand: v.startCommand } : {}),
        ...(v.network === 'none' ? { network: 'none' as const } : {}),
      }
    : null;
  return { source: v.source, ref: v.ref, name: v.name, installCfg };
}
