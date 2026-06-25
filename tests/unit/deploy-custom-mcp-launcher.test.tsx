import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpLauncher } from '@/components/dashboard/DeployCustomMcpLauncher';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

describe('DeployCustomMcpLauncher', () => {
  it('opens the slide-over with npm enabled and other sources disabled', async () => {
    render(<DeployCustomMcpLauncher slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /deploy custom mcp/i }));

    expect(screen.getByPlaceholderText(/server-everything/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'npm' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'PyPI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Docker' })).toBeDisabled();
  });
});
