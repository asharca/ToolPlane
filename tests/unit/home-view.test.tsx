import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

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
  it('renders the hero and all six sections with their cards', () => {
    render(<HomeView {...data} />);

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();

    for (const heading of [
      'Official MCP Servers',
      'Featured MCP Servers',
      'Top MCP Servers',
      'Latest MCP Servers',
      'MCP Clients',
      'Top Agent Skills',
    ]) {
      expect(
        screen.getByRole('heading', { name: heading }),
      ).toBeInTheDocument();
    }

    expect(screen.getByText('Official One')).toBeInTheDocument();
    expect(screen.getByText('Client One')).toBeInTheDocument();
    expect(screen.getByText('Skill One')).toBeInTheDocument();
  });
});
