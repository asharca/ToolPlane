import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpJsonConfigEditor } from '@/components/dashboard/McpJsonConfigEditor';

const mocks = vi.hoisted(() => ({
  revealMcpJsonConfigAction: vi.fn(),
}));

vi.mock('@/lib/workspace/actions', () => ({
  revealMcpJsonConfigAction: mocks.revealMcpJsonConfigAction,
  updateMcpJsonConfigAction: vi.fn(),
}));

describe('McpJsonConfigEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the stored config and a save-and-rebuild action', () => {
    const initialConfig = JSON.stringify({
      command: 'npx',
      args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '22'],
    }, null, 2);

    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={initialConfig}
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall
      />,
    );

    expect(screen.getByLabelText('MCP JSON config')).toHaveValue(initialConfig);
    expect(screen.getByRole('radio', { name: /isolated/i })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save and rebuild' })).toBeInTheDocument();
  });

  it('allows the runtime network mode to be changed independently of JSON', () => {
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={JSON.stringify({ source: 'npm', ref: 'pkg' })}
        requiresReveal={false}
        initialNetwork="none"
        warnAboutPackageInstall
      />,
    );

    const none = screen.getByRole('radio', { name: /no network/i });
    const isolated = screen.getByRole('radio', { name: /isolated/i });
    expect(none).toBeChecked();
    fireEvent.click(isolated);
    expect(isolated).toBeChecked();
  });

  it('fetches credentials only after the user explicitly reveals the editable config', async () => {
    const initialConfig = JSON.stringify({
      command: 'npx',
      args: ['ssh-mcp-server', '--password', 'secret'],
      env: { SSH_TOKEN: 'token-value' },
    }, null, 2);
    const maskedConfig = initialConfig
      .replace('secret', '********')
      .replace('token-value', '********');
    mocks.revealMcpJsonConfigAction.mockResolvedValue({ config: initialConfig });

    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={maskedConfig}
        requiresReveal
        initialNetwork="none"
        warnAboutPackageInstall
      />,
    );

    expect(screen.getByLabelText('MCP JSON config')).toHaveTextContent('********');
    expect(screen.queryByDisplayValue(initialConfig)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save and rebuild' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal sensitive values and edit' }));

    await waitFor(() => expect(screen.getByLabelText('MCP JSON config')).toHaveValue(initialConfig));
    expect(mocks.revealMcpJsonConfigAction).toHaveBeenCalledWith({
      workspace: 'acme',
      deploymentId: 'dep1',
    });
    expect(screen.getByRole('button', { name: 'Save and rebuild' })).toBeInTheDocument();
  });
});
