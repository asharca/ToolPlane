import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/current-user', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
}));

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  it('renders logo, nav, and CTAs when logged out', async () => {
    render(await Header());

    expect(screen.getByRole('link', { name: /MCP\s*Market/ })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByRole('link', { name: 'MCP Servers' })).toHaveAttribute(
      'href',
      '/server',
    );
    expect(screen.getByRole('link', { name: 'Agent Skills' })).toHaveAttribute(
      'href',
      '/tools/skills',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/app/login',
    );
  });
});
