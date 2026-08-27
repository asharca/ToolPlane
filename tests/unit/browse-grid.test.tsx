import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ pending: false }));

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return {
    ...actual,
    useFormStatus: () => ({
      pending: mocks.pending,
      data: null,
      method: null,
      action: null,
    }),
  };
});

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

import { BrowseGrid } from '@/components/dashboard/BrowseGrid';

describe('BrowseGrid', () => {
  it('links cards to the authenticated workspace market detail', async () => {
    mocks.pending = false;
    const ui = await BrowseGrid({
      items: [{
        id: 'skill-id',
        slug: 'safe-skill',
        name: 'Safe Skill',
        description: 'A curated skill',
        iconUrl: null,
        author: 'ToolPlane',
        githubSource: 'https://github.com/example/safe-skill',
        curated: true,
        categories: [{ name: 'Safety', slug: 'safety' }],
      }],
      installedIds: new Set(['skill-id']),
      slug: 'acme team',
      action: vi.fn(),
      idField: 'skillId',
      actionLabel: 'Install',
      pendingLabel: 'Installing…',
      installedLabel: 'Installed',
      detailKind: 'skills',
    });
    render(ui);

    expect(screen.getByRole('link', { name: 'Safe Skill' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/skills/safe-skill',
    );
    expect(screen.getByText('ToolPlane')).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('Safety')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'viewDetails' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/skills/safe-skill',
    );
    expect(screen.getByText('Installed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('disables the install action and shows progress while pending', async () => {
    mocks.pending = true;
    const ui = await BrowseGrid({
      items: [{
        id: 'skill-id',
        slug: 'safe-skill',
        name: 'Safe Skill',
        description: 'A curated skill',
        iconUrl: null,
      }],
      installedIds: new Set<string>(),
      slug: 'acme',
      action: vi.fn(),
      idField: 'skillId',
      actionLabel: 'Install',
      pendingLabel: 'Installing…',
      installedLabel: 'Installed',
      detailKind: 'skills',
    });
    render(ui);

    expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Installing…' })).toHaveAttribute('aria-busy', 'true');
  });
});
