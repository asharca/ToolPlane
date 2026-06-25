import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

describe('DeployCustomMcpDialog', () => {
  it('switches the package field label per source and shows Start Command only for Docker', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    expect(screen.getByText('npm Package')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('GitHub Repository')).toBeInTheDocument();
    expect(screen.queryByText('Start Command')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Docker' }));
    expect(screen.getByText('Docker Image')).toBeInTheDocument();
    expect(screen.getByText('Start Command')).toBeInTheDocument();
  });
});
