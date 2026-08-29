// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyApiToken: vi.fn(),
  verifyApiTokenContext: vi.fn(),
  getCurrentUser: vi.fn(),
}));

vi.mock('@/lib/auth/tokens', () => ({
  verifyApiToken: mocks.verifyApiToken,
  verifyApiTokenContext: mocks.verifyApiTokenContext,
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));

import {
  resolveAccountRequestUser,
  resolveAgentControlRequestUser,
} from '@/lib/auth/request-user';

describe('Account-level request authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'session-user' });
  });

  it('accepts a cookie-only browser session', async () => {
    await expect(resolveAccountRequestUser(new Request('http://localhost')))
      .resolves.toEqual({ id: 'session-user' });
    expect(mocks.verifyApiTokenContext).not.toHaveBeenCalled();
  });

  it('accepts an account-level personal API token', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'token-user' },
      token: { id: 'token-1', toolkitId: null },
    });

    await expect(resolveAccountRequestUser(new Request('http://localhost', {
      headers: { authorization: 'Bearer personal' },
    }))).resolves.toEqual({ id: 'token-user' });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects a toolkit-scoped token without falling back to the session', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'token-user' },
      token: { id: 'token-1', toolkitId: 'toolkit-1' },
    });

    await expect(resolveAccountRequestUser(new Request('http://localhost', {
      headers: { authorization: 'Bearer toolkit-token' },
    }))).resolves.toBeNull();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });
});

describe('Agent Control MCP authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'session-user' });
  });

  it('accepts an account-level personal API token', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'token-user' },
      token: { id: 'token-1', toolkitId: null },
    });
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer personal' },
    });

    await expect(resolveAgentControlRequestUser(request)).resolves.toEqual({ id: 'token-user' });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects toolkit-scoped tokens instead of granting agent write access', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'token-user' },
      token: { id: 'token-1', toolkitId: 'toolkit-1' },
    });
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer toolkit-token' },
    });

    await expect(resolveAgentControlRequestUser(request)).resolves.toBeNull();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('never falls back to a session when an explicit Bearer token is invalid', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue(null);
    const request = new Request('http://localhost', {
      headers: { authorization: 'Bearer invalid' },
    });

    await expect(resolveAgentControlRequestUser(request)).resolves.toBeNull();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects cookie-only browser sessions', async () => {
    await expect(resolveAgentControlRequestUser(new Request('http://localhost')))
      .resolves.toBeNull();
    expect(mocks.verifyApiTokenContext).not.toHaveBeenCalled();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });
});
