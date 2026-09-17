import { SYNC_CLIENT_SOURCE } from './sync-client';
import { installationName } from './installation-identity';

type SyncScriptOptions = {
  apiBase: string;
  workspaceSlug: string;
  toolkitSlug: string;
  client: string;
  installation?: string;
  workspaceId?: string;
  toolkitId?: string;
  defaultSkillsDir?: string;
  defaultSkillDirPrefix?: string;
};

export function buildSyncScript(opts: SyncScriptOptions): string {
  const installation = opts.installation ?? installationName({ ...opts, base: opts.apiBase });
  const config = Buffer.from(JSON.stringify({ ...opts, installation })).toString('base64');
  return String.raw`#!/usr/bin/env bash
# ToolPlane sync: a failed refresh keeps the last successfully committed version.
set -eo pipefail
umask 077
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PLUGIN_ROOT="$TOOLPLANE_SYNC_ROOT"
if [ -z "$PLUGIN_ROOT" ]; then PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"; fi
if [ -z "$PLUGIN_ROOT" ]; then PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd); fi
MCP_CONFIG="$TOOLPLANE_MCP_CONFIG"
if [ -z "$MCP_CONFIG" ]; then MCP_CONFIG="$PLUGIN_ROOT/.mcp.json"; fi
command -v node >/dev/null 2>&1 || { echo 'ToolPlane sync: Node is required' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'ToolPlane sync: curl is required' >&2; exit 1; }
TOKEN=$(MCP_CONFIG_PATH="$MCP_CONFIG" node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH,"utf8")); const servers=Object.values(cfg.mcpServers||{}); if(servers.length!==1)process.exit(1); const h=servers[0].headers||servers[0].http_headers||{}; const token=String(h.Authorization||"").replace(/^Bearer /i,"").trim(); if(!token)process.exit(1); process.stdout.write(token);')
SKILLS_DIR="$TOOLPLANE_SKILLS_DIR"
if [ -z "$SKILLS_DIR" ]; then SKILLS_DIR="${opts.defaultSkillsDir ?? '$PLUGIN_ROOT/skills'}"; fi
SKILL_DIR_PREFIX="$TOOLPLANE_SKILL_DIR_PREFIX"
if [ -z "$SKILL_DIR_PREFIX" ]; then SKILL_DIR_PREFIX="${opts.defaultSkillDirPrefix ?? ''}"; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '%s' '${config}' | base64 -d > "$TMP/config.json"
API_BASE="${opts.apiBase}"
WORKSPACE="${opts.workspaceSlug}"
TOOLKIT="${opts.toolkitSlug}"
CLIENT="${opts.client}"
# A response travels through a bounded file, never a process environment variable.
if ! curl -fsSL --max-time 30 --max-filesize 33554432 -H "Authorization: Bearer $TOKEN" "$API_BASE/api/v1/plugin/baseline?workspace=$WORKSPACE&toolkit=$TOOLKIT" > "$TMP/response.json"; then
  printf '{}' > "$TMP/response.json"
  echo 'ToolPlane sync: fetch failed; retaining last known good skills' >&2
fi
set +e
COUNTS=$(node - "$TMP/config.json" "$TMP/response.json" "$SKILLS_DIR" "$SKILL_DIR_PREFIX" <<'NODE'
${SYNC_CLIENT_SOURCE}
NODE
)
RESULT=$?
set -e
if [ "$RESULT" -ne 0 ]; then
  BODY=$(WORKSPACE="$WORKSPACE" TOOLKIT="$TOOLKIT" CLIENT="$CLIENT" node -e 'process.stdout.write(JSON.stringify({workspaceSlug:process.env.WORKSPACE,toolkitSlug:process.env.TOOLKIT,client:process.env.CLIENT,reason:"sync_failed"}))')
  curl -sS --max-time 3 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" "$API_BASE/api/v1/plugin/sync-failure" >/dev/null 2>&1 || true
  exit "$RESULT"
fi
BODY=$(COUNTS="$COUNTS" WORKSPACE="$WORKSPACE" TOOLKIT="$TOOLKIT" CLIENT="$CLIENT" node -e 'process.stdout.write(JSON.stringify({...JSON.parse(process.env.COUNTS),workspaceSlug:process.env.WORKSPACE,toolkitSlug:process.env.TOOLKIT,client:process.env.CLIENT}))')
curl -sS --max-time 3 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" "$API_BASE/api/v1/plugin/sync-applied" >/dev/null 2>&1 || true
echo "ToolPlane sync committed: $COUNTS"
`;
}
