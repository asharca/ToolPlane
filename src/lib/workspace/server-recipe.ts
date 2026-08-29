import { isValidMcpRef, type McpSource } from './custom-mcp';
import {
  hasMcpToolCatalog,
  readMcpToolCatalog,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';

// A directory server's "deploy recipe" — the real package to run when an admin
// has wired one up. Stored on `Server.installCfg`. `env` lists the REQUIRED
// environment-variable NAMES (values are filled in per workspace at deploy
// time, never stored on the directory row).
export type ServerRecipe = {
  source: McpSource;
  ref: string;
  sourceUrl?: string;
  startCommand?: string;
  env: string[];
  // Preset fixed env values baked into the recipe (infra wiring like a
  // self-hosted API URL, or a dummy key a package demands even when unused).
  // These are applied at deploy time and are NOT user secrets.
  envValues?: Record<string, string>;
  network?: 'none';
  transport?: 'streamable-http' | 'sse';
  authType?: 'none' | 'bearer' | 'headers';
  bearerEnv?: string;
  headerEnv?: Record<string, string>;
  toolCatalog?: McpToolDefinition[];
};

const SOURCES: McpSource[] = ['npm', 'pypi', 'github', 'docker', 'remote'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'cookie', 'host',
  'proxy-authorization', 'set-cookie', 'transfer-encoding', 'upgrade',
]);

function parseHeaderEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, envKey] of Object.entries(value as Record<string, unknown>)) {
    if (
      HEADER_NAME.test(name)
      && !FORBIDDEN_HEADERS.has(name.toLowerCase())
      && typeof envKey === 'string'
      && ENV_KEY.test(envKey)
    ) headers[name] = envKey;
  }
  return headers;
}

function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? value.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

