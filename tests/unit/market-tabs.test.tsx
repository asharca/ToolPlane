import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarketTabs } from '@/components/dashboard/MarketTabs';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/acme/market/toolkits',
}));

describe('MarketTabs', () => {
  it('exposes toolkits as the fourth canonical market section', () => {
    render(<MarketTabs slug="acme" />);

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'MCP',
      'Skills',
      'Agents',
      'Toolkits',
    ]);
    expect(screen.getByRole('link', { name: 'Toolkits' })).toHaveAttribute(
      'href',
      '/app/acme/market/toolkits',
    );
    expect(screen.getByRole('link', { name: 'Toolkits' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
