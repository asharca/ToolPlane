import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ pending: false, installMarketResourceAction: vi.fn() }));

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

vi.mock('@/lib/market/actions', () => ({ installMarketResourceAction: mocks.installMarketResourceAction }));
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

  it.each([false, true])('submits the correct installation protocol for community=%s', async (community) => {
    mocks.pending = false;
    mocks.installMarketResourceAction.mockReset();
    const catalogAction = vi.fn();
    render(await BrowseGrid({
      items: [{
        id: 'skill-id', slug: 'safe-skill', name: 'Safe Skill', description: null, iconUrl: null,
        marketListing: community ? { namespace: 'publisher', slug: 'safe-skill', releaseId: 'release-1' } : null,
      }],
      installedIds: new Set<string>(), slug: 'acme', action: catalogAction, idField: 'skillId',
      actionLabel: 'Install', pendingLabel: 'Installing…', installedLabel: 'Installed', detailKind: 'skills',
    }));
    fireEvent.submit(screen.getByRole('button', { name: 'Install' }).closest('form')!);
    const expectedAction = community ? mocks.installMarketResourceAction : catalogAction;
    await waitFor(() => expect(expectedAction).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(expectedAction.mock.calls[0][0])).toEqual(community
      ? { workspace: 'acme', releaseId: 'release-1' }
      : { workspace: 'acme', skillId: 'skill-id' });
    expect(community ? catalogAction : mocks.installMarketResourceAction).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'viewDetails' })).toHaveAttribute('href', community
      ? '/app/acme/market/items/publisher/safe-skill'
      : '/app/acme/market/skills/safe-skill');
  });
});
