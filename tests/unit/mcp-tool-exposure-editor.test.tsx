import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpToolExposureEditor } from '@/components/dashboard/McpToolExposureEditor';

vi.mock('@/lib/workspace/actions', () => ({
  updateMcpToolExposureAction: vi.fn(),
}));

const tools = [
  { name: 'read', description: 'Read data.' },
  { name: 'write', description: 'Write data.' },
];

describe('McpToolExposureEditor', () => {
  it('defaults to all current and future tools', () => {
    render(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={tools}
        initialMode="all"
        initialAllowedTools={[]}
        running
      />,
    );

    expect(screen.getByRole('radio', { name: /all tools/i })).toBeChecked();
    expect(screen.getByText(/2 of 2 current tools exposed/i)).toBeInTheDocument();
    expect(screen.getByText(/future tools/i)).toBeInTheDocument();
  });

  it('keeps an explicit empty allowlist distinct from all mode', () => {
    render(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={tools}
        initialMode="allowlist"
        initialAllowedTools={[]}
        running
      />,
    );

    expect(screen.getByRole('radio', { name: /selected tools/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /read/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /write/i })).not.toBeChecked();
    expect(screen.getByText(/0 of 2 current tools exposed/i)).toBeInTheDocument();
  });

  it('preserves unavailable allowlisted tool names and lets the user remove them', async () => {
    render(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={tools}
        initialMode="allowlist"
        initialAllowedTools={['read', 'removed-tool']}
        running
      />,
    );

    const stale = screen.getByRole('checkbox', { name: /removed-tool/i });
    expect(stale).toBeChecked();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    await userEvent.click(stale);
    expect(stale).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(stale).not.toBeChecked();
  });

  it('starts selected mode with every current tool when switching from all', async () => {
    const { rerender } = render(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={[tools[0]]}
        initialMode="all"
        initialAllowedTools={[]}
        running
      />,
    );

    rerender(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={tools}
        initialMode="all"
        initialAllowedTools={[]}
        running
      />,
    );

    await userEvent.click(screen.getByRole('radio', { name: /selected tools/i }));
    expect(screen.getByRole('checkbox', { name: /read/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /write/i })).toBeChecked();
  });

  it('shows a read-only policy summary while the MCP is stopped', () => {
    render(
      <McpToolExposureEditor
        workspace="acme"
        deploymentId="dep1"
        tools={[]}
        initialMode="allowlist"
        initialAllowedTools={['read', 'write']}
        running={false}
      />,
    );

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save exposure/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/0 of 0/i)).not.toBeInTheDocument();
  });
});
