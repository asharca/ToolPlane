import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

export type McpSource = 'npm' | 'pypi' | 'github' | 'docker';
export type StdioMcpCommand = 'npx' | 'uvx';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 4_000;
const MAX_ARGS_LENGTH = 32_000;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_LENGTH = 16_000;
const MAX_ENV_LENGTH = 64_000;

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
    | { startCommand: string }
    | { command: StdioMcpCommand; args: string[]; env: Record<string, string> }
    | null;
};

function configError(message: string): never {
  throw new Error(`Invalid MCP JSON config: ${message}`);
}

function normalizedCommand(command: unknown): StdioMcpCommand {
  if (typeof command !== 'string' || !command.trim()) configError('command is required.');
  const executable = command.trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.cmd$/, '');
  if (executable === 'npx' || executable === 'uvx') return executable;
  return configError('command must be npx or uvx.');
}

export function parseMcpJsonConfig(raw: string): ParsedCustomMcp {
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

  let entries = Object.entries(document as Record<string, unknown>);
  if (entries.length === 1 && entries[0][0] === 'mcpServers') {
    const wrapped = entries[0][1];
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
      return configError('mcpServers must be an object.');
    }
    entries = Object.entries(wrapped as Record<string, unknown>);
  }
  if (entries.length !== 1) return configError('provide exactly one MCP server.');

  const [rawName, value] = entries[0];
  const name = rawName.trim();
  if (!name || name.length > 80) return configError('the server name must be 1-80 characters.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configError('the server config must be an object.');
  }

  const config = value as Record<string, unknown>;
  const allowedKeys = new Set(['command', 'args', 'env']);
  const unknownKey = Object.keys(config).find((key) => !allowedKeys.has(key));
  if (unknownKey) return configError(`unsupported field: ${unknownKey}.`);

  const command = normalizedCommand(config.command);
  const args = config.args ?? [];
  if (!Array.isArray(args)) return configError('args must be an array of strings.');
  if (!args.length) return configError('args must include the MCP package.');
  if (args.length > MAX_ARGS) return configError(`args cannot contain more than ${MAX_ARGS} values.`);
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_ARG_LENGTH)) {
    return configError(`each arg must be a string no longer than ${MAX_ARG_LENGTH} characters.`);
  }
  if (args.reduce((total, arg) => total + (arg as string).length, 0) > MAX_ARGS_LENGTH) {
    return configError(`args cannot exceed ${MAX_ARGS_LENGTH} characters in total.`);
  }

  const env: Record<string, string> = {};
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
      return configError('env must be an object of string values.');
    }
    const envEntries = Object.entries(config.env as Record<string, unknown>);
    if (envEntries.length > MAX_ENV_VARS) {
      return configError(`env cannot contain more than ${MAX_ENV_VARS} variables.`);
    }
    let envLength = 0;
    for (const [key, value] of envEntries) {
      if (!ENV_KEY.test(key)) return configError(`invalid environment variable name: ${key}.`);
      if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH || value.includes('\0')) {
        return configError(`environment variable ${key} must be a bounded string.`);
      }
      envLength += key.length + value.length;
      env[key] = value;
    }
    if (envLength > MAX_ENV_LENGTH) {
      return configError(`env cannot exceed ${MAX_ENV_LENGTH} characters in total.`);
    }
  }

  return {
    source: 'config',
    ref: command,
    name,
    installCfg: { command, args: args as string[], env },
  };
}

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).source === 'config') {
    const config = (raw as Record<string, unknown>).config;
    if (typeof config !== 'string') return configError('config is required.');
    return parseMcpJsonConfig(config);
  }
  const v = schema.parse(raw);
  const installCfg = v.source === 'docker' && v.startCommand ? { startCommand: v.startCommand } : null;
  return { source: v.source, ref: v.ref, name: v.name, installCfg };
}
