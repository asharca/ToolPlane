import { SITE } from '@/lib/site';

type Options = {
  apiBase: string;
  workspaceSlug: string;
  toolkitSlug: string;
  client: string;
};

// The plugin's PostToolUse + PostToolUseFailure hooks (matcher "Skill") run this
// on every skill invocation. It reads the hook-input JSON from stdin, works out
// which skill ran, whether the user or the agent triggered it, and whether it
// succeeded, then fires one fire-and-forget POST to /plugin/skill-invocation.
// Every failure path exits silently (status 0) — hooks fire constantly and a
// noisy hook would spam the user's terminal.
//
// String.raw keeps every backslash literal (the embedded node uses \x1F, \n,
// regex escapes); only the four install-time ${...} values below are
// interpolated, so the emitted bash itself must use plain $VAR — never ${...}.
export function buildSkillInvocationScript({
  apiBase,
  workspaceSlug,
  toolkitSlug,
  client,
}: Options): string {
  return String.raw`#!/usr/bin/env bash
# ${SITE.compactName} skill-invocation telemetry — Claude Code PostToolUse/PostToolUseFailure.
set -eo pipefail

API_BASE="${apiBase}"
WORKSPACE="${workspaceSlug}"
TOOLKIT="${toolkitSlug}"
CLIENT="${client}"

PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
fi

command -v node >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

HOOK_INPUT=$(cat)
[ -n "$HOOK_INPUT" ] || exit 0

# Parse the hook input into \x1F-delimited fields. \x1F (Unit Separator) can't
# occur in a slug or enum and survives empty middle fields, unlike tab (which
# bash 'read' compacts). String values are scrubbed of \t \n \x00 \x1F so a
# forged field can't smuggle extra positional fields.
FIELDS=$(HOOK_JSON="$HOOK_INPUT" node -e '
  const UNSAFE = /[\t\n\x00\x1F]/;
  const clean = (s) => (typeof s === "string" && !UNSAFE.test(s) ? s : "");
  const classify = (raw) => {
    const s = String(raw || "").toLowerCase();
    if (s.includes("not found") || s.includes("unknown skill")) return "not_found";
    if (s.includes("timeout") || s.includes("timed out")) return "timeout";
    if (s) return "runtime_error";
    return "unknown";
  };
  try {
    const h = JSON.parse(process.env.HOOK_JSON);
    const toolName = clean(h.tool_name);
    const ti = h.tool_input || {};
    const skill = clean(ti.skill || ti.name || "");
    const transcript = clean(h.transcript_path || "");
    const trigger = clean(h.invocation_trigger || "");
    let outcome = "success", errorClass = "";
    const resp = h.tool_response;
    const topError = typeof h.error === "string" ? h.error : "";
    if (resp && typeof resp === "object") {
      if (resp.is_error === true || resp.success === false || !!resp.error) {
        outcome = "error";
        errorClass = classify(resp.error || resp.message || resp.content || topError);
      }
    } else if (topError) {
      outcome = "error"; errorClass = classify(topError);
    } else {
      outcome = "error"; errorClass = "unknown";
    }
    process.stdout.write([toolName, skill, transcript, trigger, outcome, errorClass].join("\x1F"));
  } catch { process.exit(1); }
') || exit 0

IFS=$'\x1F' read -r TOOL_NAME SKILL_SLUG TRANSCRIPT_PATH INVOCATION_TRIGGER OUTCOME ERROR_CLASS <<<"$FIELDS"

# Defence in depth: the matcher should already restrict to the Skill tool.
[ "$TOOL_NAME" = "Skill" ] || exit 0
[ -n "$SKILL_SLUG" ] || exit 0
echo "$SKILL_SLUG" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$' || exit 0

# Bearer token from the plugin's .mcp.json (single server entry; Claude uses
# "headers", Codex "http_headers").
MCP_CONFIG="$PLUGIN_ROOT/.mcp.json"
[ -f "$MCP_CONFIG" ] || exit 0
TOKEN=$(MCP_CONFIG_PATH="$MCP_CONFIG" node -e 'try { const cfg = JSON.parse(require("fs").readFileSync(process.env.MCP_CONFIG_PATH, "utf8")); const servers = (cfg && cfg.mcpServers) || {}; const keys = Object.keys(servers); const s = keys.length === 1 ? servers[keys[0]] : {}; const h = s.headers || s.http_headers || {}; process.stdout.write(String(h.Authorization || "").replace(/^Bearer /i, "").trim()); } catch { process.stdout.write(""); }') || exit 0
[ -n "$TOKEN" ] || exit 0

# Source attribution: prefer Claude Code's native invocation_trigger; otherwise
# tail the transcript for a <command-name>$SKILL</command-name> tag in the most
# recent user message (older Claude Code). Only the user|agent bit travels — the
# prompt text is read locally and discarded.
SOURCE="agent"
case "$INVOCATION_TRIGGER" in
  user-slash)
    SOURCE="user"
    ;;
  claude-proactive|nested-skill)
    SOURCE="agent"
    ;;
  *)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      LAST=$(tail -n 50 "$TRANSCRIPT_PATH" 2>/dev/null | TARGET="$SKILL_SLUG" node -e '
        const target = process.env.TARGET;
        const lines = require("fs").readFileSync(0, "utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim(); if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const role = o.role || (o.message && o.message.role) || o.type;
          if (role !== "user") continue;
          const c = o.message ? o.message.content : o.content;
          const t = typeof c === "string" ? c : JSON.stringify(c || "");
          if (t.includes("<command-name>" + target + "</command-name>")) process.stdout.write("user");
          process.exit(0);
        }
      ' 2>/dev/null || true)
      if [ "$LAST" = "user" ]; then SOURCE="user"; fi
    fi
    ;;
esac

# Build the JSON body via node (avoids bash escaping pitfalls). errorClass only
# travels on an error outcome; client only when set.
PAYLOAD=$(WORKSPACE="$WORKSPACE" TOOLKIT="$TOOLKIT" SKILL="$SKILL_SLUG" SRC="$SOURCE" OUT="$OUTCOME" ERR="$ERROR_CLASS" CLIENT="$CLIENT" node -e '
  const b = { workspaceSlug: process.env.WORKSPACE, toolkitSlug: process.env.TOOLKIT, skillSlug: process.env.SKILL, source: process.env.SRC, outcome: process.env.OUT };
  if (process.env.OUT === "error" && process.env.ERR) b.errorClass = process.env.ERR;
  if (process.env.CLIENT) b.client = process.env.CLIENT;
  process.stdout.write(JSON.stringify(b));
') || exit 0

curl -sS --max-time 3 -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$API_BASE/api/v1/plugin/skill-invocation" >/dev/null 2>&1 || true

exit 0
`;
}
