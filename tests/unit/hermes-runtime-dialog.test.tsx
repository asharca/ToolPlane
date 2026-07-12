import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HermesRuntimeDialogLauncher } from '@/components/dashboard/agents/HermesRuntimeDialog';

const sandboxConsoleMocks = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('@/components/dashboard/sandboxes/SandboxConsole', () => ({
  SandboxConsole: (props: Record<string, unknown>) => {
    sandboxConsoleMocks.render(props);
    return <div>Hermes shell test surface</div>;
  },
}));

const runtime = {
  name: 'Research Hermes',
  agentId: 'agent-1',
  deploymentId: 'deployment-1',
  dashboardUrl: '/api/v1/agent-runtimes/runtime-1/dashboard/capability/',
};

describe('HermesRuntimeDialogLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.style.overflow = '';
  });

  it('opens a standalone Web dialog without navigation links', async () => {
    render(<HermesRuntimeDialogLauncher runtime={runtime} />);

    expect(screen.queryByRole('link', { name: 'Open Hermes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Hermes' }));

    const dialog = screen.getByRole('dialog', { name: 'Hermes runtime' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Research Hermes')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Web' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTitle('Hermes runtime dashboard')).toHaveAttribute('src', runtime.dashboardUrl);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('switches between Web and terminal in one stable dialog', async () => {
    render(<HermesRuntimeDialogLauncher runtime={runtime} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Hermes' }));

    const dialog = screen.getByRole('dialog', { name: 'Hermes runtime' });
    const frameClassName = dialog.className;
    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }));

    expect(dialog.className).toBe(frameClassName);
    expect(screen.getByText('Hermes shell test surface')).toBeInTheDocument();
    expect(sandboxConsoleMocks.render).toHaveBeenLastCalledWith(expect.objectContaining({
      deploymentId: 'deployment-1',
      terminalApiBase: '/api/v1/agents/agent-1/terminal',
      terminalOnly: true,
    }));

    await userEvent.click(screen.getByRole('tab', { name: 'Web' }));
    expect(screen.getByTitle('Hermes runtime dashboard')).toBeInTheDocument();
    expect(dialog.className).toBe(frameClassName);
  });

  it('can open the terminal directly and closes with Escape or the backdrop', async () => {
    render(<HermesRuntimeDialogLauncher runtime={runtime} />);
    const terminalTrigger = screen.getByRole('button', { name: 'Open terminal' });
    await userEvent.click(terminalTrigger);

    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Hermes runtime' })).not.toBeInTheDocument();
    await waitFor(() => expect(terminalTrigger).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Open Hermes' }));
    const dialog = screen.getByRole('dialog', { name: 'Hermes runtime' });
    fireEvent.mouseDown(dialog);
    expect(dialog).toBeInTheDocument();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Hermes runtime' })).not.toBeInTheDocument();
  });

  it('accepts an Escape close request from the embedded Hermes dashboard', async () => {
    render(<HermesRuntimeDialogLauncher runtime={runtime} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Hermes' }));

    const iframe = screen.getByTitle('Hermes runtime dashboard') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', {
      data: 'toolplane:close-agent-settings',
      source: iframe.contentWindow,
    }));

    expect(screen.queryByRole('dialog', { name: 'Hermes runtime' })).not.toBeInTheDocument();
  });
});
