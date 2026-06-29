import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const en = (await import('../../messages/en.json')).default as Record<string, unknown>;
  function getNs(ns: string): Record<string, string> {
    let obj: unknown = en;
    for (const part of ns.split('.')) obj = (obj as Record<string, unknown>)[part];
    return obj as Record<string, string>;
  }
  return { useTranslations: (ns: string) => (k: string) => getNs(ns)[k] ?? k, useLocale: () => 'en' };
});

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
