import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('not found'); }),
}));
vi.mock('@/app/(site)/_lib/catalog', () => ({
  getPublicAgentListing: vi.fn().mockResolvedValue({
    listing: {
      directorySlug: 'research-agent',
      name: 'Research Agent',
      author: 'Acme',
      summary: 'Finds reliable sources.',
      iconUrl: null,
      installCount: 12,
    },
    workspace: { name: 'Acme' },
    release: {
      version: 1,
      summary: { resourceCount: 2, subAgentCount: 0 },
    },
  }),
}));

import PublicAgentDetailPage from '@/app/(site)/agents/[...segments]/page';

describe('public agent detail intent', () => {
  it('keeps the directory identity in the console CTA', async () => {
    render(await PublicAgentDetailPage({
      params: Promise.resolve({ segments: ['acme', 'research-agent'] }),
    }));

    expect(screen.getByRole('link', { name: 'addAgent' })).toHaveAttribute(
      'href',
      '/app?agent=research-agent',
    );
  });
});
