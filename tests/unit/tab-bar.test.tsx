import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabBar } from '@/components/dashboard/TabBar';

describe('TabBar', () => {
  it('marks and scrolls the active tab into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <TabBar
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'configuration', label: 'Configuration' },
          { key: 'variables', label: 'Variables' },
          { key: 'tools', label: 'Tools' },
        ]}
        current="tools"
        basePath="/app/acme/mcp/dep1"
      />,
    );

    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('aria-current', 'page');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' });
  });
});
