// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_TOKEN_MAX_TTL_SECONDS,
  AGENT_RUNTIME_TOKEN_HEADER,
  agentRuntimeTokenFromRequest,
  createAgentRuntimeToken,
  runtimeMcpProxyUrl,
  runtimeModelProxyBase,
  runtimeProviderUrl,
  sandboxRuntimeOrigin,
  verifyAgentRuntimeToken,
} from '@/lib/agents/runtime-access';

describe('Agent runtime access grants', () => {
  const originalSecret = process.env.AUTH_SECRET;
  const originalRuntimeOrigin = process.env.TOOLPLANE_RUNTIME_ORIGIN;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const now = Date.UTC(2026, 7, 25, 12, 0, 0);
  const payload = {
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    sandboxId: 'sandbox-1',
    providerId: 'provider-1',
    deploymentIds: ['deployment-1', 'deployment-1'],
    exp: Math.floor(now / 1000) + 300,
  };

  beforeEach(() => {
    process.env.AUTH_SECRET = 'runtime-token-test-secret';
    delete process.env.TOOLPLANE_RUNTIME_ORIGIN;
  });

  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
    process.env.TOOLPLANE_RUNTIME_ORIGIN = originalRuntimeOrigin;
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it('signs a scoped, expiring grant and rejects tampering or expiration', async () => {
    const token = await createAgentRuntimeToken(payload, now);
    await expect(verifyAgentRuntimeToken(token, now)).resolves.toEqual({
      ...payload,
      deploymentIds: ['deployment-1'],
    });
    await expect(verifyAgentRuntimeToken(`${token}x`, now)).resolves.toBeNull();
    await expect(verifyAgentRuntimeToken(token, now + 301_000)).resolves.toBeNull();
  });

  it('does not mint grants beyond the short lifetime ceiling', async () => {
    await expect(createAgentRuntimeToken({
      ...payload,
      exp: Math.floor(now / 1000) + AGENT_RUNTIME_TOKEN_MAX_TTL_SECONDS + 1,
    }, now)).rejects.toThrow('payload is invalid');
  });

  it('accepts the dedicated header, Bearer, and Claude-compatible x-api-key', async () => {
    const token = await createAgentRuntimeToken({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    for (const [name, value] of [
      [AGENT_RUNTIME_TOKEN_HEADER, token],
      ['authorization', `Bearer ${token}`],
      ['x-api-key', token],
    ] as const) {
      await expect(agentRuntimeTokenFromRequest({ headers: new Headers({ [name]: value }) }))
        .resolves.toMatchObject({ agentId: 'agent-1', sandboxId: 'sandbox-1' });
    }
  });

  it('builds sandbox-reachable proxy URLs and preserves provider base paths', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000/app/path';
    expect(sandboxRuntimeOrigin()).toBe('http://host.docker.internal:3000');
    expect(runtimeModelProxyBase('provider/a')).toBe(
      'http://host.docker.internal:3000/api/v1/agent-runtime/model/provider%2Fa',
    );
    expect(runtimeMcpProxyUrl('deployment/a')).toBe(
      'http://host.docker.internal:3000/api/v1/agent-runtime/mcp/deployment%2Fa/rpc',
    );
    expect(runtimeProviderUrl(
      'https://provider.test/v1/',
      ['chat', 'completions'],
      '?stream=true',
    )).toBe('https://provider.test/v1/chat/completions?stream=true');
    expect(runtimeProviderUrl('https://api.anthropic.com/v1', ['v1', 'messages']))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(() => runtimeProviderUrl('https://provider.test/v1', ['..', 'secret']))
      .toThrow('path is invalid');
  });
});
