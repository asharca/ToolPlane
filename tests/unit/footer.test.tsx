import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));

import { Footer } from '@/components/layout/Footer';

describe('Footer', () => {
  it('renders all column headings and key links', () => {
    render(<Footer />);

    for (const heading of ['Browse', 'Rankings', 'About']) {
      expect(
        screen.getByRole('heading', { name: heading }),
      ).toBeInTheDocument();
    }

    expect(screen.getByRole('link', { name: 'MCP Servers' })).toHaveAttribute(
      'href',
      '/server',
    );
    expect(screen.getByRole('link', { name: 'Categories' })).toHaveAttribute(
      'href',
      '/categories',
    );
    expect(
      screen.getByRole('link', { name: 'Top 100 MCP Servers' }),
    ).toHaveAttribute('href', '/leaderboards');
    expect(screen.getAllByRole('link', { name: 'Privacy' })[0]).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});
