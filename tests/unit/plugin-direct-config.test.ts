import { describe, expect, it } from 'vitest';
import {
  buildDirectSnippet,
  directClientLabel,
  DIRECT_CLIENTS,
} from '@/lib/plugin/direct-config';

const URL = 'https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp';

describe('direct MCP client config snippets', () => {
  it('lists the direct clients shown in the toolkit installer', () => {
    expect(DIRECT_CLIENTS).toEqual(['claude-code', 'claude', 'codex', 'opencode', 'hermes']);
    expect(directClientLabel('opencode')).toBe('opencode');
    expect(directClientLabel('hermes')).toBe('Hermes');
  });

  it('builds a Codex CLI TOML snippet with http_headers', () => {
    expect(buildDirectSnippet('codex', 'tk', URL)).toContain('[mcp_servers.tk]');
    expect(buildDirectSnippet('codex', 'tk', URL)).toContain('http_headers = { Authorization = "Bearer YOUR_TOKEN" }');
  });

  it('builds opencode remote MCP config with headers and oauth disabled', () => {
    const cfg = JSON.parse(buildDirectSnippet('opencode', 'tk', URL));
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.mcp.tk).toEqual({
      type: 'remote',
      url: URL,
      enabled: true,
      oauth: false,
      headers: { Authorization: 'Bearer YOUR_TOKEN' },
    });
  });

  it('keeps Claude Code as a direct CLI command', () => {
    expect(buildDirectSnippet('claude-code', 'tk', URL)).toBe(
      `claude mcp add --transport http "tk" "${URL}" --header "Authorization: Bearer YOUR_TOKEN"`,
    );
  });

  it('builds a Hermes config.yaml snippet with a Bearer header', () => {
    expect(buildDirectSnippet('hermes', 'tk', URL)).toBe(
      [
        '# ~/.hermes/config.yaml',
        '# After editing, run /reload-mcp in Hermes or restart Hermes.',
        'mcp_servers:',
        '  toolplane-tk:',
        `    url: "${URL}"`,
        '    headers:',
        '      Authorization: "Bearer YOUR_TOKEN"',
      ].join('\n'),
    );
  });
});
