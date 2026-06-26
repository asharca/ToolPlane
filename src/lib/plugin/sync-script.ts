type SyncScriptOptions = {
  apiBase: string;
  workspaceSlug: string;
  toolkitSlug: string;
  client: string;
};

// The plugin's SessionStart hook runs this on every Claude Code session. It
// reads the Bearer token from the plugin's .mcp.json, GETs the toolkit's
// baseline skills, writes each to skills/<slug>/SKILL.md, and prunes skill
// dirs no longer in the toolkit. That re-fetch is the skill "auto-sync".
//
// Telemetry: a successful run POSTs the delta (added/updated/removed/total) to
// /plugin/sync-applied; a failed fetch or unparseable response POSTs a reason
// to /plugin/sync-failure. Both are fire-and-forget and never block the sync.
//
// String.raw keeps backslashes (node regex, "\n") and `$VAR` literal; the only
// ${...} interpolated here are the four install-time values, so the emitted
// bash must avoid any bash ${...} of its own (we use plain $VAR / $(( ))).
export function buildSyncScript({
  apiBase,
  workspaceSlug,
  toolkitSlug,
  client,
}: SyncScriptOptions): string {
  // Note: `set -eo pipefail` WITHOUT `-u` — we read the optional env var
  // $CLAUDE_PLUGIN_ROOT, which `set -u` would treat as an unbound-variable fatal
  // error before the fallback runs. We still keep `-e`/pipefail.
  return String.raw`#!/usr/bin/env bash
# MCPmarket skill sync — runs on Claude Code SessionStart.
set -eo pipefail

API_BASE="${apiBase}"
WORKSPACE="${workspaceSlug}"
TOOLKIT="${toolkitSlug}"
CLIENT="${client}"

PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
fi

command -v node >/dev/null 2>&1 || { echo "MCPmarket sync: node not found — skipping" >&2; exit 0; }
command -v curl >/dev/null 2>&1 || exit 0

MCP_CONFIG="$PLUGIN_ROOT/.mcp.json"
[ -f "$MCP_CONFIG" ] || exit 0

# Bearer token lives in the plugin's .mcp.json (single server entry; Claude
# uses "headers", Codex uses "http_headers" — try both).
TOKEN=$(MCP_CONFIG_PATH="$MCP_CONFIG" node -e 'try { const cfg = JSON.parse(require("fs").readFileSync(process.env.MCP_CONFIG_PATH, "utf8")); const servers = (cfg && cfg.mcpServers) || {}; const keys = Object.keys(servers); const s = keys.length === 1 ? servers[keys[0]] : {}; const h = s.headers || s.http_headers || {}; process.stdout.write(String(h.Authorization || "").replace(/^Bearer /i, "").trim()); } catch { process.stdout.write(""); }') || exit 0
[ -n "$TOKEN" ] || { echo "MCPmarket sync: no token in .mcp.json — skipping" >&2; exit 0; }

# Fire-and-forget telemetry. Both helpers build the JSON body via node to avoid
# bash escaping pitfalls, then POST with a short timeout; a non-2xx never fails
# the sync (the client's cached skills stay valid regardless).
report_failure() {
  REASON="$1"
  BODY=$(WORKSPACE="$WORKSPACE" TOOLKIT="$TOOLKIT" REASON="$REASON" CLIENT="$CLIENT" node -e 'const b={workspaceSlug:process.env.WORKSPACE,toolkitSlug:process.env.TOOLKIT,reason:process.env.REASON};if(process.env.CLIENT)b.client=process.env.CLIENT;process.stdout.write(JSON.stringify(b));') || return 0
  curl -sS --max-time 3 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" "$API_BASE/api/v1/plugin/sync-failure" >/dev/null 2>&1 || true
}
report_applied() {
  BODY=$(WORKSPACE="$WORKSPACE" TOOLKIT="$TOOLKIT" CLIENT="$CLIENT" A="$1" R="$2" U="$3" T="$4" node -e 'const n=(x)=>{const v=parseInt(x,10);return Number.isFinite(v)&&v>=0?v:0;};const b={workspaceSlug:process.env.WORKSPACE,toolkitSlug:process.env.TOOLKIT,added:n(process.env.A),removed:n(process.env.R),updated:n(process.env.U),total:n(process.env.T)};if(process.env.CLIENT)b.client=process.env.CLIENT;process.stdout.write(JSON.stringify(b));') || return 0
  curl -sS --max-time 3 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" "$API_BASE/api/v1/plugin/sync-applied" >/dev/null 2>&1 || true
}

SKILLS_DIR="$PLUGIN_ROOT/skills"
mkdir -p "$SKILLS_DIR"

RESP=$(curl -fsSL --max-time 15 -H "Authorization: Bearer $TOKEN" "$API_BASE/api/v1/plugin/baseline?workspace=$WORKSPACE&toolkit=$TOOLKIT") || { report_failure "fetch_failed"; echo "MCPmarket sync: fetch failed — keeping cached skills" >&2; exit 0; }

# Parse {data:{skills:[{slug,content}]}} into "<slug>|<base64(content)>" lines.
# Slug must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$ (blocks path traversal from
# server data); the field delimiter "|" never appears in a slug or base64.
RECORDS=$(RESP_JSON="$RESP" node -e 'const SLUG = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/; try { const r = JSON.parse(process.env.RESP_JSON); const skills = (r && r.data && r.data.skills) || []; const out = []; for (const s of skills) { if (!s || typeof s.slug !== "string" || !SLUG.test(s.slug)) continue; const b64 = Buffer.from(String(s.content == null ? "" : s.content), "utf8").toString("base64"); out.push(s.slug + "|" + b64); } process.stdout.write(out.join("\n")); } catch { process.exit(1); }') || { report_failure "invalid_response"; echo "MCPmarket sync: invalid response — keeping cached skills" >&2; exit 0; }

SYNCED=" "
COUNT=0
ADDED=0
UPDATED=0
REMOVED=0
if [ -n "$RECORDS" ]; then
  while IFS="|" read -r SLUG CONTENT_B64; do
    [ -n "$SLUG" ] || continue
    if [ -d "$SKILLS_DIR/$SLUG" ]; then
      UPDATED=$((UPDATED + 1))
    else
      ADDED=$((ADDED + 1))
    fi
    mkdir -p "$SKILLS_DIR/$SLUG"
    printf '%s' "$CONTENT_B64" | base64 -d > "$SKILLS_DIR/$SLUG/SKILL.md"
    SYNCED="$SYNCED$SLUG "
    COUNT=$((COUNT + 1))
  done <<RECORDS_EOF
$RECORDS
RECORDS_EOF
fi

# Prune skill dirs no longer in the toolkit baseline (sync owns skills/).
if [ -d "$SKILLS_DIR" ]; then
  for DIR in "$SKILLS_DIR"/*/; do
    [ -d "$DIR" ] || continue
    NAME=$(basename "$DIR")
    case "$SYNCED" in
      *" $NAME "*) ;;
      *) rm -rf "$DIR"; REMOVED=$((REMOVED + 1)) ;;
    esac
  done
fi

report_applied "$ADDED" "$REMOVED" "$UPDATED" "$COUNT"
echo "MCPmarket sync: $COUNT skill(s) synced ($ADDED added, $UPDATED updated, $REMOVED removed)"
`;
}
