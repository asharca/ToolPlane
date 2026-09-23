import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findToken: vi.fn(), findSandbox: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: {
  sandboxMcpToken: { findFirst: mocks.findToken }, sandbox: { findFirst: mocks.findSandbox },
} }));
import { hashSandboxMcpToken, newSandboxMcpSecret, resolveSandboxMcpGrant, sandboxBearer } from '@/lib/sandboxes/mcp-access';
const secret = `mcpsbx_${'a'.repeat(64)}`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findToken.mockResolvedValue({ id: 'grant1', userId: 'issuer1', allowedTools: ['read_file'] });
  mocks.findSandbox.mockResolvedValue({ id: 'sb1', kind: 'docker', workspaceId: 'ws1', deploymentId: 'dep1' });
});
describe('scoped sandbox MCP authentication', () => {
  it('generates a random one-time secret, prefix and one-way database value', () => {
    const a = newSandboxMcpSecret(), b = newSandboxMcpSecret();
    expect(a.token).toMatch(/^mcpsbx_[a-f0-9]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashSandboxMcpToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
  });
  it('does not accept tokens in query strings, cookies or different credential classes', () => {
    expect(sandboxBearer(new Request(`https://example.test/mcp?token=${secret}`, { headers: { cookie: `token=${secret}` } }))).toBeNull();
    expect(sandboxBearer(new Request('https://example.test/mcp', { headers: { authorization: 'Bearer personal_or_toolkit_token' } }))).toBeNull();
  });
  it('binds lookups to the exact sandbox, live expiry and revocation state', async () => {
    await resolveSandboxMcpGrant('sb1', secret);
    expect(mocks.findToken).toHaveBeenCalledWith(expect.objectContaining({ where: {
      sandboxId: 'sb1', tokenHash: hashSandboxMcpToken(secret), revokedAt: null, expiresAt: { gt: expect.any(Date) },
    } }));
  });
  it('returns no authority for a missing, revoked or expired grant', async () => {
    mocks.findToken.mockResolvedValue(null);
    expect(await resolveSandboxMcpGrant('sb1', secret)).toBeNull();
    expect(mocks.findSandbox).not.toHaveBeenCalled();
  });
  it('rechecks issuer membership in an active workspace', async () => {
    await resolveSandboxMcpGrant('sb1', secret);
    expect(mocks.findSandbox).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'sb1', workspace: { status: 'active', OR: [{ ownerId: 'issuer1', owner: { status: 'active' } }, { members: { some: { userId: 'issuer1', user: { status: 'active' } } } }] },
    } }));
    mocks.findSandbox.mockResolvedValue(null);
    expect(await resolveSandboxMcpGrant('sb1', secret)).toBeNull();
  });
  it('does not export protected Hermes credentials', async () => {
    mocks.findSandbox.mockResolvedValue({ id: 'sb1', kind: 'hermes' });
    expect(await resolveSandboxMcpGrant('sb1', secret)).toBeNull();
  });
});
