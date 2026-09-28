import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', async () => {
  const en = (await import('../../messages/en.json')).default as Record<string, unknown>;
  function getNs(ns: string): Record<string, string> {
    let obj: unknown = en;
    for (const part of ns.split('.')) obj = (obj as Record<string, unknown>)[part];
    return obj as Record<string, string>;
  }
  return { useTranslations: (ns: string) => (k: string) => getNs(ns)[k] ?? k, useLocale: () => 'en' };
});

// jsdom has no WebGL; shader rendering is verified in the browser.
vi.mock('@/components/motion/shader-background', () => ({ ShaderBackground: () => null }));

import { HomeView } from '@/components/home/HomeView';
import type { HomeSections } from '@/lib/queries/home';

const srv = (slug: string, name: string) => ({
  slug,
  name,
  description: null,
  author: null,
  iconUrl: null,
  stars: 0,
});
const skl = (slug: string, name: string) => ({
  slug,
  name,
  description: null,
  author: null,
  iconUrl: null,
  score: 0,
});

const data = {
  officialServers: [srv('off-1', 'Official One')],
  featuredServers: [srv('feat-1', 'Featured One')],
  topServers: [srv('top-1', 'Top One')],
  latestServers: [srv('late-1', 'Latest One')],
  clients: [srv('cli-1', 'Client One')],
  topSkills: [skl('skl-1', 'Skill One')],
} as unknown as HomeSections;

describe('HomeView', () => {
  it('switches collections while preserving public resource links', async () => {
    const user = userEvent.setup();
    render(<HomeView {...data} categories={[]} serverCount={783} />);

    for (const [tab, name, href] of [
      ['Official', 'Official One', '/server/off-1'],
      ['Featured', 'Featured One', '/server/feat-1'],
      ['Popular', 'Top One', '/server/top-1'],
      ['Latest', 'Latest One', '/server/late-1'],
      ['Agent Skills', 'Skill One', '/tools/skills/skl-1'],
      ['MCP Clients', 'Client One', '/client/cli-1'],
    ]) {
      await user.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await waitFor(() => expect(screen.getByRole('heading', { name })).toBeVisible());
      expect(screen.getByRole('link', { name: `Explore: ${name}` })).toHaveAttribute('href', href);
    }
    expect(screen.getByText('Official One')).not.toBeVisible();
  });

  it('keeps unauthenticated search, category browsing, and workspace entry accessible', async () => {
    const user = userEvent.setup();
    render(<HomeView {...data} categories={[{ slug: 'developer-tools', name: 'Developer Tools' }]} serverCount={783} />);

    expect(screen.getByRole('link', { name: /Open workspace/ })).toHaveAttribute('href', '/app');
    expect(screen.getByRole('link', { name: /Explore the catalog/ })).toHaveAttribute('href', '#discover');
    expect(screen.getByRole('link', { name: 'Developer Tools' })).toHaveAttribute('href', '/categories/developer-tools');
    const form = screen.getByRole('search') as HTMLFormElement;
    await user.type(screen.getByRole('searchbox'), 'file system & tools');
    expect(form).toHaveAttribute('action', '/search');
    expect(form).toHaveAttribute('method', 'get');
    expect(new FormData(form).get('q')).toBe('file system & tools');
    expect(screen.getByRole('button', { name: 'Search for MCP servers' })).toHaveAttribute('type', 'submit');
  });

  it('opens the first populated collection and explains empty collections', async () => {
    const user = userEvent.setup();
    render(<HomeView {...data} officialServers={[]} featuredServers={[]} topServers={[]} latestServers={[]} categories={[]} serverCount={0} />);

    expect(screen.getByRole('tab', { name: 'Agent Skills' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Skill One' })).toBeVisible());
    await user.click(screen.getByRole('tab', { name: 'Official' }));
    await waitFor(() => expect(screen.getAllByRole('paragraph').find((element) => element.textContent === 'Nothing here yet. Explore another collection or check back soon.')).toBeVisible());
    expect(screen.queryByRole('link', { name: 'Explore: Official One' })).not.toBeInTheDocument();
  });
});
