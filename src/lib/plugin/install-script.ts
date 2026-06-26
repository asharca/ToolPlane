import { buildSyncScript } from './sync-script';
import { buildSkillInvocationScript } from './skill-invocation-script';

export const PLUGIN_CLIENTS = ['claude-code', 'claude', 'codex'] as const;
export type PluginClient = (typeof PLUGIN_CLIENTS)[number];

export function resolveClient(raw: string | null | undefined): PluginClient {
  return (PLUGIN_CLIENTS as readonly string[]).includes(raw ?? '')
    ? (raw as PluginClient)
    : 'claude-code';
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

// Emits a `curl … | bash` install script that scaffolds the toolkit as one
// local Claude Code plugin (~/.claude/plugins/mcpmarket-<slug>/) and registers
// it via the `claude` CLI. The plugin carries two live channels: a remote HTTP
// MCP server in .mcp.json (tools auto-sync each session) and a SessionStart
// hook running shared/sync.sh (skills auto-sync each session). File bodies are
// base64-embedded so their contents never have to be shell-escaped.
export function buildPluginInstallScript(opts: InstallScriptOptions): string {
  const { base, workspaceSlug, toolkitSlug, token } = opts;
  const client = resolveClient(opts.client);
  const pluginName = `mcpmarket-${toolkitSlug}`;
  // Claude reads "headers"; Codex reads "http_headers".
  const headerKey = client === 'codex' ? 'http_headers' : 'headers';
  const mcpUrl = `${base}/api/v1/workspaces/${workspaceSlug}/toolkits/${toolkitSlug}/mcp`;

  const marketplaceJson =
    JSON.stringify(
      {
        name: pluginName,
        owner: { name: 'MCPmarket', url: base },
        plugins: [{ name: pluginName, source: './' }],
      },
      null,
      2,
    ) + '\n';

  const pluginJson =
    JSON.stringify(
      {
        name: pluginName,
        version: '0.1.0',
        description: `Auto-syncs the "${toolkitSlug}" toolkit's MCP tools and skills into Claude Code.`,
        skills: './skills/',
        mcpServers: './.mcp.json',
      },
      null,
      2,
    ) + '\n';

  const mcpJson =
    JSON.stringify(
      {
        mcpServers: {
          [pluginName]: { url: mcpUrl, [headerKey]: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2,
    ) + '\n';

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
  echo "MCPmarket install — toolkit ${toolkitSlug} (client: ${client})"
  echo ""

  mkdir -p "$PLUGIN_DIR/.claude-plugin" "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/shared" "$PLUGIN_DIR/skills"
  printf '%s' '${b64(marketplaceJson)}' | base64 -d > "$PLUGIN_DIR/.claude-plugin/marketplace.json"
  printf '%s' '${b64(pluginJson)}' | base64 -d > "$PLUGIN_DIR/.claude-plugin/plugin.json"
  printf '%s' '${b64(mcpJson)}' | base64 -d > "$PLUGIN_DIR/.mcp.json"
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
    echo "    Install Claude Code from https://claude.com/claude-code, then re-run this installer." >&2
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

// `curl … | bash` uninstaller: unregister the plugin from Claude Code and remove
// its directory (which also removes the synced skills). The toolkit's API key is
// revoked server-side when this endpoint is fetched.
export function buildPluginUninstallScript(opts: { toolkitSlug: string }): string {
  const pluginName = `mcpmarket-${opts.toolkitSlug}`;
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$HOME/.claude/plugins/${pluginName}"
echo "MCPmarket uninstall — toolkit ${opts.toolkitSlug}"

if command -v claude >/dev/null 2>&1; then
  claude plugin uninstall ${pluginName}@${pluginName} </dev/null >/dev/null 2>&1 || true
  claude plugin marketplace remove ${pluginName} </dev/null >/dev/null 2>&1 || true
  echo "  ✓ unregistered from Claude Code"
fi

rm -rf "$PLUGIN_DIR"
echo "  ✓ removed $PLUGIN_DIR (plugin + synced skills)"
echo "Done. The toolkit's install API key has been revoked."
`;
}
