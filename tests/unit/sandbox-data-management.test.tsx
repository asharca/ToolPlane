import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const actions = vi.hoisted(() => ({
  cloneSandboxAction: vi.fn(async () => undefined),
  createSandboxSnapshotAction: vi.fn(async () => undefined),
  deleteSandboxSnapshotAction: vi.fn(async () => undefined),
  restoreSandboxSnapshotAction: vi.fn(async () => undefined),
}));

vi.mock('@/lib/sandboxes/actions', () => actions);

import { SandboxDataManagement } from '@/components/dashboard/sandboxes/SandboxDataManagement';

type Snapshot = React.ComponentProps<typeof SandboxDataManagement>['snapshots'][number];

const readySnapshot: Snapshot = {
  id: 'snapshot-ready',
  name: 'Before upgrade',
  status: 'ready',
  error: null,
  createdAt: 'July 14, 2026',
};

function renderManagement({
  snapshots = [],
  disabled = false,
  creationDisabled = false,
}: {
  snapshots?: Snapshot[];
  disabled?: boolean;
  creationDisabled?: boolean;
} = {}) {
  return render(
    <SandboxDataManagement
      workspace="acme"
      sandboxId="sandbox-123"
      sandboxName="Research box"
      snapshots={snapshots}
      disabled={disabled}
      creationDisabled={creationDisabled}
    />,
  );
}

function expectScopeFields(form: HTMLFormElement, snapshotId?: string) {
  expect(form.elements.namedItem('workspace')).toHaveValue('acme');
  expect(form.elements.namedItem('sandboxId')).toHaveValue('sandbox-123');
  if (snapshotId) {
    expect(form.elements.namedItem('snapshotId')).toHaveValue(snapshotId);
  }
}

function submittedFormData(mock: ReturnType<typeof vi.fn>, call = 0) {
  return mock.mock.calls[call][0] as FormData;
}

describe('SandboxDataManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults the clone name, scopes create forms, and renders an empty snapshot list', () => {
    renderManagement();

    const cloneName = screen.getByRole('textbox', { name: 'Clone name' });
    expect(cloneName).toHaveValue('Research box copy');
    expectScopeFields(cloneName.closest('form')!);
    expect(cloneName.closest('form')!.elements.namedItem('defaultName')).toHaveValue('Research box copy');

    const snapshotName = screen.getByRole('textbox', { name: 'Snapshot name' });
    expectScopeFields(snapshotName.closest('form')!);
    expect(snapshotName.closest('form')!.elements.namedItem('defaultName')).toHaveValue('Snapshot');
    expect(screen.getByText('No workspace snapshots yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('requires confirmation before restoring or deleting a ready snapshot', async () => {
    const user = userEvent.setup();
    renderManagement({ snapshots: [readySnapshot] });

    expect(screen.getByText('Ready')).toBeInTheDocument();

    const restoreTrigger = screen.getByRole('button', { name: 'Restore' });
    const restoreForm = restoreTrigger.closest('form')!;
    expectScopeFields(restoreForm, readySnapshot.id);
    expect(restoreForm.elements.namedItem('recoveryName')).toHaveValue('Restore recovery: Before upgrade');
    await user.click(restoreTrigger);

    expect(within(restoreForm).getByText(/Replace current \/workspace files/)).toHaveTextContent(readySnapshot.name);
    expect(actions.restoreSandboxSnapshotAction).not.toHaveBeenCalled();
    await user.click(within(restoreForm).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(actions.restoreSandboxSnapshotAction).toHaveBeenCalledTimes(1));
    expect(submittedFormData(actions.restoreSandboxSnapshotAction).get('workspace')).toBe('acme');
    expect(submittedFormData(actions.restoreSandboxSnapshotAction).get('sandboxId')).toBe('sandbox-123');
    expect(submittedFormData(actions.restoreSandboxSnapshotAction).get('snapshotId')).toBe(readySnapshot.id);

    const deleteTrigger = screen.getByRole('button', { name: 'Delete' });
    const deleteForm = deleteTrigger.closest('form')!;
    expectScopeFields(deleteForm, readySnapshot.id);
    await user.click(deleteTrigger);

    expect(within(deleteForm).getByText(/Delete snapshot/)).toHaveTextContent(readySnapshot.name);
    expect(actions.deleteSandboxSnapshotAction).not.toHaveBeenCalled();
    await user.click(within(deleteForm).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(actions.deleteSandboxSnapshotAction).toHaveBeenCalledTimes(1));
    expect(submittedFormData(actions.deleteSandboxSnapshotAction).get('snapshotId')).toBe(readySnapshot.id);
  });

  it('does not offer restore for incomplete snapshots but still allows deletion retries', async () => {
    const user = userEvent.setup();
    const snapshots: Snapshot[] = [
      {
        id: 'snapshot-error',
        name: 'Broken copy',
        status: 'error',
        error: 'copy failed',
        createdAt: 'July 14, 2026',
      },
      {
        id: 'snapshot-creating',
        name: 'In progress',
        status: 'creating',
        error: null,
        createdAt: 'July 14, 2026',
      },
      {
        id: 'snapshot-deleting',
        name: 'Interrupted deletion',
        status: 'deleting',
        error: null,
        createdAt: 'July 14, 2026',
      },
    ];
    renderManagement({ snapshots });

    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Creating')).toBeInTheDocument();
    expect(screen.getByText('Deleting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();

    const deleteTriggers = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteTriggers).toHaveLength(3);
    for (const [index, trigger] of deleteTriggers.entries()) {
      const form = trigger.closest('form')!;
      expectScopeFields(form, snapshots[index].id);
      await user.click(trigger);
      expect(actions.deleteSandboxSnapshotAction).toHaveBeenCalledTimes(index);
      await user.click(within(form).getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(actions.deleteSandboxSnapshotAction).toHaveBeenCalledTimes(index + 1));
      expect(submittedFormData(actions.deleteSandboxSnapshotAction, index).get('snapshotId'))
        .toBe(snapshots[index].id);
    }
  });

  it('disables the whole data-management fieldset while provisioning', () => {
    const { container } = renderManagement({ snapshots: [readySnapshot], disabled: true });

    expect(screen.getByText('Wait for provisioning to finish')).toBeInTheDocument();
    const fieldset = container.querySelector('fieldset');
    expect(fieldset).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Clone name' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Snapshot name' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create snapshot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('allows recovery restore and deletion while blocking new copies', () => {
    renderManagement({ snapshots: [readySnapshot], creationDisabled: true });

    expect(screen.getByText(/Restore a ready recovery snapshot/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Clone name' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Snapshot name' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});
