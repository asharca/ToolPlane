import 'server-only';
import { randomUUID } from 'node:crypto';
import { resolveSpawnSpec, type SpawnSpec } from '@/lib/process/spawn-spec';
import { startProcess, killProcess, livePort, liveStatus } from '@/lib/process/supervisor';
import { McpPayloadTooLargeError, mcpRpc } from '@/lib/process/mcp-client';
import {
  parseMcpToolCatalogResult,
  redactMcpToolCatalogResult,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';
import { recipeToDeploymentData, type ServerRecipe } from '@/lib/workspace/server-recipe';

export type ValidateResult =
  | { ok: true; toolCount: number; tools: string[]; toolCatalog: McpToolDefinition[] }
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
    const data = recipeToDeploymentData(recipe);
    data.installCfg.env = env;
    spec = resolveSpawnSpec({
      serverId: null,
      name: recipe.ref,
      source: data.source,
      sourceRef: data.sourceRef,
      installCfg: data.installCfg,
    }, true);
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

    let toolCatalog: McpToolDefinition[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let remainingResponseBytes = 4_000_000;
    const toolsDeadline = Date.now() + 30_000;
    for (let page = 0; page < 10; page += 1) {
      const remainingMs = toolsDeadline - Date.now();
      if (remainingMs <= 0) {
        return { ok: false, error: 'Timed out while reading the paginated tool catalog.' };
      }
      let result: Record<string, unknown> | null;
      let responseBytes = 0;
      try {
        result = await mcpRpc(
          id,
          'tools/list',
          cursor ? { cursor } : undefined,
          Math.min(TOOLS_TIMEOUT_MS, remainingMs),
          {
            maxResponseBytes: remainingResponseBytes,
            onResponseBytes: (bytes) => { responseBytes = bytes; },
          },
        );
      } catch (error) {
        if (error instanceof McpPayloadTooLargeError) {
          return { ok: false, error: 'The MCP tool catalog response is too large.' };
        }
        throw error;
      }
      if (!result) {
        if (!page) return { ok: false, error: 'Server started but did not answer tools/list as an MCP server.' };
        return { ok: false, error: 'Server stopped responding while its paginated tool catalog was being read.' };
      }
      remainingResponseBytes -= responseBytes;
      if (!Array.isArray(result.tools) || result.tools.length > 1_000 - toolCatalog.length) {
        return { ok: false, error: 'Server returned an invalid or incomplete MCP tool catalog.' };
      }
      const pageCatalog = redactMcpToolCatalogResult(result.tools, Object.values(env));
      if (!pageCatalog.ok) {
        return { ok: false, error: 'Server returned an invalid or unsafe MCP tool catalog.' };
      }
      const combined = parseMcpToolCatalogResult([
        ...toolCatalog,
        ...pageCatalog.tools,
      ]);
      if (!combined.ok) {
        return { ok: false, error: 'Server returned a duplicate or oversized MCP tool catalog.' };
      }
      toolCatalog = combined.tools;

      if (result.nextCursor === undefined) {
        return {
          ok: true,
          toolCount: toolCatalog.length,
          tools: toolCatalog.map(({ name }) => name).slice(0, 50),
          toolCatalog,
        };
      }
      const nextCursor = result.nextCursor;
      if (
        typeof nextCursor !== 'string'
        || !nextCursor
        || nextCursor.length > 4_000
        || seenCursors.has(nextCursor)
        || page === 9
        || toolCatalog.length >= 1_000
        || remainingResponseBytes <= 0
      ) {
        return { ok: false, error: 'Server returned an incomplete paginated MCP tool catalog.' };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return { ok: false, error: 'Server returned an incomplete paginated MCP tool catalog.' };
  } finally {
    await killProcess(id, { preventRestart: true });
  }
}
