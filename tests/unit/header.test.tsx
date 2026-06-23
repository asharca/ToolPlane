import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));

vi.mock('@/lib/auth/current-user', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
}));

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  it('renders logo, nav links, and theme toggle when logged out', async () => {
    render(await Header());

    expect(screen.getByRole('link', { name: 'MCPMarket' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByRole('link', { name: 'Sell Skills' })).toHaveAttribute(
      'href',
      '/sell',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute(
      'href',
      '/hub',
    );
    expect(
      screen.getByRole('button', { name: /toggle theme/i }),
    ).toBeInTheDocument();
  });
});
