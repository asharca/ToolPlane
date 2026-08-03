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

vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en'),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));

import { Footer } from '@/components/layout/Footer';

describe('Footer', () => {
  it('renders product navigation without directory or ranking links', async () => {
    render(await Footer());

    for (const heading of ['Product', 'Resources', 'Workspace']) {
      expect(
        screen.getByRole('heading', { name: heading }),
      ).toBeInTheDocument();
    }

    expect(screen.getByRole('link', { name: 'MCP runtime' })).toHaveAttribute(
      'href',
      '/server',
    );
    expect(screen.getByRole('link', { name: 'Open console' })).toHaveAttribute(
      'href',
      '/app',
    );
    expect(screen.queryByRole('link', { name: 'Categories' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Top 100/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Privacy' })[0]).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});
