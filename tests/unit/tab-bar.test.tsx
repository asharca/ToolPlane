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

    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('aria-current', 'page');
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

    expect(screen.getByRole('link', { name: 'Audit' })).toHaveAttribute(
      'href',
      '/app/acme/observability?deploymentId=dep-123&tab=audit',
    );
  });
});
