import { describe, expect, it } from 'vitest';
import { parseRemoteMcpPrivateHosts } from '../../scripts/remote-mcp-private-hosts.mjs';

describe('Remote MCP private host allowlist', () => {
  it('normalizes exact hosts, wildcard suffixes, and private IP addresses', () => {
    const parsed = parseRemoteMcpPrivateHosts('MCP.RHZY.AI.\n*.RHZY.AI,10.0.10.42,10.0.10.42');

    expect(parsed?.value).toBe('mcp.rhzy.ai,*.rhzy.ai,10.0.10.42');
    expect(parsed?.hosts).toEqual(new Set(['mcp.rhzy.ai']));
    expect(parsed?.suffixes).toEqual(new Set(['rhzy.ai']));
    expect(parsed?.ips).toEqual(new Set(['10.0.10.42']));
  });

  it.each([
    'localhost',
    '*.localhost',
    'api.local',
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.0/8',
    '8.8.8.8',
    'https://mcp.rhzy.ai/mcp',
  ])('rejects unsafe or malformed entry %s', (value) => {
    expect(parseRemoteMcpPrivateHosts(value)).toBeNull();
  });
});
