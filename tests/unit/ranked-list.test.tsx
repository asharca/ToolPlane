import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

import { RankedList } from '@/components/RankedList';

describe('RankedList', () => {
  it('renders decorative, lazy-loaded icons and labels the score', async () => {
    const view = await RankedList({
      title: 'Top skills',
      subtitle: 'Ranked by score',
      items: [
        {
          slug: 'gh-fixer',
          name: 'GH Fixer',
          author: 'ToolPlane',
          iconUrl: 'https://example.com/gh-fixer.png',
          href: '/tools/skills/gh-fixer',
          stat: 1250,
        },
      ],
    });
    const { container } = render(view);

    expect(screen.getByRole('link', { name: /Score: 1,250/ })).toHaveAttribute(
      'href',
      '/tools/skills/gh-fixer',
    );

    const icon = container.querySelector('img');
    expect(icon).toHaveAttribute('alt', '');
    expect(icon).toHaveAttribute('width', '32');
    expect(icon).toHaveAttribute('height', '32');
    expect(icon).toHaveAttribute('loading', 'lazy');
    expect(icon).toHaveAttribute('decoding', 'async');
    expect(icon).toHaveClass('size-8');
  });
});
