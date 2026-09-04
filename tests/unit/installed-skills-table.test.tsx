import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstalledSkillsTable } from '@/components/dashboard/InstalledSkillsTable';

const mocks = vi.hoisted(() => ({ uninstallSkillAction: vi.fn() }));

vi.mock('@/lib/workspace/actions', () => ({ uninstallSkillAction: mocks.uninstallSkillAction }));

const skills = [
  { id: 'skill-1', name: 'First skill', iconUrl: null, createdAt: 'Aug 12, 2026' },
  { id: 'skill-2', name: 'Second skill', iconUrl: null, createdAt: 'Aug 11, 2026' },
];

describe('InstalledSkillsTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens details from the full skill cell and retains an individual delete action', () => {
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    const link = screen.getByRole('link', { name: 'First skill' });
    expect(link).toHaveAttribute('href', '/app/acme/skills/skill-1');
    expect(link.parentElement).toHaveClass('p-0');
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download SKILL.md' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Uninstall: First skill' }))
      .toHaveAttribute('title', 'Uninstall');
  });

  it('only shows the batch action after selection, then clears and submits selected skills after confirmation', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall (2)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select all matching (2)' }));
    const toolbar = screen.getByRole('toolbar', { name: '2 selected' });
    expect(toolbar.closest('thead')).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Uninstall (2)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('0 selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall (2)' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select First skill' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Second skill' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall (2)' }));
    expect(mocks.uninstallSkillAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.getAll('installId')).toEqual(['skill-1', 'skill-2']);
  });

  it('submits an individual skill deletion only after confirmation', async () => {
    const user = userEvent.setup();
    render(<InstalledSkillsTable slug="acme" skills={skills} />);

    await user.click(screen.getByRole('button', { name: 'Uninstall: First skill' }));
    expect(mocks.uninstallSkillAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.getAll('installId')).toEqual(['skill-1']);
  });

  it('drops selections for skills removed by a server refresh', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InstalledSkillsTable slug="acme" skills={skills} />);

    await user.click(screen.getByRole('checkbox', { name: 'Select First skill' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Second skill' }));
    rerender(<InstalledSkillsTable slug="acme" skills={[skills[0]]} />);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Uninstall (1)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.uninstallSkillAction).toHaveBeenCalledTimes(1));
    const formData = mocks.uninstallSkillAction.mock.calls[0][0] as FormData;
    expect(formData.getAll('installId')).toEqual(['skill-1']);
  });
});
