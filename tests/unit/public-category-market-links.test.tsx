import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPublicCategory: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/app/(site)/_lib/catalog', () => ({
  getPublicCategory: mocks.getPublicCategory,
}));
vi.mock('@/components/cards/ServerCard', () => ({ ServerCard: () => null }));
vi.mock('@/components/cards/SkillCard', () => ({ SkillCard: () => null }));
vi.mock('@/components/cards/AgentListingCard', () => ({ AgentListingCard: () => null }));

import PublicCategoryPage from '@/app/(site)/categories/[slug]/page';

describe('public category marketplace links', () => {
  it('links every unified resource kind to the public detail route', async () => {
    mocks.getPublicCategory.mockResolvedValue({
      id: 'category-1',
      slug: 'research',
      name: 'Research',
      _count: { servers: 1, skills: 1, agentListings: 0, assistants: 1, toolkits: 1 },
      servers: [],
      skills: [],
      agentListings: [],
      communityMcps: [{
        id: 'mcp-1', namespace: 'acme labs', slug: 'web-search', name: 'Web Search', summary: null,
      }],
      communitySkills: [{
        id: 'skill-1', namespace: 'acme labs', slug: 'source-check', name: 'Source Check', summary: null,
      }],
      assistants: [{
        id: 'assistant-1', namespace: 'acme labs', slug: 'researcher', name: 'Researcher', summary: null,
      }],
      toolkits: [{
        id: 'toolkit-1',
        name: 'Research Kit',
        publisher: 'acme labs',
        href: '/market/acme%20labs/research-kit',
        resourceSummary: null,
        _count: { servers: 1, skills: 1 },
      }],
    });

    render(await PublicCategoryPage({ params: Promise.resolve({ slug: 'research' }) }));

    expect(screen.getByRole('link', { name: /Web Search/ })).toHaveAttribute(
      'href',
      '/market/acme%20labs/web-search',
    );
    expect(screen.getByRole('link', { name: /Source Check/ })).toHaveAttribute(
      'href',
      '/market/acme%20labs/source-check',
    );
    expect(screen.getByRole('link', { name: /Researcher/ })).toHaveAttribute(
      'href',
      '/market/acme%20labs/researcher',
    );
    expect(screen.getByRole('link', { name: /Research Kit/ })).toHaveAttribute(
      'href',
      '/market/acme%20labs/research-kit',
    );
  });
});
