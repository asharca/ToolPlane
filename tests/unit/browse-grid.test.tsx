import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

import { BrowseGrid } from '@/components/dashboard/BrowseGrid';

describe('BrowseGrid', () => {
  it('links cards to the authenticated workspace market detail', async () => {
    const ui = await BrowseGrid({
      items: [{
        id: 'skill-id',
        slug: 'safe-skill',
        name: 'Safe Skill',
        description: 'A curated skill',
        iconUrl: null,
      }],
      installedIds: new Set<string>(),
      slug: 'acme team',
      action: vi.fn(),
      idField: 'skillId',
      actionLabel: 'Install',
      installedLabel: 'Installed',
      detailKind: 'skills',
    });
    render(ui);

    expect(screen.getByRole('link', { name: 'Safe Skill' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/skills/safe-skill',
    );
  });
});
