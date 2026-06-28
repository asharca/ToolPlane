import { isValidMcpRef, type McpSource } from './custom-mcp';

// A directory server's "deploy recipe" — the real package to run when an admin
// has wired one up. Stored on `Server.installCfg`. `env` lists the REQUIRED
// environment-variable NAMES (values are filled in per workspace at deploy
// time, never stored on the directory row).
export type ServerRecipe = {
  source: McpSource;
  ref: string;
  startCommand?: string;
  env: string[];
  network?: 'none';
};

const SOURCES: McpSource[] = ['npm', 'pypi', 'github', 'docker'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const startCommand =
    typeof c.startCommand === 'string' && c.startCommand.trim() ? c.startCommand.trim() : undefined;
  const network = c.network === 'none' ? ('none' as const) : undefined;

  return { source: source as McpSource, ref, env, ...(startCommand ? { startCommand } : {}), ...(network ? { network } : {}) };
}

export type DeploymentRecipeData = {
  source: string;
  sourceRef: string;
  installCfg: { env: Record<string, string>; startCommand?: string; network?: 'none' };
};

// Turn a recipe into the fields a Deployment row needs. The declared env keys
// are seeded EMPTY so they surface in the workspace's Variables editor for the
// user to fill, then Rebuild.
export function recipeToDeploymentData(recipe: ServerRecipe): DeploymentRecipeData {
  const env: Record<string, string> = {};
  for (const k of recipe.env) env[k] = '';
  const installCfg: DeploymentRecipeData['installCfg'] = { env };
  if (recipe.startCommand) installCfg.startCommand = recipe.startCommand;
  if (recipe.network === 'none') installCfg.network = 'none';
  return { source: recipe.source, sourceRef: recipe.ref, installCfg };
}
