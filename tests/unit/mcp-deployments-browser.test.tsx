import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpDeploymentsBrowser } from '@/components/dashboard/McpDeploymentsBrowser';

vi.mock('@/lib/workspace/actions', () => ({
  removeDeploymentsAction: vi.fn(),
  removeDeploymentAction: vi.fn(),
  restartDeploymentAction: vi.fn(),
  startDeploymentsAction: vi.fn(),
  startDeploymentAction: vi.fn(),
  stopDeploymentsAction: vi.fn(),
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
  it('replaces the desktop header with batch actions after selecting deployments', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    const table = screen.getByRole('table');
    const selectMatches = within(table).getByRole('checkbox', { name: 'Select all matching (2)' });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.click(selectMatches);
    const toolbar = within(table).getByRole('toolbar', { name: '2 selected' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveAttribute('colspan', '5');
    expect(within(table).queryByRole('checkbox', { name: 'Select all matching (2)' })).not.toBeInTheDocument();
    const batchForms = [...table.querySelectorAll('form')].filter(
      (form) => new FormData(form).getAll('deploymentId').length === 2,
    );
    expect(batchForms.map((form) => new FormData(form).getAll('deploymentId'))).toEqual([
      ['running-mcp', 'failed-mcp'],
      ['running-mcp', 'failed-mcp'],
      ['running-mcp', 'failed-mcp'],
    ]);
    expect(within(toolbar).getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    await user.click(within(toolbar).getByRole('button', { name: 'Clear selection' }));
    expect(within(table).queryByRole('toolbar')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
    expect(within(table).getByRole('checkbox', { name: 'Select all matching (2)' })).toBeInTheDocument();
  });

  it('preserves desktop row selections while filtering', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    const table = screen.getByRole('table');
    await user.click(within(table).getByRole('checkbox', { name: 'Select Filesystem' }));
    expect(within(table).getByRole('toolbar', { name: '1 selected' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search MCP...'), 'private');
    await user.click(within(table).getByRole('checkbox', { name: 'Select Private API' }));
    expect(within(table).getByRole('toolbar', { name: '2 selected' })).toBeInTheDocument();
  });

  it('opens deployment details from the full identity cell without an Inspect action', () => {
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    const links = screen.getAllByRole('link', { name: /Filesystem/ });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/app/acme/mcp/running-mcp');
    expect(links.find((link) => link.closest('table'))?.parentElement).toHaveClass('p-0');
    expect(screen.queryByRole('link', { name: 'Inspect' })).not.toBeInTheDocument();
  });

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
