import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { server: mocks },
}));

import { setServerVerified } from '@/lib/admin/market';

describe('admin MCP verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueOrThrow.mockResolvedValue({
      installCfg: { source: 'npm', ref: '@acme/mcp', env: [] },
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('only marks a server verified with an exact, schema-complete catalog snapshot', async () => {
    await expect(setServerVerified('server-1', 1, [{ name: 'search' }]))
      .rejects.toThrow(/complete tool catalog/i);
    await expect(setServerVerified('server-1', 2, [{
      name: 'search',
      inputSchema: { type: 'object' },
    }])).rejects.toThrow(/complete tool catalog/i);
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled();

    await expect(setServerVerified('server-1', 0, [])).resolves.toBeUndefined();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        verifiedTools: 0,
        installCfg: expect.objectContaining({ toolCatalog: [] }),
      }),
    }));
  });
});
