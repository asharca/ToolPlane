import { buildSyncScript } from './sync-script';
import { buildSkillInvocationScript } from './skill-invocation-script';
import {
  installClientLabel,
  resolveInstallClient,
  type InstallClient,
} from './clients';
import { SITE } from '@/lib/site';

export type { InstallClient };
export { INSTALL_CLIENTS, installClientLabel } from './clients';

export function resolveClient(raw: string | null | undefined): InstallClient {
  return resolveInstallClient(raw);
}

type InstallScriptOptions = {
  base: string;
  workspaceSlug: string;
  toolkitSlug: string;
  token: string;
  client?: string | null;
};

function b64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function mcpJson(pluginName: string, mcpUrl: string, token: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [pluginName]: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

export function buildToolkitInstallScript(opts: InstallScriptOptions): string {
  const client = resolveClient(opts.client);
  if (client === 'codex') return buildCodexInstallScript(opts);
  if (client === 'hermes') return buildHermesInstallScript(opts);
  if (client === 'opencode') return buildOpenCodeInstallScript(opts);
  return buildPluginInstallScript({ ...opts, client: 'claude-code' });
}

// Emits a `curl … | bash` install script that scaffolds the toolkit as one
// local Claude Code plugin (~/.claude/plugins/toolplane-<slug>/) and registers
// it via the `claude` CLI. The plugin carries two live channels: a remote HTTP
// MCP server in .mcp.json (tools auto-sync each session) and a SessionStart
// hook running shared/sync.sh (skills auto-sync each session). File bodies are
// base64-embedded so their contents never have to be shell-escaped.
export function buildPluginInstallScript(opts: InstallScriptOptions): string {
  const { base, workspaceSlug, toolkitSlug, token } = opts;
  const client = 'claude-code';
  const pluginName = `toolplane-${toolkitSlug}`;
  const mcpUrl = `${base}/api/v1/workspaces/${workspaceSlug}/toolkits/${toolkitSlug}/mcp`;

  const marketplaceJson =
    JSON.stringify(
      {
        name: pluginName,
        owner: { name: SITE.compactName, url: base },
        plugins: [{ name: pluginName, source: './' }],
      },
      null,
      2,
    ) + '\n';

  const pluginJson =
    JSON.stringify(
      {
        name: pluginName,
        version: '0.1.6',
        description: `Auto-syncs the "${toolkitSlug}" toolkit's MCP tools and skills into Claude Code.`,
        skills: './skills/',
        mcpServers: './.mcp.json',
      },
      null,
      2,
    ) + '\n';

  const mcpConfigJson = mcpJson(pluginName, mcpUrl, token);

  // SessionStart syncs skills; PostToolUse/PostToolUseFailure (matcher "Skill")
  // report each skill invocation. Claude Code's matcher filters exclusively, so
  // the telemetry hook only fires for the Skill tool, not every tool call.
  const skillHook = {
    matcher: 'Skill',
    hooks: [
      {
        type: 'command',
        command: 'bash "${CLAUDE_PLUGIN_ROOT}/shared/skill-invocation.sh"',
        timeout: 10,
      },
    ],
  };
  const hooksJson =
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear|compact',
              hooks: [
                {
                  type: 'command',
                  command: 'bash "${CLAUDE_PLUGIN_ROOT}/shared/sync.sh"',
                  timeout: 30,
                },
              ],
            },
          ],
          PostToolUse: [skillHook],
          PostToolUseFailure: [skillHook],
        },
      },
      null,
      2,
    ) + '\n';

  const syncSh = buildSyncScript({ apiBase: base, workspaceSlug, toolkitSlug, client });
  const skillInvocationSh = buildSkillInvocationScript({
    apiBase: base,
    workspaceSlug,
    toolkitSlug,
    client,
  });

  // String.raw: backslashes (e.g. \"…\") stay literal; only the JS values
  // below are interpolated. The bash uses plain $VAR (no bash ${...}).
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

