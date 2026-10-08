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
  it('paginates deployments, resets search, and clamps the page after removals', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 21 }, (_, index) => ({ ...deployments[0], id: `mcp-${index}`, name: `Server ${index}` }));
    const { rerender } = render(<McpDeploymentsBrowser slug="acme" deployments={items} />);
    const pagination = within(screen.getByRole('navigation', { name: 'Pagination' }));
    expect(pagination.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Server 20 filesystem' })).not.toBeInTheDocument();
    await user.click(pagination.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: /Server 20/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Server 0 filesystem/ })).not.toBeInTheDocument();
    expect(pagination.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('Search MCP...'), 'Server 0');
    expect(screen.getByRole('link', { name: /Server 0/ })).toBeInTheDocument();
    expect(pagination.getByText('1 / 1')).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Search MCP...'));
    expect(pagination.getByText('1 / 2')).toBeInTheDocument();
    await user.click(pagination.getByRole('button', { name: 'Next' }));
    rerender(<McpDeploymentsBrowser slug="acme" deployments={items.slice(0, 1)} />);
    expect(screen.getByRole('link', { name: /Server 0/ })).toBeInTheDocument();
    expect(pagination.getByText('1 / 1')).toBeInTheDocument();
    rerender(<McpDeploymentsBrowser slug="acme" deployments={[]} />);
    expect(pagination.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(pagination.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('shows batch actions for selected deployments and clears their successful form values', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    const table = screen.getByRole('table');
    const selectMatches = within(table).getByRole('checkbox', { name: 'Select all rows' });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.click(selectMatches);
    const toolbar = screen.getAllByRole('toolbar', { name: '2 selected' }).at(-1)!;
    const batchForms = [...toolbar.querySelectorAll('form')].filter(
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
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(within(table).getByRole('checkbox', { name: 'Select all rows' })).not.toBeChecked();
  });

  it('preserves desktop row selections while filtering', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    await user.click(within(await screen.findByRole('row', { name: /Filesystem/ })).getByRole('checkbox'));
    expect(screen.getAllByRole('toolbar', { name: '1 selected' }).at(-1)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search MCP...'), 'private');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('row', { name: /Private API/ })).getByRole('checkbox'));
    expect(screen.getByRole('toolbar', { name: '1 selected' })).toBeInTheDocument();
    const toolbar = screen.getByRole('toolbar');
    expect(new FormData(toolbar.querySelector('form')!).getAll('deploymentId')).toEqual(['failed-mcp']);
    await user.clear(screen.getByPlaceholderText('Search MCP...'));
    expect(screen.getByRole('toolbar', { name: '2 selected' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Search MCP...'), 'private');
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    await user.clear(screen.getByPlaceholderText('Search MCP...'));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Filesystem/ })).getByRole('checkbox')).not.toBeChecked();
  });

  it('opens deployment details from the identity cell', async () => {
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);
    const link = await within(screen.getByRole('table')).findByRole('link', { name: /Filesystem/ });
    expect(link).toHaveAttribute('href', '/app/acme/mcp/running-mcp');
  });

  it('filters deployments by text and live status without leaving the page', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);

    expect(screen.getByText('Servers deployed to this workspace: 2.')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search MCP...'), 'private');
    expect(screen.getByText('Servers deployed to this workspace: 1.')).toBeInTheDocument();
    expect(screen.queryByText('Filesystem')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: /^error \(1\)$/i }));

    await user.clear(screen.getByPlaceholderText('Search MCP...'));
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: /^all \(2\)$/i }));
    expect(screen.getByText('Servers deployed to this workspace: 2.')).toBeInTheDocument();
  });

  it('keeps lifecycle actions aligned with the deployment detail page', async () => {
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

    const table = within(screen.getByRole('table'));
    expect(await table.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(await table.findByRole('link', { name: 'Variables' }))
      .toHaveAttribute('href', '/app/acme/mcp/needs-config?tab=variables');
    expect(table.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('filters resources requiring configuration and preserves their configuration link', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={[...deployments, { ...deployments[0], id: 'setup', name: 'Setup MCP', status: 'setup_required' }]} />);
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Needs configuration (1)' }));
    expect(screen.queryByText('Filesystem')).not.toBeInTheDocument();
    expect(screen.queryByText('Private API')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Variables' })).toHaveAttribute('href', '/app/acme/mcp/setup?tab=variables');
  });

  it('reveals secondary actions on demand and requires confirmation before removal', async () => {
    const user = userEvent.setup();
    render(<McpDeploymentsBrowser slug="acme" deployments={deployments} />);
    const table = screen.getByRole('table');
    const trigger = await within(table).findByRole('button', { name: 'Actions: Filesystem' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(screen.getByRole('row', { name: /Filesystem/ })).getByRole('link', { name: 'Logs' })).toHaveAttribute('href', '/app/acme/mcp/running-mcp?tab=logs');
    await user.click(trigger);
    const menu = within(document.getElementById(trigger.getAttribute('aria-controls')!)!);
    expect(menu.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    await user.click(menu.getByRole('button', { name: 'Remove' }));
    expect(menu.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    await user.click(menu.getByRole('button', { name: 'Cancel' }));
    expect(menu.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(menu.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});
