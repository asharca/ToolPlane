export const DIRECT_CLIENTS = ['claude-code', 'claude', 'codex', 'opencode'] as const;
export type DirectClient = (typeof DIRECT_CLIENTS)[number];

export function directClientLabel(client: DirectClient): string {
  if (client === 'claude') return 'Claude';
  if (client === 'codex') return 'Codex';
  if (client === 'opencode') return 'opencode';
  return 'Claude Code';
}

function genericJsonConfig(key: string, url: string): string {
  return [
    '{',
    '  "mcpServers": {',
    `    "${key}": {`,
    '      "type": "http",',
    `      "url": "${url}",`,
    '      "headers": { "Authorization": "Bearer YOUR_TOKEN" }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

export function buildDirectSnippet(client: DirectClient, key: string, url: string): string {
  if (client === 'claude-code') {
    return `claude mcp add --transport http "${key}" "${url}" --header "Authorization: Bearer YOUR_TOKEN"`;
  }
  if (client === 'codex') {
    return [
      '# ~/.codex/config.toml',
      `[mcp_servers.${key}]`,
      `url = "${url}"`,
      'http_headers = { Authorization = "Bearer YOUR_TOKEN" }',
    ].join('\n');
  }
  if (client === 'opencode') {
    return [
      '{',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      `    "${key}": {`,
      '      "type": "remote",',
      `      "url": "${url}",`,
      '      "enabled": true,',
      '      "oauth": false,',
      '      "headers": { "Authorization": "Bearer YOUR_TOKEN" }',
      '    }',
      '  }',
      '}',
    ].join('\n');
  }
  return genericJsonConfig(key, url);
}
