import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

describe('DeployCustomMcpDialog', () => {
  it('switches the package field label per source and shows Start Command only for Docker', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    expect(screen.getByText('npm Package')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('GitHub Repository')).toBeInTheDocument();
    expect(screen.queryByText('Start Command')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Docker' }));
    expect(screen.getByText('Docker Image')).toBeInTheDocument();
    expect(screen.getByText('Start Command')).toBeInTheDocument();
  });

  it('defaults to isolated networking and exposes a fully offline mode', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));

    const isolated = screen.getByRole('radio', { name: /isolated/i });
    const none = screen.getByRole('radio', { name: /no network/i });
    expect(isolated).toBeChecked();

    await userEvent.click(none);
    expect(none).toBeChecked();
    expect(screen.getByText(/may fail to install or start/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Docker' }));
    expect(screen.queryByText(/may fail to install or start/i)).not.toBeInTheDocument();
  });

  it('accepts a JSON config and derives the server name from its outer key', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }));

    expect(screen.getByLabelText('MCP JSON config')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server Name')).not.toBeInTheDocument();

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({
      fetcher: { command: 'npx', args: ['-y', 'fetch-mcp'], network: 'none' },
    }));
    expect(screen.getByText('/acme/mcp/fetcher')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /no network/i })).toBeChecked();
  });

  it('shows a validation error for unsupported JSON commands', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({ unsafe: { command: 'bash', args: ['-lc', 'whoami'] } }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy MCP' }));

    expect(screen.getByText(/valid MCP configuration for this source/i)).toBeInTheDocument();
  });
});
