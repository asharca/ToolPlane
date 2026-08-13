import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectDialog } from '@/components/dashboard/ConnectDialog';

describe('ConnectDialog', () => {
  it('closes with Escape, restores focus, and resets the selected client', async () => {
    const user = userEvent.setup();
    render(<ConnectDialog endpoint="https://example.com/mcp" name="Example MCP" />);

    const trigger = screen.getByRole('button', { name: 'Connect with…' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.getByRole('dialog', { name: 'Claude Code' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Install server' })).toBeInTheDocument();
  });
});
