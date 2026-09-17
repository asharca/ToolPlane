// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/auth/tokens', () => ({ verifyApiTokenContext: mocks.context }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.session }));
import { resolveRequestPrincipal, resolveRequestUser, resolveAgentControlRequestUser } from '@/lib/auth/request-user';
import { toolkitAccessWhere } from '@/lib/auth/toolkit-scope';

beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ id: 'user' }); });
const req = (authorization?: string) => new Request('https://toolplane.test', { headers: authorization === undefined ? {} : { authorization } });
describe('credential scope is never reduced to user identity', () => {
  it('retains the Toolkit identity only for explicit scoped callers', async () => {
    mocks.context.mockResolvedValue({ user: { id: 'user' }, token: { id: 'token', toolkitId: 'a' } });
    const principal = await resolveRequestPrincipal(req('Bearer install'));
    expect(principal).toMatchObject({ credential: 'toolkit-token', token: { toolkitId: 'a' } });
    expect(await resolveRequestUser(req('Bearer install'))).toBeNull();
    expect(await resolveAgentControlRequestUser(req('Bearer install'))).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it.each(['', 'Bearer invalid', 'Basic abc'])('never retries a supplied invalid header through a cookie: %s', async (header) => {
    mocks.context.mockResolvedValue(null);
    expect(await resolveRequestUser(req(header))).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it('allows personal tokens and cookie-only sessions where explicitly supported', async () => {
    mocks.context.mockResolvedValue({ user: { id: 'user' }, token: { id: 'token', toolkitId: null } });
    expect(await resolveRequestUser(req('Bearer personal'))).toEqual({ id: 'user' });
    expect(await resolveRequestUser(req())).toEqual({ id: 'user' });
    expect(await resolveRequestPrincipal(req(), { allowSession: false })).toBeNull();
  });
  it('intersects A scope with requested B and current workspace membership', () => {
    const where = toolkitAccessWhere({ user: { id: 'user' }, token: { toolkitId: 'a' } }, 'other-workspace', 'b');
    expect(where).toEqual({ id: 'a', slug: 'b', enabled: true, workspace: {
      slug: 'other-workspace', status: 'active', OR: [{ ownerId: 'user' }, { members: { some: { userId: 'user' } } }],
    } });
  });
});