main() {
  PLUGIN_DIR="$HOME/.claude/plugins/${pluginName}"
  echo "${SITE.compactName} install — toolkit ${toolkitSlug} (client: ${client})"
  echo ""

  mkdir -p "$PLUGIN_DIR/.claude-plugin" "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/shared" "$PLUGIN_DIR/skills"
  printf '%s' '${b64(marketplaceJson)}' | base64 -d > "$PLUGIN_DIR/.claude-plugin/marketplace.json"
  printf '%s' '${b64(pluginJson)}' | base64 -d > "$PLUGIN_DIR/.claude-plugin/plugin.json"
  printf '%s' '${b64(mcpConfigJson)}' | base64 -d > "$PLUGIN_DIR/.mcp.json"
  printf '%s' '${b64(hooksJson)}' | base64 -d > "$PLUGIN_DIR/hooks/hooks.json"
  printf '%s' '${b64(syncSh)}' | base64 -d > "$PLUGIN_DIR/shared/sync.sh"
  printf '%s' '${b64(skillInvocationSh)}' | base64 -d > "$PLUGIN_DIR/shared/skill-invocation.sh"
  chmod 755 "$PLUGIN_DIR/shared/sync.sh" "$PLUGIN_DIR/shared/skill-invocation.sh"
  : > "$PLUGIN_DIR/skills/.gitkeep"
  echo "  ✓ plugin scaffold ready at $PLUGIN_DIR"

  # Claude Code does not auto-discover plugins by directory presence — register
  # through the CLI. Hard-fail with manual instructions when it isn't on PATH.
  if ! command -v claude >/dev/null 2>&1; then
    echo "  ✗ claude CLI not found on PATH" >&2
    echo "    Install Claude Code from ${SITE.claudeCodeUrl}, then re-run this installer." >&2
    echo "    Or register manually:" >&2
    echo "      claude plugin marketplace add \"$PLUGIN_DIR\"" >&2
    echo "      claude plugin install ${pluginName}@${pluginName}" >&2
    exit 1
  fi
  if ! claude plugin marketplace add "$PLUGIN_DIR" </dev/null >/dev/null 2>&1; then
    echo "  ✗ 'claude plugin marketplace add' failed" >&2
    exit 1
  fi
  # Refresh the cached copy from disk on re-install (unchanged version reuses cache).
  claude plugin uninstall ${pluginName}@${pluginName} </dev/null >/dev/null 2>&1 || true
  if ! claude plugin install ${pluginName}@${pluginName} </dev/null >/dev/null 2>&1; then
    echo "  ✗ 'claude plugin install' failed" >&2
    exit 1
  fi
  echo "  ✓ registered + enabled via claude CLI"

  echo ""
  echo "Done. Restart Claude Code — it syncs this toolkit's skills on each"
  echo "session start, and the toolkit's MCP tools are available live."
}

main "$@"
`;
}

export function buildCodexInstallScript(opts: InstallScriptOptions): string {
  const { base, workspaceSlug, toolkitSlug, token } = opts;
  const client = 'codex';
  const pluginName = `toolplane-${toolkitSlug}`;
  const mcpUrl = `${base}/api/v1/workspaces/${workspaceSlug}/toolkits/${toolkitSlug}/mcp`;
  const mcpConfigJson = mcpJson(pluginName, mcpUrl, token);
  const syncSh = buildSyncScript({
    apiBase: base,
    workspaceSlug,
    toolkitSlug,
    client,
    defaultSkillsDir: '$HOME/.agents/skills',
    defaultSkillDirPrefix: `${pluginName}-`,
  });

  return String.raw`#!/usr/bin/env bash
set -eo pipefail

