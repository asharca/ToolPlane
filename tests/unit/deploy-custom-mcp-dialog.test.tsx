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

  it('accepts a JSON config and derives the server name from its outer key', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }));

    expect(screen.getByLabelText('MCP JSON config')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server Name')).not.toBeInTheDocument();

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({ fetcher: { command: 'npx', args: ['-y', 'fetch-mcp'] } }));
    expect(screen.getByText('/acme/mcp/fetcher')).toBeInTheDocument();
  });

  it('shows a validation error for unsupported JSON commands', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({ unsafe: { command: 'bash', args: ['-lc', 'whoami'] } }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy MCP' }));

    expect(screen.getByText(/command must be npx or uvx/i)).toBeInTheDocument();
  });
});
