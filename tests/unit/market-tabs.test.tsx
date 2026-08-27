import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketTabs } from '@/components/dashboard/MarketTabs';

const mocks = vi.hoisted(() => ({ pathname: '/app/acme/market/toolkits' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
}));

describe('MarketTabs', () => {
  beforeEach(() => {
    mocks.pathname = '/app/acme/market/toolkits';
  });

  it('links the overview and canonical market sections', () => {
    render(<MarketTabs slug="acme" />);

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Overview',
      'MCP',
      'Skills',
      'Agents',
      'Toolkits',
    ]);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/app/acme/market',
    );
    expect(screen.getByRole('link', { name: 'Toolkits' })).toHaveAttribute(
      'href',
      '/app/acme/market/toolkits',
    );
    expect(screen.getByRole('link', { name: 'Toolkits' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks only the overview active on the market root', () => {
    mocks.pathname = '/app/acme/market';
    render(<MarketTabs slug="acme" />);

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'MCP' })).not.toHaveAttribute('aria-current');
  });
});
