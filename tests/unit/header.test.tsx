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

vi.mock('next-intl/server', async () => {
  return { getLocale: () => Promise.resolve('en') };
});

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  it('renders desktop and mobile navigation with a stable console entry', async () => {
    render(await Header());

    expect(screen.getByRole('link', { name: /ToolPlane/ })).toHaveAttribute(
      'href',
      '/',
    );
    for (const [name, href] of [
      ['MCP runtime', '/server'],
      ['Skills', '/tools/skills'],
      ['Agents', '/agents'],
      ['Integrations', '/client'],
      ['Open console', '/app'],
    ]) {
      expect(
        screen
          .getAllByRole('link', { name })
          .every((link) => link.getAttribute('href') === href),
      ).toBe(true);
    }
    expect(document.querySelector('summary[aria-label="Menu"]')).toBeInTheDocument();
  });
});
