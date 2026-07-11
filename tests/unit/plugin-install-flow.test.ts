import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPluginInstallScript,
  buildPluginUninstallScript,
  buildToolkitInstallScript,
} from '@/lib/plugin/install-script';

let tmp = '';

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(tmp, rel), 'utf8'));
}

function writeFakeCurl(
  bin: string,
  skill = {
    slug: 'alpha',
    content: '# Alpha\n\nBody',
    filePath: 'scripts/alpha.py',
    fileContent: 'print(1)',
  },
) {
  writeFileSync(
    path.join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *"/api/v1/plugin/baseline"*)',
      `    printf "%s\\n" '${JSON.stringify({ data: { skills: [{ slug: skill.slug, content: skill.content, files: [{ path: skill.filePath, content: skill.fileContent }] }] } }).replace(/'/g, "'\\''")}'`,
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
    const skill = readFileSync(path.join(tmp, '.agents/skills/toolplane-tk-alpha/SKILL.md'), 'utf8');
    expect(skill).not.toContain('name: toolplane-tk-alpha');
    expect(skill).toContain('# Alpha');
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

describe('generated Hermes installer', () => {
  it('configures remote MCP, syncs skills, and writes a skill bundle', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'toolplane-hermes-install-'));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(tmp, '.hermes'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.hermes/config.yaml'),
      [
        'mcp_servers:',
        '  other-server:',
        '    url: "https://other.example.com"',
        '  toolplane-tk:',
        '    url: "https://old.example.com"',
        '    headers:',
        '      Authorization: "Bearer stale-token"',
        'hooks: {}',
        '',
      ].join('\n'),
    );
    writeFakeCurl(bin, {
      slug: 'anthropic-pdf',
      content: '---\nname: pdf\ndescription: PDF work\n---\n\n# PDF',
      filePath: 'scripts/pdf.py',
      fileContent: 'print("pdf")',
    });

    const installer = path.join(tmp, 'install-hermes.sh');
    writeFileSync(
      installer,
      buildToolkitInstallScript({
        base: 'https://mcp.example.com',
        workspaceSlug: 'ws',
        toolkitSlug: 'tk',
        token: 'sk_user_HERMES',
        client: 'hermes',
      }),
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [installer], {
      env: { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    });

    const config = readFileSync(path.join(tmp, '.hermes/config.yaml'), 'utf8');
    expect(config).toContain('mcp_servers:');
    expect(config).toContain('  toolplane-tk:');
    expect(config).toContain('    url: "https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp"');
    expect(config).toContain('      Authorization: "Bearer sk_user_HERMES"');
    expect(config).not.toContain('stale-token');
    expect(config.match(/^  toolplane-tk:/gm)).toHaveLength(1);
    expect(config).toContain('  other-server:');
    expect(config).toContain('hooks:');
    expect(config).toContain('  on_session_start:');
    expect(config).toContain('    - command: "bash \\"');
    expect(config).toContain('/.hermes/toolplane/toolplane-tk/shared/hook-sync.sh\\""');

    const mcp = readJson('.hermes/toolplane/toolplane-tk/.mcp.json') as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    expect(mcp.mcpServers['toolplane-tk'].headers.Authorization).toBe('Bearer sk_user_HERMES');
    expect(statSync(path.join(tmp, '.hermes/toolplane/toolplane-tk/shared/sync.sh')).mode & 0o111).toBeTruthy();
    const hookSync = path.join(tmp, '.hermes/toolplane/toolplane-tk/shared/hook-sync.sh');
    expect(statSync(hookSync).mode & 0o111).toBeTruthy();
    const hookOut = execFileSync('/bin/bash', [hookSync], {
      env: { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH ?? ''}` },
      input: '{}\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    expect(hookOut).toBe('{}\n');
    const skill = readFileSync(path.join(tmp, '.hermes/skills/toolplane-tk/pdf/SKILL.md'), 'utf8');
    expect(skill).not.toContain('name: toolplane-tk-alpha');
    expect(skill).toContain('name: pdf');
    expect(skill).toContain('# PDF');
    expect(readFileSync(path.join(tmp, '.hermes/skills/toolplane-tk/pdf/scripts/pdf.py'), 'utf8')).toBe('print("pdf")');

    const bundle = readFileSync(path.join(tmp, '.hermes/skill-bundles/toolplane-tk.yaml'), 'utf8');
    expect(bundle).toContain('name: toolplane-tk');
    expect(bundle).toContain('  - toolplane-tk/pdf');
    expect(bundle).toContain('Its MCP tools are available through the "toolplane-tk" MCP server.');
  });
});

describe('generated toolkit uninstaller', () => {
  it('removes only ToolPlane-prefixed Hermes skills for the toolkit', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'toolplane-uninstall-'));

    mkdirSync(path.join(tmp, '.hermes/skills/toolplane-tk/alpha'), { recursive: true });
    mkdirSync(path.join(tmp, '.hermes/skills/toolplane/toolplane-other-beta'), { recursive: true });
    mkdirSync(path.join(tmp, '.hermes/skills/apple/apple-notes'), { recursive: true });
    mkdirSync(path.join(tmp, '.hermes/skill-bundles'), { recursive: true });
    mkdirSync(path.join(tmp, '.hermes/toolplane/toolplane-tk/shared'), { recursive: true });
    writeFileSync(path.join(tmp, '.hermes/skill-bundles/toolplane-tk.yaml'), 'name: toolplane-tk\n');
    writeFileSync(path.join(tmp, '.hermes/toolplane/toolplane-tk/shared/sync.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(
      path.join(tmp, '.hermes/config.yaml'),
      [
        'mcp_servers:',
        '  # BEGIN TOOLPLANE toolplane-tk',
        '  toolplane-tk:',
        '    url: "https://mcp.example.com"',
        '  # END TOOLPLANE toolplane-tk',
        '  other-server:',
        '    url: "https://other.example.com"',
        '',
      ].join('\n'),
    );

    const uninstaller = path.join(tmp, 'uninstall.sh');
    writeFileSync(uninstaller, buildPluginUninstallScript({ toolkitSlug: 'tk' }), {
      mode: 0o755,
    });

    execFileSync('/bin/bash', [uninstaller], {
      env: { ...process.env, HOME: tmp },
      stdio: 'pipe',
    });

    expect(() => statSync(path.join(tmp, '.hermes/skills/toolplane-tk'))).toThrow();
    expect(statSync(path.join(tmp, '.hermes/skills/toolplane/toolplane-other-beta')).isDirectory()).toBe(true);
    expect(statSync(path.join(tmp, '.hermes/skills/apple/apple-notes')).isDirectory()).toBe(true);
    expect(() => statSync(path.join(tmp, '.hermes/skill-bundles/toolplane-tk.yaml'))).toThrow();
    expect(() => statSync(path.join(tmp, '.hermes/toolplane/toolplane-tk'))).toThrow();
    const config = readFileSync(path.join(tmp, '.hermes/config.yaml'), 'utf8');
    expect(config).not.toContain('toolplane-tk');
    expect(config).toContain('other-server');
  });
});
