import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpDeploymentsBrowser } from '@/components/dashboard/McpDeploymentsBrowser';

vi.mock('@/lib/workspace/actions', () => ({
  removeDeploymentAction: vi.fn(),
  restartDeploymentAction: vi.fn(),
  startDeploymentAction: vi.fn(),
  stopDeploymentAction: vi.fn(),
}));

const deployments = [
  {
    id: 'running-mcp',
    name: 'Filesystem',
    source: 'catalog',
    reference: 'filesystem',
    status: 'running',
    createdAt: 'Aug 12, 2026',
    iconUrl: null,
  },
  {
    id: 'failed-mcp',
    name: 'Private API',
    source: 'config',
    reference: '@acme/private-api-mcp',
    status: 'error',
    createdAt: 'Aug 11, 2026',
    iconUrl: null,
  },
];

describe('McpDeploymentsBrowser', () => {
  it('filters deployments by text and live status without leaving the page', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    expect(screen.getByText('Servers deployed to this workspace: 2.')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search MCP...'), 'private');
    expect(screen.getByText('Servers deployed to this workspace: 1.')).toBeInTheDocument();
    expect(screen.queryByText('Filesystem')).not.toBeInTheDocument();
    expect(screen.getAllByText('Private API')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^error \(1\)$/i }));
    expect(screen.getAllByText('Private API')).toHaveLength(2);

    await user.clear(screen.getByPlaceholderText('Search MCP...'));
    await user.click(screen.getByRole('button', { name: /^all \(2\)$/i }));
    expect(screen.getByText('Servers deployed to this workspace: 2.')).toBeInTheDocument();
  });

  it('keeps lifecycle actions aligned with the deployment detail page', () => {
    render(
      <McpDeploymentsBrowser
        slug="acme"
        deployments={[
          {
            id: 'starting-mcp',
            name: 'Starting MCP',
            source: 'catalog',
            reference: null,
            status: 'provisioning',
            createdAt: 'Aug 12, 2026',
            iconUrl: null,
          },
          {
            id: 'needs-config',
            name: 'Needs configuration',
            source: 'catalog',
            reference: null,
            status: 'setup_required',
            createdAt: 'Aug 12, 2026',
            iconUrl: null,
          },
        ]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Variables' }))
      .toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Variables' })[0])
      .toHaveAttribute('href', '/app/acme/mcp/needs-config?tab=variables');
  });
});