main() {
  CODEX_HOME_DIR="$CODEX_HOME"
  if [ -z "$CODEX_HOME_DIR" ]; then
    CODEX_HOME_DIR="$HOME/.codex"
  fi
  BUNDLE_DIR="$CODEX_HOME_DIR/toolplane/${pluginName}"
  CONFIG_PATH="$CODEX_HOME_DIR/config.toml"
  HOOKS_PATH="$CODEX_HOME_DIR/hooks.json"

  echo "${SITE.compactName} install — toolkit ${toolkitSlug} (client: ${installClientLabel('codex')})"
  echo ""

  command -v node >/dev/null 2>&1 || { echo "  ✗ node not found on PATH" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "  ✗ curl not found on PATH" >&2; exit 1; }

  mkdir -p "$BUNDLE_DIR/shared" "$HOME/.agents/skills"
  printf '%s' '${b64(mcpConfigJson)}' | base64 -d > "$BUNDLE_DIR/.mcp.json"
  printf '%s' '${b64(syncSh)}' | base64 -d > "$BUNDLE_DIR/shared/sync.sh"
  chmod 755 "$BUNDLE_DIR/shared/sync.sh"
  echo "  ✓ sync bundle ready at $BUNDLE_DIR"

  mkdir -p "$(dirname "$CONFIG_PATH")"
  CONFIG_PATH="$CONFIG_PATH" SERVER_NAME="${pluginName}" MCP_URL="${mcpUrl}" TOKEN="${token}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.CONFIG_PATH;
const server = process.env.SERVER_NAME;
const url = process.env.MCP_URL;
const token = process.env.TOKEN;
fs.mkdirSync(path.dirname(file), { recursive: true });
let src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const begin = '# BEGIN TOOLPLANE ' + server;
const end = '# END TOOLPLANE ' + server;
const out = [];
let skip = false;
for (const line of src.split(/\r?\n/)) {
  if (line.trim() === begin) {
    skip = true;
    continue;
  }
  if (skip && line.trim() === end) {
    skip = false;
    continue;
  }
  if (!skip) out.push(line);
}
src = out.join('\n').replace(/\s+$/g, '');
const block = [
  begin,
  '[mcp_servers.' + server + ']',
  'url = ' + JSON.stringify(url),
  'http_headers = { Authorization = ' + JSON.stringify('Bearer ' + token) + ' }',
  'enabled = true',
  end,
  '',
].join('\n');
fs.writeFileSync(file, (src ? src + '\n\n' : '') + block);
NODE
  echo "  ✓ Codex MCP server configured in $CONFIG_PATH"

  HOOKS_PATH="$HOOKS_PATH" SYNC_PATH="$BUNDLE_DIR/shared/sync.sh" SERVER_NAME="${pluginName}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.HOOKS_PATH;
const syncPath = process.env.SYNC_PATH;
const server = process.env.SERVER_NAME;
fs.mkdirSync(path.dirname(file), { recursive: true });
let cfg = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch {
      fs.copyFileSync(file, file + '.bak.' + Date.now());
      cfg = {};
    }
  }
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) cfg.hooks = {};
const existing = Array.isArray(cfg.hooks.SessionStart) ? cfg.hooks.SessionStart : [];
function hasSyncHook(group) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook) => hook && typeof hook.command === 'string' && hook.command.includes(syncPath));
}
function shellDouble(s) {
  return '"' + String(s).replace(/(["\\$])/g, '\\$1') + '"';
}
cfg.hooks.SessionStart = existing.filter((group) => !hasSyncHook(group));
cfg.hooks.SessionStart.push({
  matcher: 'startup|resume|clear|compact',
  hooks: [
    {
      type: 'command',
      command: 'bash ' + shellDouble(syncPath),
      timeout: 30,
      statusMessage: 'Syncing ToolPlane toolkit ' + server,
    },
  ],
});
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
NODE
  echo "  ✓ Codex SessionStart sync hook configured in $HOOKS_PATH"

  TOOLPLANE_SYNC_ROOT="$BUNDLE_DIR" bash "$BUNDLE_DIR/shared/sync.sh" || true

  echo ""
  echo "Done. Restart Codex. If prompted, open /hooks and trust the ${SITE.compactName}"
  echo "sync hook. MCP tools are configured in Codex, and skills sync into"
  echo "$HOME/.agents/skills/${pluginName}-*/SKILL.md."
}

main "$@"
`;
}

export function buildOpenCodeInstallScript(opts: InstallScriptOptions): string {
  const { base, workspaceSlug, toolkitSlug, token } = opts;
  const client = 'opencode';
  const pluginName = `toolplane-${toolkitSlug}`;
  const mcpUrl = `${base}/api/v1/workspaces/${workspaceSlug}/toolkits/${toolkitSlug}/mcp`;
  const mcpConfigJson = mcpJson(pluginName, mcpUrl, token);
  const syncSh = buildSyncScript({ apiBase: base, workspaceSlug, toolkitSlug, client });

  return String.raw`#!/usr/bin/env bash
set -eo pipefail

main() {
  CONFIG_DIR="$OPENCODE_CONFIG_DIR"
  if [ -z "$CONFIG_DIR" ]; then
    CONFIG_DIR="$HOME/.config/opencode"
  fi
  CONFIG_PATH="$OPENCODE_CONFIG"
  if [ -z "$CONFIG_PATH" ]; then
    CONFIG_PATH="$CONFIG_DIR/opencode.json"
  fi
  BUNDLE_DIR="$CONFIG_DIR/toolplane/${pluginName}"
  SKILLS_DIR="$BUNDLE_DIR/skills"

  echo "${SITE.compactName} install — toolkit ${toolkitSlug} (client: ${installClientLabel('opencode')})"
  echo ""

  command -v node >/dev/null 2>&1 || { echo "  ✗ node not found on PATH" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "  ✗ curl not found on PATH" >&2; exit 1; }

  mkdir -p "$BUNDLE_DIR/shared" "$SKILLS_DIR" "$(dirname "$CONFIG_PATH")"
  printf '%s' '${b64(mcpConfigJson)}' | base64 -d > "$BUNDLE_DIR/.mcp.json"
  printf '%s' '${b64(syncSh)}' | base64 -d > "$BUNDLE_DIR/shared/sync.sh"
  chmod 755 "$BUNDLE_DIR/shared/sync.sh"
  echo "  ✓ sync bundle ready at $BUNDLE_DIR"

  CONFIG_PATH="$CONFIG_PATH" SERVER_NAME="${pluginName}" MCP_URL="${mcpUrl}" TOKEN="${token}" SKILLS_DIR="$SKILLS_DIR" TOOLKIT="${toolkitSlug}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.CONFIG_PATH;
const server = process.env.SERVER_NAME;
const url = process.env.MCP_URL;
const token = process.env.TOKEN;
const skillsDir = process.env.SKILLS_DIR;
const toolkit = process.env.TOOLKIT;
fs.mkdirSync(path.dirname(file), { recursive: true });
let cfg = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch {
      fs.copyFileSync(file, file + '.bak.' + Date.now());
      cfg = {};
    }
  }
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
if (!cfg.mcp || typeof cfg.mcp !== 'object' || Array.isArray(cfg.mcp)) cfg.mcp = {};
cfg.mcp[server] = {
  type: 'remote',
  url,
  enabled: true,
  oauth: false,
  headers: { Authorization: 'Bearer ' + token },
};
if (!cfg.command || typeof cfg.command !== 'object' || Array.isArray(cfg.command)) cfg.command = {};
cfg.command[server] = {
  description: 'Use ToolPlane toolkit ' + toolkit + ' skills',
  template: [
    'Use the ToolPlane toolkit "' + toolkit + '".',
    'Before answering, inspect the relevant synced SKILL.md files under:',
    skillsDir,
    '',
    'User request:',
    '$ARGUMENTS',
  ].join('\n'),
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
NODE
  echo "  ✓ opencode MCP server + command configured in $CONFIG_PATH"

  TOOLPLANE_SYNC_ROOT="$BUNDLE_DIR" bash "$BUNDLE_DIR/shared/sync.sh" || true

  echo ""
  echo "Done. Restart opencode. MCP tools are configured as ${pluginName}."
  echo "Run /${pluginName} <task> to use the synced toolkit skill cache."
}

main "$@"
`;
}

export function buildHermesInstallScript(opts: InstallScriptOptions): string {
  const { base, workspaceSlug, toolkitSlug, token } = opts;
  const client = 'hermes';
  const pluginName = `toolplane-${toolkitSlug}`;
  const mcpUrl = `${base}/api/v1/workspaces/${workspaceSlug}/toolkits/${toolkitSlug}/mcp`;
  const mcpConfigJson = mcpJson(pluginName, mcpUrl, token);
  const syncSh = buildSyncScript({
    apiBase: base,
    workspaceSlug,
    toolkitSlug,
    client,
    defaultSkillsDir: '${HERMES_HOME:-$HOME/.hermes}/skills/toolplane',
    defaultSkillDirPrefix: `${pluginName}-`,
  });

  return String.raw`#!/usr/bin/env bash
set -eo pipefail

main() {
  HERMES_HOME_DIR="$HERMES_HOME"
  if [ -z "$HERMES_HOME_DIR" ]; then
    HERMES_HOME_DIR="$HOME/.hermes"
  fi
  CONFIG_PATH="$HERMES_CONFIG"
  if [ -z "$CONFIG_PATH" ]; then
    CONFIG_PATH="$HERMES_HOME_DIR/config.yaml"
  fi
  BUNDLE_DIR="$HERMES_HOME_DIR/toolplane/${pluginName}"
  SKILLS_DIR="$HERMES_HOME_DIR/skills/toolplane"
  BUNDLES_DIR="$HERMES_HOME_DIR/skill-bundles"
  BUNDLE_FILE="$BUNDLES_DIR/${pluginName}.yaml"

  echo "${SITE.compactName} install — toolkit ${toolkitSlug} (client: ${installClientLabel('hermes')})"
  echo ""

  command -v node >/dev/null 2>&1 || { echo "  ✗ node not found on PATH" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "  ✗ curl not found on PATH" >&2; exit 1; }

  mkdir -p "$BUNDLE_DIR/shared" "$SKILLS_DIR" "$BUNDLES_DIR" "$(dirname "$CONFIG_PATH")"
  printf '%s' '${b64(mcpConfigJson)}' | base64 -d > "$BUNDLE_DIR/.mcp.json"
  printf '%s' '${b64(syncSh)}' | base64 -d > "$BUNDLE_DIR/shared/sync.sh"
  chmod 755 "$BUNDLE_DIR/shared/sync.sh"
  echo "  ✓ sync bundle ready at $BUNDLE_DIR"

  CONFIG_PATH="$CONFIG_PATH" SERVER_NAME="${pluginName}" MCP_URL="${mcpUrl}" TOKEN="${token}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.CONFIG_PATH;
const server = process.env.SERVER_NAME;
const url = process.env.MCP_URL;
const token = process.env.TOKEN;
fs.mkdirSync(path.dirname(file), { recursive: true });
let src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const begin = '# BEGIN TOOLPLANE ' + server;
const end = '# END TOOLPLANE ' + server;
const withoutOld = [];
let skip = false;
for (const line of src.split(/\r?\n/)) {
  if (line.trim() === begin) {
    skip = true;
    continue;
  }
  if (skip && line.trim() === end) {
    skip = false;
    continue;
  }
  if (!skip) withoutOld.push(line);
}
const lines = withoutOld.join('\n').replace(/\s+$/g, '').split(/\r?\n/);
const entry = [
  '  ' + begin,
  '  ' + server + ':',
  '    url: ' + JSON.stringify(url),
  '    headers:',
  '      Authorization: ' + JSON.stringify('Bearer ' + token),
  '  ' + end,
];
const idx = lines.findIndex((line) => /^mcp_servers:\s*(?:#.*)?$/.test(line));
let out;
if (idx >= 0) {
  out = [...lines.slice(0, idx + 1), ...entry, ...lines.slice(idx + 1)];
} else {
  out = [...(lines.length === 1 && lines[0] === '' ? [] : lines), '', 'mcp_servers:', ...entry];
}
fs.writeFileSync(file, out.join('\n').replace(/^\n+/, '') + '\n');
NODE
  echo "  ✓ Hermes MCP server configured in $CONFIG_PATH"

  TOOLPLANE_SYNC_ROOT="$BUNDLE_DIR" TOOLPLANE_SKILLS_DIR="$SKILLS_DIR" TOOLPLANE_SKILL_DIR_PREFIX="${pluginName}-" bash "$BUNDLE_DIR/shared/sync.sh" || true

  SKILLS_DIR="$SKILLS_DIR" PREFIX="${pluginName}-" BUNDLE_FILE="$BUNDLE_FILE" TOOLKIT="${toolkitSlug}" SERVER_NAME="${pluginName}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const skillsDir = process.env.SKILLS_DIR;
const prefix = process.env.PREFIX;
const bundleFile = process.env.BUNDLE_FILE;
const toolkit = process.env.TOOLKIT;
const server = process.env.SERVER_NAME;
fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
const skills = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => d.name)
      .sort()
  : [];
const q = (value) => JSON.stringify(String(value));
const yaml = [
  'name: ' + server,
  'description: ' + q('ToolPlane toolkit ' + toolkit),
  'skills:',
  ...skills.map((skill) => '  - ' + skill),
  'instruction: |',
  '  Use the ToolPlane toolkit "' + toolkit + '".',
  '  Its MCP tools are available through the "' + server + '" MCP server.',
  '',
].join('\n');
fs.writeFileSync(bundleFile, yaml);
NODE
  echo "  ✓ Hermes skill bundle written to $BUNDLE_FILE"

  if command -v hermes >/dev/null 2>&1; then
    hermes bundles reload >/dev/null 2>&1 || true
    echo "  ✓ asked Hermes to reload skill bundles"
  fi

  echo ""
  echo "Done. In a running Hermes session, run /reload-mcp and /reload-skills."
  echo "Skills are synced under $SKILLS_DIR/${pluginName}-*/SKILL.md."
  echo "Re-run sync later with: bash \"$BUNDLE_DIR/shared/sync.sh\""
}

main "$@"
`;
}

// `curl … | bash` uninstaller: unregister the plugin from Claude Code and remove
// its directory (which also removes the synced skills). The toolkit's API key is
// revoked server-side when this endpoint is fetched.
export function buildPluginUninstallScript(opts: { toolkitSlug: string }): string {
  const pluginName = `toolplane-${opts.toolkitSlug}`;
  return String.raw`#!/usr/bin/env bash
set -eo pipefail

PLUGIN_DIR="$HOME/.claude/plugins/${pluginName}"
CODEX_HOME_DIR="$CODEX_HOME"
if [ -z "$CODEX_HOME_DIR" ]; then
  CODEX_HOME_DIR="$HOME/.codex"
fi
CODEX_BUNDLE_DIR="$CODEX_HOME_DIR/toolplane/${pluginName}"
CODEX_CONFIG_PATH="$CODEX_HOME_DIR/config.toml"
CODEX_HOOKS_PATH="$CODEX_HOME_DIR/hooks.json"
OPENCODE_CONFIG_DIR_VALUE="$OPENCODE_CONFIG_DIR"
if [ -z "$OPENCODE_CONFIG_DIR_VALUE" ]; then
  OPENCODE_CONFIG_DIR_VALUE="$HOME/.config/opencode"
fi
OPENCODE_CONFIG_PATH_VALUE="$OPENCODE_CONFIG"
if [ -z "$OPENCODE_CONFIG_PATH_VALUE" ]; then
  OPENCODE_CONFIG_PATH_VALUE="$OPENCODE_CONFIG_DIR_VALUE/opencode.json"
fi
OPENCODE_BUNDLE_DIR="$OPENCODE_CONFIG_DIR_VALUE/toolplane/${pluginName}"
HERMES_HOME_DIR="$HERMES_HOME"
if [ -z "$HERMES_HOME_DIR" ]; then
  HERMES_HOME_DIR="$HOME/.hermes"
fi
HERMES_CONFIG_PATH="$HERMES_CONFIG"
if [ -z "$HERMES_CONFIG_PATH" ]; then
  HERMES_CONFIG_PATH="$HERMES_HOME_DIR/config.yaml"
fi
HERMES_BUNDLE_DIR="$HERMES_HOME_DIR/toolplane/${pluginName}"
HERMES_SKILLS_DIR="$HERMES_HOME_DIR/skills/toolplane"
HERMES_BUNDLE_FILE="$HERMES_HOME_DIR/skill-bundles/${pluginName}.yaml"

echo "${SITE.compactName} uninstall — toolkit ${opts.toolkitSlug}"

if command -v claude >/dev/null 2>&1; then
  claude plugin uninstall ${pluginName}@${pluginName} </dev/null >/dev/null 2>&1 || true
  claude plugin marketplace remove ${pluginName} </dev/null >/dev/null 2>&1 || true
  echo "  ✓ unregistered from Claude Code"
fi

if command -v node >/dev/null 2>&1; then
  CODEX_CONFIG_PATH="$CODEX_CONFIG_PATH" CODEX_HOOKS_PATH="$CODEX_HOOKS_PATH" SYNC_PATH="$CODEX_BUNDLE_DIR/shared/sync.sh" SERVER_NAME="${pluginName}" SKILLS_DIR="$HOME/.agents/skills" PREFIX="${pluginName}-" OPENCODE_CONFIG_PATH="$OPENCODE_CONFIG_PATH_VALUE" HERMES_CONFIG_PATH="$HERMES_CONFIG_PATH" HERMES_SKILLS_DIR="$HERMES_SKILLS_DIR" HERMES_BUNDLE_FILE="$HERMES_BUNDLE_FILE" node <<'NODE'
const fs = require('fs');
const path = require('path');
const server = process.env.SERVER_NAME;

function removeCodexMcpBlock(file) {
  if (!fs.existsSync(file)) return;
  const begin = '# BEGIN TOOLPLANE ' + server;
  const end = '# END TOOLPLANE ' + server;
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let skip = false;
  for (const line of src.split(/\r?\n/)) {
    if (line.trim() === begin) {
      skip = true;
      continue;
    }
    if (skip && line.trim() === end) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  fs.writeFileSync(file, out.join('\n').replace(/\s+$/g, '') + '\n');
}

function removeCodexHook(file, syncPath) {
  if (!fs.existsSync(file)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!cfg || !cfg.hooks || !Array.isArray(cfg.hooks.SessionStart)) return;
  cfg.hooks.SessionStart = cfg.hooks.SessionStart.filter((group) => {
    if (!group || !Array.isArray(group.hooks)) return true;
    return !group.hooks.some((hook) => hook && typeof hook.command === 'string' && hook.command.includes(syncPath));
  });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

function removePrefixedSkills(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function removeOpenCodeConfig(file) {
  if (!fs.existsSync(file)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (cfg && cfg.mcp && typeof cfg.mcp === 'object') delete cfg.mcp[server];
  if (cfg && cfg.command && typeof cfg.command === 'object') delete cfg.command[server];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

function removeMarkerBlock(file) {
  if (!fs.existsSync(file)) return;
  const begin = '# BEGIN TOOLPLANE ' + server;
  const end = '# END TOOLPLANE ' + server;
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let skip = false;
  for (const line of src.split(/\r?\n/)) {
    if (line.trim() === begin) {
      skip = true;
      continue;
    }
    if (skip && line.trim() === end) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  fs.writeFileSync(file, out.join('\n').replace(/\s+$/g, '') + '\n');
}

removeCodexMcpBlock(process.env.CODEX_CONFIG_PATH);
removeCodexHook(process.env.CODEX_HOOKS_PATH, process.env.SYNC_PATH);
removePrefixedSkills(process.env.SKILLS_DIR, process.env.PREFIX);
removeOpenCodeConfig(process.env.OPENCODE_CONFIG_PATH);
removeMarkerBlock(process.env.HERMES_CONFIG_PATH);
removePrefixedSkills(process.env.HERMES_SKILLS_DIR, process.env.PREFIX);
if (process.env.HERMES_BUNDLE_FILE) fs.rmSync(process.env.HERMES_BUNDLE_FILE, { force: true });
NODE
  echo "  ✓ removed Codex/opencode/Hermes config entries where present"
fi

rm -rf "$PLUGIN_DIR"
rm -rf "$CODEX_BUNDLE_DIR" "$OPENCODE_BUNDLE_DIR" "$HERMES_BUNDLE_DIR"
echo "  ✓ removed managed local bundles"
echo "Done. The toolkit's install API key has been revoked."
`;
}
