import { describe, it, expect } from 'vitest';
import {
  buildPluginInstallScript,
  buildPluginUninstallScript,
  resolveClient,
} from '@/lib/plugin/install-script';
import { buildSyncScript } from '@/lib/plugin/sync-script';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull a base64-embedded file body back out of the generated install script.
function decodeFile(script: string, relPath: string): string {
  const re = new RegExp(
    `printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d > "\\$PLUGIN_DIR/${escapeRe(relPath)}"`,
  );
  const m = re.exec(script);
  if (!m) throw new Error(`no embedded file at ${relPath}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

const BASE = 'http://localhost:3000';

describe('resolveClient', () => {
  it('accepts known clients and falls back to claude-code', () => {
    expect(resolveClient('codex')).toBe('codex');
    expect(resolveClient('claude')).toBe('claude');
    expect(resolveClient('claude-code')).toBe('claude-code');
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
    expect(script).toContain('$HOME/.claude/plugins/mcpmarket-tk');
    expect(script).toContain('claude plugin marketplace add "$PLUGIN_DIR"');
    expect(script).toContain('claude plugin install mcpmarket-tk@mcpmarket-tk');
  });

  it('embeds a valid marketplace.json + plugin.json', () => {
    const mkt = JSON.parse(decodeFile(script, '.claude-plugin/marketplace.json'));
    expect(mkt.name).toBe('mcpmarket-tk');
    expect(mkt.plugins[0]).toMatchObject({ name: 'mcpmarket-tk', source: './' });

    const plugin = JSON.parse(decodeFile(script, '.claude-plugin/plugin.json'));
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points .mcp.json at the toolkit gateway with a Bearer header (claude → headers)', () => {
    const mcp = JSON.parse(decodeFile(script, '.mcp.json'));
    const server = mcp.mcpServers['mcpmarket-tk'];
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

  it('uses http_headers for the codex client', () => {
    const codex = buildPluginInstallScript({
      base: BASE,
      workspaceSlug: 'ws',
      toolkitSlug: 'tk',
      token: 'sk_user_X',
      client: 'codex',
    });
    const mcp = JSON.parse(decodeFile(codex, '.mcp.json'));
    const server = mcp.mcpServers['mcpmarket-tk'];
    expect(server.http_headers.Authorization).toBe('Bearer sk_user_X');
    expect(server.headers).toBeUndefined();
  });
});

describe('buildPluginUninstallScript', () => {
  const script = buildPluginUninstallScript({ toolkitSlug: 'tk' });
  it('unregisters the plugin + removes its dir', () => {
    expect(script).toContain('$HOME/.claude/plugins/mcpmarket-tk');
    expect(script).toContain('claude plugin uninstall mcpmarket-tk@mcpmarket-tk');
    expect(script).toContain('claude plugin marketplace remove mcpmarket-tk');
    expect(script).toContain('rm -rf "$PLUGIN_DIR"');
  });
});

describe('buildSyncScript', () => {
  const sync = buildSyncScript({ apiBase: BASE, workspaceSlug: 'ws', toolkitSlug: 'tk' });

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
