import { describe, it, expect } from 'vitest';
import { buildBridgeChildEnv, filterEnv, BRIDGE_ENV_ALLOWLIST } from '../../scripts/bridge-env.mjs';

describe('bridge filterEnv', () => {
  it('keeps only allowlisted vars and drops app secrets', () => {
    const out = filterEnv({
      PATH: '/usr/bin',
      DOCKER_HOST: 'tcp://socket-proxy:2375',
      DATABASE_URL: 'postgresql://mcp:secret@db/mcp',
      AUTH_SECRET: 'shhh',
      SOMETHING_ELSE: 'x',
    }) as Record<string, string | undefined>;
    expect(out).toEqual({ PATH: '/usr/bin', DOCKER_HOST: 'tcp://socket-proxy:2375' });
    expect(out.DATABASE_URL).toBeUndefined();
    expect(out.AUTH_SECRET).toBeUndefined();
  });

  it('the allowlist never includes app secrets', () => {
    expect(BRIDGE_ENV_ALLOWLIST).not.toContain('DATABASE_URL');
    expect(BRIDGE_ENV_ALLOWLIST).not.toContain('AUTH_SECRET');
  });

  it('adds only deployment-scoped env and rejects Docker control overrides', () => {
    expect(buildBridgeChildEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgresql://app-secret',
    }, JSON.stringify({ API_TOKEN: 'mcp-secret', HOME: '/tmp' }))).toEqual({
      PATH: '/usr/bin',
      API_TOKEN: 'mcp-secret',
      HOME: '/tmp',
    });
    expect(() => buildBridgeChildEnv({}, JSON.stringify({ DOCKER_HOST: 'tcp://attacker:2375' })))
      .toThrow('invalid MCP_CHILD_ENV');
  });
});
