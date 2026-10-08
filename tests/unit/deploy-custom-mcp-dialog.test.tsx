import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

const dockerConfig = {
  dockerExample: {
    command: 'docker',
    args: ['run', '-i', '--rm', 'ghcr.io/acme/stdio-mcp:latest', 'node', 'server.mjs'],
  },
};

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: /add.*mcp/i }));
}

describe('DeployCustomMcpDialog', () => {
  it('can open directly from a create handoff', () => {
    render(<DeployCustomMcpDialog slug="acme" defaultOpen />);

    expect(screen.getByRole('dialog', { name: 'Deploy custom MCP' })).toBeInTheDocument();
  });

  it('creates only JSON MCPs and fixes the submitted source to config', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();

    expect(screen.getByLabelText('MCP JSON config')).toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>('input[name="source"]')).toHaveValue('config');
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('npm Package')).not.toBeInTheDocument();
    expect(screen.queryByText('PyPI Package')).not.toBeInTheDocument();
    expect(screen.queryByText('Docker Image')).not.toBeInTheDocument();
    expect(screen.queryByText('Start Command')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server Name')).not.toBeInTheDocument();
  });

  it('updates network-specific guidance when toggled and after JSON changes', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: /^Network mode:/ }));

    const none = screen.getByRole('radio', { name: /no network/i });
    expect(screen.getByText(/127\.0\.0\.1 and localhost point to the MCP container/i)).toBeInTheDocument();

    await userEvent.click(none);
    expect(none).toBeChecked();
    expect(screen.getByText(/may fail to install or start/i)).toBeInTheDocument();

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify(dockerConfig));
    expect(screen.queryByText(/may fail to install or start/i)).not.toBeInTheDocument();
  });

  it('accepts a JSON config and derives the server name from its outer key', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({
      fetcher: { command: 'npx', args: ['-y', 'fetch-mcp'], network: 'none' },
    }));
    expect(screen.getByText('fetcher')).toBeInTheDocument();
    const form = config.closest('form')!;
    expect(new FormData(form).get('network')).toBe('none');
    await userEvent.click(screen.getByRole('button', { name: /^Network mode:/ }));
    expect(screen.getByRole('radio', { name: /no network/i })).toBeChecked();
  });

  it('keeps examples collapsed and loads generic Git, uv, and Docker templates into the JSON field', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();

    const examplesTrigger = screen.getByRole('button', { name: 'Examples' });
    expect(examplesTrigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(examplesTrigger);
    const examples = screen.getByRole('region', { name: 'Examples' });
    expect(screen.getByText('npx + configuration file')).toBeInTheDocument();
    expect(screen.getByText('npx + Git repository')).toBeInTheDocument();
    expect(screen.getByText('uvx + Git repository')).toBeInTheDocument();
    expect(screen.getByText('uv + package command')).toBeInTheDocument();
    expect(screen.getByText('Docker + container image')).toBeInTheDocument();
    expect(screen.getByText('Remote HTTP MCP')).toBeInTheDocument();
    expect(screen.getByText(/Use a public Git HTTPS URL such as git\+https:\/\/<host>/i)).toBeInTheDocument();

    const exampleButtons = within(examples!).getAllByRole('button', { name: 'Use example' });
    await userEvent.click(exampleButtons[0]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value).toContain('ssh-config.json');

    await userEvent.click(exampleButtons[1]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value)
      .toContain('git+https://git.example.com/group/repository.git#v1.0.0');

    await userEvent.click(exampleButtons[2]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value)
      .toContain('git+https://git.example.com/group/repository.git@v1.0.0');

    await userEvent.click(exampleButtons[3]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value).toContain('"command": "uv"');
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value).toContain('your-mcp-package');
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value).toContain('mcp-config.toml');

    await userEvent.click(exampleButtons[4]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value)
      .toContain('registry.example.com/organization/mcp-server:latest');
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value)
      .toContain('/toolplane/config/mcp-config.json');

    await userEvent.click(exampleButtons[5]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP JSON config').value)
      .toContain('"type": "http"');
  });

  it('recognizes remote HTTP MCPs and hides local-only controls', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({
      mcpServers: {
        audit: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer test-token' },
        },
      },
    }));

    expect(screen.getByText('audit')).toBeInTheDocument();
    expect(screen.queryByText('Configuration files (optional)')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /isolated/i })).not.toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>('input[name="runtimeFiles"]')).toHaveValue('[]');
  });

  it('warns about HTTP credentials and upstream traffic before deployment, not HTTPS', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();
    const config = screen.getByLabelText('MCP JSON config');
    const remote = (url: string) => JSON.stringify({
      mcpServers: { audit: { type: 'http', url, headers: { Authorization: 'Bearer test-token' } } },
    });
    await userEvent.click(config);
    await userEvent.paste(remote('http://mcp.example.com:8000/mcp'));

    const notice = screen.getByTestId('remote-mcp-transport-notice');
    expect(within(notice).getByRole('alert')).toBeInTheDocument();
    expect(within(notice).getByText('Unencrypted HTTP connection')).toBeInTheDocument();
    expect(within(notice).getByText(/Bearer tokens.*intercepted or modified/i)).toBeInTheDocument();
    expect(within(notice).getByText(/internal network is not automatically safe/i)).toBeInTheDocument();
    expect(within(notice).getByText(/website does not protect this upstream HTTP connection/i)).toBeInTheDocument();
    expect(notice).not.toHaveTextContent('test-token');
    expect(screen.getByRole('button', { name: 'Deploy MCP' })).toBeEnabled();

    await userEvent.clear(config);
    await userEvent.paste(remote('https://mcp.example.com:8443/mcp'));
    expect(screen.queryByText('Unencrypted HTTP connection')).not.toBeInTheDocument();
    expect(screen.getByTestId('remote-mcp-transport-notice')).toHaveTextContent('HTTPS (recommended)');
  });

  it('keeps optional runtime files collapsed, submits them, and updates file path guidance by command', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();

    const runtimeFilesTrigger = screen.getByRole('button', { name: 'Configuration files (optional)' });
    expect(runtimeFilesTrigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(runtimeFilesTrigger);
    expect(screen.getByRole('heading', { name: 'Runtime files' })).toBeInTheDocument();
    expect(screen.getByText(/relative file names work from that directory/i)).toBeInTheDocument();
    expect(screen.getByText(/requires an absolute path/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add file' }));
    await userEvent.type(screen.getByLabelText('Relative file path'), 'ssh-config.json');
    await userEvent.click(screen.getByLabelText('Text content'));
    await userEvent.paste('[{"name":"dev"}]');

    const filesInput = document.querySelector<HTMLInputElement>('input[name="runtimeFiles"]');
    expect(filesInput).toHaveValue(JSON.stringify([
      { path: 'ssh-config.json', content: '[{"name":"dev"}]' },
    ]));

    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.clear(config);
    await userEvent.paste(JSON.stringify(dockerConfig));
    expect(screen.queryByText(/relative file names work from that directory/i)).not.toBeInTheDocument();
    expect(screen.getByText(/requires an absolute path/i)).toBeInTheDocument();
  });


  it('shows the specific validation error for unsupported JSON commands', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();
    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({ unsafe: { command: 'bash', args: ['-lc', 'whoami'] } }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy MCP' }));

    expect(screen.getByText('command must be npx, uvx, uv, or docker.')).toBeInTheDocument();
  });

  it('shows a specific safe validation error for an invalid remote URL', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await openDialog();
    const config = screen.getByLabelText('MCP JSON config');
    await userEvent.click(config);
    await userEvent.paste(JSON.stringify({
      mcpServers: {
        audit: {
          type: 'http',
          url: '[https://mcp.example.com/mcp](https://mcp.example.com/mcp)',
          headers: { Authorization: 'Bearer test-token' },
        },
      },
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy MCP' }));

    expect(screen.getByText(/remote HTTP MCP url must be an allowed HTTP or HTTPS URL/i)).toBeInTheDocument();
    expect(screen.queryByText('test-token')).not.toBeInTheDocument();
  });
});
