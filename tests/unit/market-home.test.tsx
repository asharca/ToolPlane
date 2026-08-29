import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import MarketPage from '@/app/app/[workspace]/market/page';

describe('workspace market entry', () => {
  it('opens the MCP directory by default', async () => {
    await MarketPage({
      params: Promise.resolve({ workspace: 'acme team' }),
      searchParams: Promise.resolve({}),
    });

    expect(mocks.redirect).toHaveBeenCalledWith('/app/acme%20team/market/mcp');
  });

  it('keeps legacy kind links working without the discover page', async () => {
    await MarketPage({
      params: Promise.resolve({ workspace: 'acme team' }),
      searchParams: Promise.resolve({ kind: 'assistant', q: 'research', page: '2' }),
    });

    expect(mocks.redirect).toHaveBeenCalledWith(
      '/app/acme%20team/market/assistants?q=research&page=2',
    );
  });
});
