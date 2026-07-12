import 'server-only';
import { randomUUID } from 'node:crypto';
import { buildSpawnSpec, type SpawnSpec } from '@/lib/process/spawn-spec';
import { startProcess, killProcess, livePort, liveStatus } from '@/lib/process/supervisor';
import { mcpRpc } from '@/lib/process/mcp-client';
import type { ServerRecipe } from '@/lib/workspace/server-recipe';

export type ValidateResult =
  | { ok: true; toolCount: number; tools: string[] }
  | { ok: false; error: string };

// The probe spins up a throwaway sandbox container, so first-run cold start
// (image pull + package fetch + MCP handshake) can be slow. The bridge prints
// LISTENING only AFTER its `initialize` handshake succeeds, so a non-null port
// means the MCP is genuinely up.
const POLL_BUDGET_MS = 75_000;
const POLL_INTERVAL_MS = 1_000;
const TOOLS_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Live-test a recipe: run it in an ephemeral sandbox (NOT a DB deployment — the
// supervisor keys by id and ignores the missing row), speak MCP `tools/list`,
// then tear it down. `env` lets the admin supply throwaway values for keys the
// server needs at boot; declared keys default to empty.
export async function validateServerRecipe(
  recipe: ServerRecipe,
  envOverride: Record<string, string> = {},
): Promise<ValidateResult> {
  const env: Record<string, string> = { ...(recipe.envValues ?? {}) };
  for (const k of recipe.env) if (!(k in env)) env[k] = '';
  for (const [k, v] of Object.entries(envOverride)) env[k] = v;

  let spec: SpawnSpec;
  try {
    const { command, args } = buildSpawnSpec(
      recipe.source,
      recipe.ref,
      recipe.startCommand,
      env,
      false,
      recipe.network ?? 'isolated',
    );
    spec = { kind: 'bridge', name: recipe.ref, command, args, env };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bad recipe.' };
  }

  const id = `validate:${randomUUID()}`;
  try {
    await startProcess(id, spec);

    const deadline = Date.now() + POLL_BUDGET_MS;
    let port = livePort(id);
    while (!port && Date.now() < deadline) {
      const st = liveStatus(id);
      if (st === 'error' || st === 'stopped') {
        return {
          ok: false,
          error:
            'The process exited before it was ready. The package/image or command may be wrong, or the server needs an env value at boot. (First run also pulls the image — try again.)',
        };
      }
      await sleep(POLL_INTERVAL_MS);
      port = livePort(id);
    }
    if (!port) {
      return { ok: false, error: 'Timed out starting. First run can take ~1 minute while the image is pulled — try again.' };
    }

    const result = await mcpRpc(id, 'tools/list', undefined, TOOLS_TIMEOUT_MS);
    if (!result) {
      return { ok: false, error: 'Server started but did not answer tools/list as an MCP server.' };
    }
    const tools = Array.isArray(result.tools) ? (result.tools as { name?: string }[]) : [];
    const names = tools.map((t) => t.name).filter((n): n is string => typeof n === 'string');
    return { ok: true, toolCount: names.length, tools: names.slice(0, 50) };
  } finally {
    await killProcess(id, { preventRestart: true });
  }
}
