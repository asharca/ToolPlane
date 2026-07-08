import { describe, it, expect } from 'vitest';
import {
  buildToolkitInstallScript,
  buildPluginInstallScript,
  buildPluginUninstallScript,
  resolveClient,
} from '@/lib/plugin/install-script';
import { buildSyncScript } from '@/lib/plugin/sync-script';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull a base64-embedded file body back out of the generated install script.
function decodeFile(script: string, relPath: string, rootVar = 'PLUGIN_DIR'): string {
  const re = new RegExp(
    `printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d > "\\$${rootVar}/${escapeRe(relPath)}"`,
  );
  const m = re.exec(script);
  if (!m) throw new Error(`no embedded file at ${relPath}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

const BASE = 'http://localhost:3000';

describe('resolveClient', () => {
  it('accepts supported auto-sync clients and falls back to Claude Code', () => {
    expect(resolveClient('claude-code')).toBe('claude-code');
    expect(resolveClient('codex')).toBe('codex');
    expect(resolveClient('hermes')).toBe('hermes');
    expect(resolveClient('opencode')).toBe('opencode');
    expect(resolveClient('bogus')).toBe('claude-code');
    expect(resolveClient(null)).toBe('claude-code');
  });
});

describe('buildPluginInstallScript', () => {
  const script = buildPluginInstallScript({
    base: BASE,
    workspaceSlug: 'ws',
    toolkitSlug: 'tk',
    token: 'sk_user_TESTTOKEN',
    client: 'claude-code',
  });

  it('scaffolds the per-toolkit plugin dir and registers via the claude CLI', () => {
    expect(script).toContain('$HOME/.claude/plugins/toolplane-tk');
    expect(script).toContain('claude plugin marketplace add "$PLUGIN_DIR"');
    expect(script).toContain('claude plugin install toolplane-tk@toolplane-tk');
  });

  it('embeds a valid marketplace.json + plugin.json', () => {
    const mkt = JSON.parse(decodeFile(script, '.claude-plugin/marketplace.json'));
    expect(mkt.name).toBe('toolplane-tk');
    expect(mkt.plugins[0]).toMatchObject({ name: 'toolplane-tk', source: './' });

    const plugin = JSON.parse(decodeFile(script, '.claude-plugin/plugin.json'));
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points .mcp.json at the toolkit gateway with a Bearer header (claude → headers)', () => {
    const mcp = JSON.parse(decodeFile(script, '.mcp.json'));
    const server = mcp.mcpServers['toolplane-tk'];
    expect(server.url).toBe(`${BASE}/api/v1/workspaces/ws/toolkits/tk/mcp`);
    expect(server.headers.Authorization).toBe('Bearer sk_user_TESTTOKEN');
    expect(server.http_headers).toBeUndefined();
  });

  it('wires the SessionStart hook to shared/sync.sh', () => {
    const hooks = JSON.parse(decodeFile(script, 'hooks/hooks.json'));
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('shared/sync.sh');
    expect(hooks.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  });

  it('wires PostToolUse + PostToolUseFailure telemetry hooks (matcher "Skill")', () => {
    const hooks = JSON.parse(decodeFile(script, 'hooks/hooks.json'));
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      const h = hooks.hooks[event][0];
      expect(h.matcher).toBe('Skill');
      expect(h.hooks[0].command).toContain('shared/skill-invocation.sh');
    }
  });

  it('embeds the skill-invocation telemetry script', () => {
    expect(script).toContain('skill-invocation.sh');
    const inv = decodeFile(script, 'shared/skill-invocation.sh');
    expect(inv).toContain('/api/v1/plugin/skill-invocation');
    expect(inv).toContain('WORKSPACE="ws"');
  });

  it('keeps buildPluginInstallScript Claude-only even if a client param is passed', () => {
    const scriptForCodexParam = buildPluginInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_X',
      client: 'codex',
    });
    const mcp = JSON.parse(decodeFile(scriptForCodexParam, '.mcp.json'));
    const server = mcp.mcpServers['toolplane-tk'];
    expect(server.headers.Authorization).toBe('Bearer sk_user_X');
    expect(server.http_headers).toBeUndefined();
  });
});

describe('buildToolkitInstallScript', () => {
  it('dispatches Codex installs to config.toml + SessionStart skill sync', () => {
    const script = buildToolkitInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_CODEX',
      client: 'codex',
    });

    expect(script).toContain('config.toml');
    expect(script).toContain('hooks.json');
    expect(script).toContain('[mcp_servers.');
    expect(script).not.toContain('claude plugin install');

    const mcp = JSON.parse(decodeFile(script, '.mcp.json', 'BUNDLE_DIR'));
    expect(mcp.mcpServers['toolplane-tk'].headers.Authorization).toBe('Bearer sk_user_CODEX');

    const sync = decodeFile(script, 'shared/sync.sh', 'BUNDLE_DIR');
    expect(sync).toContain('CLIENT="codex"');
    expect(sync).toContain('DEFAULT_SKILLS_DIR="$HOME/.agents/skills"');
    expect(sync).toContain('DEFAULT_SKILL_DIR_PREFIX="toolplane-tk-"');
  });

  it('dispatches opencode installs to opencode.json MCP + command config', () => {
    const script = buildToolkitInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_OC',
      client: 'opencode',
    });

    expect(script).toContain('opencode.json');
    expect(script).toContain('cfg.mcp[server]');
    expect(script).toContain('cfg.command[server]');
    expect(script).toContain('oauth: false');
    expect(script).not.toContain('claude plugin install');

    const sync = decodeFile(script, 'shared/sync.sh', 'BUNDLE_DIR');
    expect(sync).toContain('CLIENT="opencode"');
    expect(sync).toContain('DEFAULT_SKILLS_DIR="$PLUGIN_ROOT/skills"');
  });

  it('dispatches Hermes installs to config.yaml + ~/.hermes skills', () => {
    const script = buildToolkitInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_HERMES',
      client: 'hermes',
    });

    expect(script).toContain('config.yaml');
    expect(script).toContain('skill-bundles');
    expect(script).toContain('mcp_servers:');
    expect(script).not.toContain('claude plugin install');

    const mcp = JSON.parse(decodeFile(script, '.mcp.json', 'BUNDLE_DIR'));
    expect(mcp.mcpServers['toolplane-tk'].headers.Authorization).toBe('Bearer sk_user_HERMES');

    const sync = decodeFile(script, 'shared/sync.sh', 'BUNDLE_DIR');
    expect(sync).toContain('CLIENT="hermes"');
    expect(sync).toContain('PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"');
    expect(sync).toContain('DEFAULT_SKILLS_DIR="${HERMES_HOME:-$HOME/.hermes}/skills/toolplane"');
    expect(sync).toContain('DEFAULT_SKILL_DIR_PREFIX="toolplane-tk-"');
    expect(script).toContain('$HOME/.local/bin/hermes');
  });

  it('falls back to Claude Code for unknown clients', () => {
    const script = buildToolkitInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_X',
      client: 'bogus',
    });
    expect(script).toContain('claude plugin install toolplane-tk@toolplane-tk');
  });
});

describe('buildPluginUninstallScript', () => {
  const script = buildPluginUninstallScript({ toolkitSlug: 'tk' });
  it('unregisters the plugin + removes its dir', () => {
    expect(script).toContain('$HOME/.claude/plugins/toolplane-tk');
    expect(script).toContain('$HOME/.codex');
    expect(script).toContain('$HOME/.config/opencode');
    expect(script).toContain('$HOME/.hermes');
    expect(script).toContain('claude plugin uninstall toolplane-tk@toolplane-tk');
    expect(script).toContain('claude plugin marketplace remove toolplane-tk');
    expect(script).toContain('rm -rf "$PLUGIN_DIR"');
  });
});

describe('buildSyncScript', () => {
  const sync = buildSyncScript({
    apiBase: BASE,
    workspaceSlug: 'ws',
    toolkitSlug: 'tk',
    client: 'claude-code',
  });

  it('bakes the install-time values and hits the baseline endpoint', () => {
    expect(sync).toContain('API_BASE="http://localhost:3000"');
    expect(sync).toContain('WORKSPACE="ws"');
    expect(sync).toContain('TOOLKIT="tk"');
    expect(sync).toContain('/api/v1/plugin/baseline?workspace=$WORKSPACE&toolkit=$TOOLKIT');
  });

  it('keeps the path-traversal slug guard (no JS escape eating the backslash-d)', () => {
    expect(sync).toContain('/^[a-z0-9][a-z0-9-]*[a-z0-9]$/');
  });
});
