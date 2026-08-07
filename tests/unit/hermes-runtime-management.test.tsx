import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const actions = vi.hoisted(() => ({
  cloneSandboxAction: vi.fn(async () => undefined),
  createSandboxSnapshotAction: vi.fn(async () => undefined),
  deleteSandboxSnapshotAction: vi.fn(async () => undefined),
  renameSandboxAction: vi.fn(async () => undefined),
  restoreSandboxSnapshotAction: vi.fn(async () => undefined),
  updateSandboxEnvAction: vi.fn(async () => undefined),
}));

vi.mock('@/lib/sandboxes/actions', () => actions);

import { HermesRuntimeManagement } from '@/components/dashboard/agents/HermesRuntimeManagement';

function renderManagement(
  status = 'stopped',
  snapshots: React.ComponentProps<typeof HermesRuntimeManagement>['snapshots'] = [],
) {
  return render(
    <HermesRuntimeManagement
      workspace="acme"
      sandboxId="hermes-sandbox-1"
      sandboxName="Research Hermes"
      environment="EXISTING=value"
      status={status}
      snapshots={snapshots}
    />,
  );
}

function submittedFormData(action: ReturnType<typeof vi.fn>) {
  return action.mock.calls[0]?.[0] as FormData | undefined;
}

describe('HermesRuntimeManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes rename and environment changes to the managed sandbox', async () => {
    const user = userEvent.setup();
    renderManagement();

    expect(screen.queryByRole('textbox', { name: 'Clone name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clone' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Snapshot name' })).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: 'Sandbox name' });
    expect(name).toHaveValue('Research Hermes');
    expect(name.closest('form')?.elements.namedItem('workspace')).toHaveValue('acme');
    expect(name.closest('form')?.elements.namedItem('sandboxId')).toHaveValue('hermes-sandbox-1');
    await user.clear(name);
    await user.type(name, 'Renamed Hermes');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(actions.renameSandboxAction).toHaveBeenCalledOnce());
    expect(submittedFormData(actions.renameSandboxAction)?.get('workspace')).toBe('acme');
    expect(submittedFormData(actions.renameSandboxAction)?.get('sandboxId')).toBe('hermes-sandbox-1');
    expect(submittedFormData(actions.renameSandboxAction)?.get('name')).toBe('Renamed Hermes');

    const environment = screen.getByRole('textbox', { name: 'Hermes environment variables' });
    expect(environment).toHaveValue('EXISTING=value');
    expect(environment.closest('form')?.elements.namedItem('workspace')).toHaveValue('acme');
    expect(environment.closest('form')?.elements.namedItem('sandboxId')).toHaveValue('hermes-sandbox-1');
    await user.clear(environment);
    await user.type(environment, 'API_KEY=secret');
    await user.click(screen.getByRole('button', { name: 'Save environment' }));

    await waitFor(() => expect(actions.updateSandboxEnvAction).toHaveBeenCalledOnce());
    expect(submittedFormData(actions.updateSandboxEnvAction)?.get('workspace')).toBe('acme');
    expect(submittedFormData(actions.updateSandboxEnvAction)?.get('sandboxId')).toBe('hermes-sandbox-1');
    expect(submittedFormData(actions.updateSandboxEnvAction)?.get('env')).toBe('API_KEY=secret');
  });

  it('blocks mutations and snapshot creation while the Hermes runtime has a lifecycle operation', () => {
    renderManagement('copying');

    expect(screen.getByRole('textbox', { name: 'Sandbox name' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Hermes environment variables' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save environment' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Snapshot name' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create snapshot' })).toBeDisabled();
  });

  it('uses the Hermes-specific confirmation before restoring a volume snapshot', async () => {
    const user = userEvent.setup();
    renderManagement('stopped', [{
      id: 'snapshot-1',
      name: 'Before configuration change',
      status: 'ready',
      error: null,
      createdAt: 'August 7, 2026',
    }]);

    const restore = screen.getByRole('button', { name: 'Restore' });
    const restoreForm = restore.closest('form');
    if (!restoreForm) throw new Error('Restore form was not rendered.');
    await user.click(restore);

    expect(restoreForm).toHaveTextContent(/Replace current persistent Hermes data/);
  });

  it('hides data controls after an unreconciled copy failure', () => {
    renderManagement('copy_failed');

    expect(screen.queryByRole('textbox', { name: 'Snapshot name' })).not.toBeInTheDocument();
  });
});
