import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginInstallScript, buildToolkitInstallScript } from '@/lib/plugin/install-script';

let tmp = '';

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(tmp, rel), 'utf8'));
}

function writeFakeCurl(bin: string) {
  writeFileSync(
    path.join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *"/api/v1/plugin/baseline"*)',
      '    printf "%s\\n" \'{"data":{"skills":[{"slug":"alpha","content":"# Alpha\\\\n\\\\nBody","files":[{"path":"scripts/alpha.py","content":"print(1)"}]}]}}\'',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

describe('generated Claude Code plugin installer', () => {
  it('installs the plugin files and registers through the claude CLI', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'toolplane-install-'));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const claudeStub = path.join(bin, 'claude');
    writeFileSync(
      claudeStub,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$HOME/claude-calls.log"\nexit 0\n',
      { mode: 0o755 },
    );

    const installer = path.join(tmp, 'install.sh');
    writeFileSync(
      installer,
      buildPluginInstallScript({
        base: 'https://mcp.example.com',
        workspaceSlug: 'ws',
        toolkitSlug: 'tk',
        token: 'sk_user_TEST',
        client: 'claude-code',
      }),
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [installer], {
      env: { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    });

    const root = '.claude/plugins/toolplane-tk';
    const marketplace = readJson(`${root}/.claude-plugin/marketplace.json`) as {
      name: string;
      plugins: { name: string; source: string }[];
    };
    expect(marketplace.name).toBe('toolplane-tk');
    expect(marketplace.plugins[0]).toEqual({ name: 'toolplane-tk', source: './' });

    const plugin = readJson(`${root}/.claude-plugin/plugin.json`) as {
      skills: string;
      mcpServers: string;
    };
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');

    const mcp = readJson(`${root}/.mcp.json`) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    expect(mcp.mcpServers['toolplane-tk']).toEqual({
      url: 'https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp',
      headers: { Authorization: 'Bearer sk_user_TEST' },
    });

    const hooks = readJson(`${root}/hooks/hooks.json`) as {
      hooks: { SessionStart: unknown[]; PostToolUse: unknown[]; PostToolUseFailure: unknown[] };
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.PostToolUseFailure).toHaveLength(1);
    expect(statSync(path.join(tmp, `${root}/shared/sync.sh`)).mode & 0o111).toBeTruthy();
    expect(statSync(path.join(tmp, `${root}/shared/skill-invocation.sh`)).mode & 0o111).toBeTruthy();

    const calls = readFileSync(path.join(tmp, 'claude-calls.log'), 'utf8');
    expect(calls).toContain(`plugin marketplace add ${path.join(tmp, root)}`);
    expect(calls).toContain('plugin uninstall toolplane-tk@toolplane-tk');
    expect(calls).toContain('plugin install toolplane-tk@toolplane-tk');
  });
});

describe('generated Codex installer', () => {
  it('configures Codex MCP, hooks, and synced user skills', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'toolplane-codex-install-'));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    writeFakeCurl(bin);

    const installer = path.join(tmp, 'install-codex.sh');
    writeFileSync(
      installer,
      buildToolkitInstallScript({
        base: 'https://mcp.example.com',
        workspaceSlug: 'ws',
        toolkitSlug: 'tk',
        token: 'sk_user_CODEX',
        client: 'codex',
      }),
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [installer], {
      env: { ...process.env, HOME: tmp, CODEX_HOME: path.join(tmp, '.codex'), PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    });

    const config = readFileSync(path.join(tmp, '.codex/config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.toolplane-tk]');
    expect(config).toContain('url = "https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp"');
    expect(config).toContain('http_headers = { Authorization = "Bearer sk_user_CODEX" }');

    const hooks = readJson('.codex/hooks.json') as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      '.codex/toolplane/toolplane-tk/shared/sync.sh',
    );

    const mcp = readJson('.codex/toolplane/toolplane-tk/.mcp.json') as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    expect(mcp.mcpServers['toolplane-tk'].headers.Authorization).toBe('Bearer sk_user_CODEX');
    expect(statSync(path.join(tmp, '.codex/toolplane/toolplane-tk/shared/sync.sh')).mode & 0o111).toBeTruthy();
    expect(readFileSync(path.join(tmp, '.agents/skills/toolplane-tk-alpha/SKILL.md'), 'utf8')).toContain('# Alpha');
    expect(readFileSync(path.join(tmp, '.agents/skills/toolplane-tk-alpha/scripts/alpha.py'), 'utf8')).toBe('print(1)');
  });
});

describe('generated opencode installer', () => {
  it('configures remote MCP, a toolkit command, and synced skill cache', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'toolplane-opencode-install-'));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    writeFakeCurl(bin);
    const configDir = path.join(tmp, 'opencode-config');

    const installer = path.join(tmp, 'install-opencode.sh');
    writeFileSync(
      installer,
      buildToolkitInstallScript({
        base: 'https://mcp.example.com',
        workspaceSlug: 'ws',
        toolkitSlug: 'tk',
        token: 'sk_user_OC',
        client: 'opencode',
      }),
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [installer], {
      env: { ...process.env, HOME: tmp, OPENCODE_CONFIG_DIR: configDir, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    });

    const cfg = JSON.parse(readFileSync(path.join(configDir, 'opencode.json'), 'utf8')) as {
      mcp: Record<string, unknown>;
      command: Record<string, { template: string }>;
    };
    expect(cfg.mcp['toolplane-tk']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp',
      enabled: true,
      oauth: false,
      headers: { Authorization: 'Bearer sk_user_OC' },
    });
    expect(cfg.command['toolplane-tk'].template).toContain(
      path.join(configDir, 'toolplane/toolplane-tk/skills'),
    );
    expect(cfg.command['toolplane-tk'].template).toContain('$ARGUMENTS');
    expect(readFileSync(path.join(configDir, 'toolplane/toolplane-tk/skills/alpha/SKILL.md'), 'utf8')).toContain('# Alpha');
    expect(readFileSync(path.join(configDir, 'toolplane/toolplane-tk/skills/alpha/scripts/alpha.py'), 'utf8')).toBe('print(1)');
  });
});
