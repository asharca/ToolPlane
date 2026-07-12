import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';

describe('entity cards', () => {
  it('ServerCard renders name, description, author, link and star count', () => {
    const { container } = render(
      <ServerCard
        server={{
          slug: 'firecrawl',
          name: 'Firecrawl',
          description: 'Web scraping for LLMs',
          author: 'mendableai',
          iconUrl: 'https://example.com/firecrawl.png',
          stars: 1500,
          categories: [{ name: 'Web Scraping' }],
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /Firecrawl/ })).toHaveAttribute(
      'href',
      '/server/firecrawl',
    );
    expect(screen.getByText('Firecrawl')).toBeInTheDocument();
    expect(screen.getByText('Web scraping for LLMs')).toBeInTheDocument();
    expect(screen.getByText('Web Scraping')).toBeInTheDocument();
    expect(screen.getByText('1.5k')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Stars: 1,500/ })).toBeInTheDocument();

    const icon = container.querySelector('img');
    expect(icon).toHaveAttribute('alt', '');
    expect(icon).toHaveAttribute('width', '32');
    expect(icon).toHaveAttribute('height', '32');
    expect(icon).toHaveAttribute('loading', 'lazy');
    expect(icon).toHaveAttribute('decoding', 'async');
    expect(icon).toHaveClass('size-8');
    expect(icon).not.toHaveClass('grayscale', 'opacity-50');
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
    expect(screen.getByRole('link', { name: /Score: 42/ })).toBeInTheDocument();
    expect(screen.queryByText('Stars: 42')).not.toBeInTheDocument();
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
