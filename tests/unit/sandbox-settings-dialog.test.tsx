import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SandboxSettingsDialog } from '@/components/dashboard/sandboxes/SandboxSettingsDialog';

describe('SandboxSettingsDialog', () => {
  it('opens as a modal and returns focus to the trigger after Escape', async () => {
    render(
      <SandboxSettingsDialog
        title="Sandbox settings"
        subtitle="Connected computer"
        triggerLabel="Settings"
        closeLabel="Close"
      >
        <label>
          Sandbox name
          <input defaultValue="Connected computer" />
        </label>
      </SandboxSettingsDialog>,
    );

    const trigger = screen.getByRole('button', { name: 'Settings' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Sandbox settings' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Sandbox name' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
