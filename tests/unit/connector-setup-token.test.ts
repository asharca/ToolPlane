import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.get, set: mocks.set }),
}));

import {
  readConnectorSetupTokenCookie,
  setConnectorSetupTokenCookie,
} from '@/lib/sandboxes/connector-setup-token';

describe('connector setup token handoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses a short-lived HttpOnly cookie scoped to one sandbox detail page', async () => {
    await setConnectorSetupTokenCookie('my workspace', 'sb_1', 'mcpcon_secret');

    expect(mocks.set).toHaveBeenCalledWith(
      'toolplane_connector_setup_sb_1',
      'mcpcon_secret',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 180,
        path: '/app/my%20workspace/sandboxes/sb_1',
      }),
    );
  });

  it('reads only the sandbox-specific cookie', async () => {
    mocks.get.mockReturnValue({ value: 'mcpcon_secret' });

    await expect(readConnectorSetupTokenCookie('sb_1')).resolves.toBe('mcpcon_secret');
    expect(mocks.get).toHaveBeenCalledWith('toolplane_connector_setup_sb_1');
  });
});
