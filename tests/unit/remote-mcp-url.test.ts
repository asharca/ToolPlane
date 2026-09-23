import { describe, expect, it } from 'vitest';
import { isInsecureRemoteMcpUrl, isValidRemoteMcpUrl } from '@/lib/remote-mcp/url';

describe.each(['http', 'https'])('remote MCP %s URL policy', (scheme) => {
  it.each([
    'mcp.example.com/mcp',
    'mcp.example.com:8000/mcp',
    'mcp.example.com:8443/sse',
    'mcp.example.com:65535/mcp',
    // Syntax acceptance is not permission: the bridge enforces the admin allowlist.
    '10.0.10.42:8000/mcp',
    '[fd00::42]:8000/mcp',
  ])('accepts endpoint syntax for %s', (endpoint) => {
    expect(isValidRemoteMcpUrl(`${scheme}://${endpoint}`)).toBe(true);
  });

  it.each([
    'localhost/mcp',
    'localhost.:8000/mcp',
    'test.localhost/mcp',
    'server.local/mcp',
    '127.0.0.1:8000/mcp',
    '127.1/mcp',
    '2130706433/mcp',
    '0.0.0.0/mcp',
    '169.254.169.254/mcp',
    '100.64.0.1/mcp',
    '192.0.2.1/mcp',
    '[::1]/mcp',
    '[::ffff:127.0.0.1]/mcp',
    '[fe80::1]/mcp',
    '[2001:db8::1]/mcp',
    'user:secret@mcp.example.com/mcp',
    'mcp.example.com/mcp?token=secret',
    'mcp.example.com/mcp#fragment',
    'mcp.example.com:0/mcp',
    'mcp.example.com:65536/mcp',
    'mcp.example.com:-1/mcp',
  ])('rejects %s', (endpoint) => {
    expect(isValidRemoteMcpUrl(`${scheme}://${endpoint}`)).toBe(false);
  });
});

describe('remote MCP protocol and risk detection', () => {
  it.each(['ftp://mcp.example.com/mcp', 'file:///etc/passwd', 'ws://mcp.example.com/mcp', '', '/mcp', 'not a url'])(
    'rejects unsupported or malformed URL %s',
    (url) => expect(isValidRemoteMcpUrl(url)).toBe(false),
  );
  it.each(['http://mcp.example.com:80/mcp', 'https://mcp.example.com:443/mcp'])(
    'accepts explicit default port %s',
    (url) => expect(isValidRemoteMcpUrl(url)).toBe(true),
  );
  it.each([
    ['http://mcp.example.com/mcp', true],
    ['HTTP://mcp.example.com:8000/mcp', true],
    ['https://mcp.example.com/mcp', false],
    ['not a url', false],
    ['', false],
  ] as const)('detects insecure transport for %s', (url, expected) => {
    expect(isInsecureRemoteMcpUrl(url)).toBe(expected);
  });
});
