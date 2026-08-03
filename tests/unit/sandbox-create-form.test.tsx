import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SandboxCreateForm } from '@/components/dashboard/sandboxes/SandboxCreateForm';

vi.mock('@/lib/sandboxes/actions', () => ({ createSandboxAction: vi.fn() }));
vi.mock('@/lib/agents/actions', () => ({ importHermesArchiveAction: vi.fn() }));

describe('SandboxCreateForm', () => {
  it('offers a safe .hermes ZIP import flow', async () => {
    render(<SandboxCreateForm workspace="acme" />);

    await userEvent.click(screen.getByRole('button', { name: 'New sandbox' }));
    await userEvent.click(screen.getByRole('button', { name: /Import .hermes archive/ }));

    const archive = screen.getByLabelText('Hermes archive');
    expect(archive).toHaveAttribute('type', 'file');
    expect(archive).toHaveAttribute('accept', '.zip,application/zip');
    expect(screen.getByRole('checkbox')).toBeRequired();
    expect(screen.getByText('What gets imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import and create Hermes sandbox' })).toBeInTheDocument();
    expect(document.querySelector('input[name="workspace"]')).toHaveValue('acme');
  });
});
