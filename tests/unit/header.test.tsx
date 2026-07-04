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

vi.mock('@/lib/auth/current-user', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
}));

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  it('renders logo, nav, and CTAs when logged out', async () => {
    render(await Header());

    expect(screen.getByRole('link', { name: /ToolPlane/ })).toHaveAttribute(
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
