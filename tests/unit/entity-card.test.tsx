import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';

describe('entity cards', () => {
  it('ServerCard renders name, description, author, link and star count', () => {
    render(
      <ServerCard
        server={{
          slug: 'firecrawl',
          name: 'Firecrawl',
          description: 'Web scraping for LLMs',
          author: 'mendableai',
          iconUrl: null,
          stars: 1500,
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /Firecrawl/ })).toHaveAttribute(
      'href',
      '/server/firecrawl',
    );
    expect(screen.getByText('Firecrawl')).toBeInTheDocument();
    expect(screen.getByText('Web scraping for LLMs')).toBeInTheDocument();
    expect(screen.getByText('mendableai')).toBeInTheDocument();
    expect(screen.getByText('1.5k')).toBeInTheDocument();
  });

  it('SkillCard links to /tools/skills/{slug} and shows score', () => {
    render(
      <SkillCard
        skill={{
          slug: 'gh-fixer',
          name: 'GH Fixer',
          description: null,
          author: null,
          iconUrl: null,
          score: 42,
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /GH Fixer/ })).toHaveAttribute(
      'href',
      '/tools/skills/gh-fixer',
    );
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('ClientCard links to /client/{slug}', () => {
    render(
      <ClientCard
        client={{
          slug: 'zed',
          name: 'Zed',
          description: 'A code editor',
          author: null,
          iconUrl: null,
          stars: 0,
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /Zed/ })).toHaveAttribute(
      'href',
      '/client/zed',
    );
  });
});