// Parse + validate a recipe out of an arbitrary `Server.installCfg` value.
// Returns null when there is no usable recipe (so the server is non-deployable).
export function parseServerRecipe(installCfg: unknown): ServerRecipe | null {
  if (!installCfg || typeof installCfg !== 'object') return null;
  const c = installCfg as Record<string, unknown>;

  const source = c.source;
  if (typeof source !== 'string' || !SOURCES.includes(source as McpSource)) return null;
  const ref = typeof c.ref === 'string' ? c.ref.trim() : '';
  if (!ref || !isValidMcpRef(source as McpSource, ref)) return null;

  const env = Array.isArray(c.env)
    ? c.env.filter((k): k is string => typeof k === 'string' && ENV_KEY.test(k))
    : [];
  const envValues: Record<string, string> = {};
  if (c.envValues && typeof c.envValues === 'object') {
    for (const [k, v] of Object.entries(c.envValues as Record<string, unknown>)) {
      if (ENV_KEY.test(k) && typeof v === 'string') envValues[k] = v;
    }
  }
  const startCommand =
    typeof c.startCommand === 'string' && c.startCommand.trim() ? c.startCommand.trim() : undefined;
  const network = c.network === 'none' ? ('none' as const) : undefined;
  const sourceUrl = safeSourceUrl(c.sourceUrl);
  const toolCatalog = readMcpToolCatalog(c);
  const transport = source === 'remote' && c.transport === 'sse'
    ? ('sse' as const)
    : source === 'remote'
      ? ('streamable-http' as const)
      : undefined;
  const authType = source === 'remote'
    && (c.authType === 'bearer' || c.authType === 'headers')
    ? c.authType
    : source === 'remote'
      ? ('none' as const)
      : undefined;
  const bearerEnv = authType === 'bearer'
    && typeof c.bearerEnv === 'string'
    && ENV_KEY.test(c.bearerEnv)
    ? c.bearerEnv
    : authType === 'bearer'
      ? 'MCP_BEARER_TOKEN'
      : undefined;
  const headerEnv = authType === 'headers' ? parseHeaderEnvironment(c.headerEnv) : {};
  if (authType === 'headers' && Object.keys(headerEnv).length === 0) return null;
  const requiredEnv = [...new Set([
    ...env,
    ...(bearerEnv ? [bearerEnv] : []),
    ...Object.values(headerEnv),
  ])];

  return {
    source: source as McpSource,
    ref,
    env: requiredEnv,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(Object.keys(envValues).length ? { envValues } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(network ? { network } : {}),
    ...(transport ? { transport } : {}),
    ...(authType ? { authType } : {}),
    ...(bearerEnv ? { bearerEnv } : {}),
    ...(Object.keys(headerEnv).length ? { headerEnv } : {}),
    ...(hasMcpToolCatalog(c) ? { toolCatalog } : {}),
  };
}

export type DeploymentRecipeData = {
  source: string;
  sourceRef: string;
  installCfg: {
    env: Record<string, string>;
    requiredEnv?: string[];
    startCommand?: string;
    network?: 'none';
    transport?: 'streamable-http' | 'sse';
    authType?: 'none' | 'bearer' | 'headers';
    bearerEnv?: string;
    headerEnv?: Record<string, string>;
    toolCatalog?: McpToolDefinition[];
  };
};

// Deployment rows linked to a catalog server can always recover their
// requirements from Server.installCfg. Detached clones cannot, so carry only
// the required key names (never values) alongside their runtime config.
export function storedRequiredEnvironment(installCfg: unknown): string[] {
  if (!installCfg || typeof installCfg !== 'object' || Array.isArray(installCfg)) return [];
  const requiredEnv = (installCfg as Record<string, unknown>).requiredEnv;
  if (!Array.isArray(requiredEnv)) return [];
  return [...new Set(requiredEnv.filter((key): key is string => (
    typeof key === 'string' && ENV_KEY.test(key)
  )))];
}

// Return the required recipe keys that still need a usable value in a
// deployment configuration. Catalog variables are deliberately seeded so the
// Variables editor can render them, but an empty seed is never a credential
// and must not be passed to a newly started runtime.
export function missingRequiredEnvironment(
  recipe: Pick<ServerRecipe, 'env'>,
  installCfg: unknown,
): string[] {
  if (!installCfg || typeof installCfg !== 'object' || Array.isArray(installCfg)) {
    return [...recipe.env];
  }
  const rawEnv = (installCfg as Record<string, unknown>).env;
  const env = rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
    ? rawEnv as Record<string, unknown>
    : {};
  return recipe.env.filter((key) => (
    typeof env[key] !== 'string' || !(env[key] as string).trim()
  ));
}

export function missingDeploymentRequiredEnvironment(
  installCfg: unknown,
  serverInstallCfg?: unknown,
): string[] {
  const recipe = parseServerRecipe(serverInstallCfg);
  const env = recipe?.env ?? storedRequiredEnvironment(installCfg);
  return missingRequiredEnvironment({ env }, installCfg);
}

// Turn a recipe into the fields a Deployment row needs. The declared env keys
// are seeded EMPTY so they surface in the workspace's Variables editor. The
// deployment lifecycle checks those required keys before starting a runtime.
export function recipeToDeploymentData(recipe: ServerRecipe): DeploymentRecipeData {
  // Preset values first; then declared keys default to empty (without clobbering
  // a preset of the same name) for the user to fill in the Variables editor.
  const env: Record<string, string> = { ...(recipe.envValues ?? {}) };
  for (const k of recipe.env) if (!(k in env)) env[k] = '';
  const installCfg: DeploymentRecipeData['installCfg'] = {
    env,
    ...(recipe.env.length ? { requiredEnv: [...recipe.env] } : {}),
  };
  if (recipe.startCommand) installCfg.startCommand = recipe.startCommand;
  if (recipe.network === 'none') installCfg.network = 'none';
  if (recipe.source === 'remote') {
    installCfg.transport = recipe.transport ?? 'streamable-http';
    installCfg.authType = recipe.authType ?? 'none';
    if (recipe.bearerEnv) installCfg.bearerEnv = recipe.bearerEnv;
    if (recipe.headerEnv) installCfg.headerEnv = recipe.headerEnv;
  }
  if (recipe.toolCatalog !== undefined) installCfg.toolCatalog = recipe.toolCatalog;
  return { source: recipe.source, sourceRef: recipe.ref, installCfg };
}
