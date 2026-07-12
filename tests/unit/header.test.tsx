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
  const en = (await import('../../messages/en.json')).default as Record<string, unknown>;
  function getNs(ns: string): Record<string, string> {
    let obj: unknown = en;
    for (const part of ns.split('.')) obj = (obj as Record<string, unknown>)[part];
    return obj as Record<string, string>;
  }
  return { getTranslations: (ns: string) => Promise.resolve((k: string) => getNs(ns)[k] ?? k) };
});

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  it('renders desktop and mobile navigation with a stable console entry', async () => {
    render(await Header());

    expect(screen.getByRole('link', { name: /ToolPlane/ })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      screen
        .getAllByRole('link', { name: 'MCP Servers' })
        .every((link) => link.getAttribute('href') === '/server'),
    ).toBe(true);
    expect(
      screen
        .getAllByRole('link', { name: 'Agent Skills' })
        .every((link) => link.getAttribute('href') === '/tools/skills'),
    ).toBe(true);
    expect(
      screen
        .getAllByRole('link', { name: 'Dashboard' })
        .every((link) => link.getAttribute('href') === '/app'),
    ).toBe(true);
    expect(document.querySelector('summary[aria-label="Menu"]')).toBeInTheDocument();
  });
});
