import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabBar } from '@/components/dashboard/TabBar';

describe('TabBar', () => {
  it('marks the active route without changing link navigation', () => {

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

    expect(screen.getByRole('tab', { name: 'Tools', selected: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('href', '/app/acme/mcp/dep1?tab=tools');
  });

  it('preserves query filters while switching tabs', () => {
    render(
      <TabBar
        tabs={[
          { key: 'usage', label: 'Usage' },
          { key: 'audit', label: 'Audit' },
        ]}
        current="usage"
        basePath="/app/acme/observability"
        query={{ deploymentId: 'dep-123' }}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Audit', selected: false })).toHaveAttribute(
      'href',
      '/app/acme/observability?deploymentId=dep-123&tab=audit',
    );
  });
});
