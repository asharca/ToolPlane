// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { a2aConnectionInfo, a2aCurlExample, a2aDeploymentOrigin, a2aMcpConnectionExample } from '@/lib/a2a/connection-info';
import { validateParams } from '@/lib/a2a/validation';

afterEach(() => vi.unstubAllEnvs());

describe('A2A connection information', () => {
  it('generates a service-only MCP example without a real credential', () => {
    const data = JSON.parse(a2aMcpConnectionExample('https://tp.example/a2a/mcp'));
    expect(data).toEqual({transport: 'streamable-http', url: 'https://tp.example/a2a/mcp', headers: {Authorization: 'Bearer <TOOLPLANE_A2A_TOKEN>'}});
    expect(a2aConnectionInfo('https://tp.example', 'w', 'a').publicMcp).toBeNull();
  });

  it('uses configured origins and encodes route identities', () => {
    expect(a2aConnectionInfo('https://tp.example/path', 'team /a', 'agent?x', 'agep_test')).toEqual({
      localRpc: 'https://tp.example/api/v1/workspaces/team%20%2Fa/agents/agent%3Fx/a2a/local',
      localCard: 'https://tp.example/api/v1/workspaces/team%20%2Fa/agents/agent%3Fx/a2a/local',
      publicRpc: 'https://tp.example/api/v1/agent-endpoints/agep_test/a2a',
      publicCard: 'https://tp.example/api/v1/agent-endpoints/agep_test/a2a/.well-known/agent-card.json',
      publicMcp: 'https://tp.example/api/v1/agent-endpoints/agep_test/a2a/mcp',
    });
  });
  it.each(['http://example.com', 'https://user:secret@example.com', 'javascript:alert(1)', 'https://example.com/?token=x', 'https://example.com/#x'])('rejects unsafe origin %s', (url) => {
    expect(() => a2aDeploymentOrigin(url)).toThrow();
  });
  it.each(['http://localhost:3000', 'http://127.0.0.1:3001', 'http://[::1]:3000'])('allows loopback %s', (url) => expect(a2aDeploymentOrigin(url)).toBe(url));
  it.each(['http://10.0.10.2:3002', 'http://172.16.0.1:3002', 'http://172.31.255.254:3002', 'http://192.168.1.2:3002'])(
    'allows private IPv4 only in development: %s', (url) => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(a2aDeploymentOrigin(url)).toBe(url);
      for (const mode of ['production', 'test', undefined]) {
        vi.stubEnv('NODE_ENV', mode);
        expect(() => a2aDeploymentOrigin(url)).toThrow();
      }
    });
  it.each(['http://172.15.255.255', 'http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1',
    'http://169.254.169.254', 'http://0.0.0.0', 'http://example.com', 'http://10.0.0.1.example.com',
    'http://user:secret@10.0.10.2', 'http://10.0.10.2/?token=x', 'http://10.0.10.2/#x', 'ftp://10.0.10.2'])(
    'keeps unsafe development origins blocked: %s', (url) => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(() => a2aDeploymentOrigin(url)).toThrow();
    });
  it.each(['SendMessage', 'GetTask', 'SubscribeToTask', 'CancelTask'] as const)('generates %s with the same standard contract as the native handler', (method) => {
    const code = a2aCurlExample('https://tp.example/a2a', 'public', method);
    expect(code).toContain('$TOOLPLANE_A2A_TOKEN');
    expect(code).toContain('A2A-Version: 1.0');
    const json = JSON.parse(code.split("  -d '")[1].slice(0, -1));
    expect(json.method).toBe(method);
    expect(() => validateParams(method, json.params)).not.toThrow();
  });
  it('keeps local and service credentials separate and card fetches authenticated', () => {
    const code = a2aCurlExample('https://tp.example/card', 'local', 'card');
    expect(code).toContain('$TOOLPLANE_ACCOUNT_TOKEN');
    expect(code).not.toContain('$TOOLPLANE_A2A_TOKEN');
    expect(code).not.toContain('SendMessage');
  });
});
