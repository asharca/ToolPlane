import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';

function renderButton({
  action = vi.fn(),
  disabled = false,
}: {
  action?: (formData: FormData) => void | Promise<void>;
  disabled?: boolean;
} = {}) {
  return render(
    <form action={action}>
      <ConfirmSubmitButton
        triggerLabel="Remove"
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        prompt="Remove weather server?"
        pendingLabel="Removing..."
        disabled={disabled}
      />
    </form>,
  );
}

describe('ConfirmSubmitButton', () => {
  it('requires confirmation and restores focus when cancelled', async () => {
    const action = vi.fn();
    renderButton({ action });

    const trigger = screen.getByRole('button', { name: 'Remove' });
    await userEvent.click(trigger);

    expect(screen.getByText('Remove weather server?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    expect(action).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Remove weather server?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
    expect(action).not.toHaveBeenCalled();
  });

  it('disables the trigger when the action is unavailable', () => {
    renderButton({ disabled: true });

    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('prevents duplicate input while the form action is pending', async () => {
    let finishAction: (() => void) | undefined;
    const action = vi.fn(
      () => new Promise<void>((resolve) => {
        finishAction = resolve;
      }),
    );
    renderButton({ action });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Removing...' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
    expect(action).toHaveBeenCalledTimes(1);

    finishAction?.();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
      expect(screen.queryByText('Remove weather server?')).not.toBeInTheDocument();
    });
  });
});
