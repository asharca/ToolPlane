import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Footer } from '@/components/layout/Footer';

describe('Footer', () => {
  it('renders all column headings and key links', () => {
    render(<Footer />);

    for (const heading of ['MCP', 'Browse', 'Rankings', 'About']) {
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
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});
