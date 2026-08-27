import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';

vi.mock('@/lib/skills/actions', () => ({
  createCustomSkillAction: vi.fn(),
  importSkillFromGithubAction: vi.fn(),
  uploadSkillFolderAction: vi.fn(),
}));

describe('AddSkillDialog', () => {
  it('can open directly from an add handoff', () => {
    render(<AddSkillDialog slug="acme" defaultOpen />);

    expect(screen.getByRole('dialog', { name: 'Add a skill' })).toBeInTheDocument();
    expect(screen.getByText('Upload a folder')).toBeInTheDocument();
  });

  it('shows three sources and reveals the create form', async () => {
    render(<AddSkillDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add skill/i }));
    expect(screen.getByText('Import from GitHub')).toBeInTheDocument();
    expect(screen.getByText('Upload a folder')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Create new'));
    expect(screen.getByPlaceholderText('My awesome skill')).toBeInTheDocument();
  });

  it('closes with Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" />);

    const trigger = screen.getByRole('button', { name: /add skill/i });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Add a skill' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses the administrator-provided folder import limit', async () => {
    render(<AddSkillDialog slug="acme" maxSkillImportSkills={1} />);
    await userEvent.click(screen.getByRole('button', { name: /add skill/i }));
    await userEvent.click(screen.getByText('Upload a folder'));

    const files = [
      new File(['# One'], 'SKILL.md', { type: 'text/markdown' }),
      new File(['# Two'], 'SKILL.md', { type: 'text/markdown' }),
    ];
    Object.defineProperty(files[0], 'webkitRelativePath', { value: 'one/SKILL.md' });
    Object.defineProperty(files[1], 'webkitRelativePath', { value: 'two/SKILL.md' });
    fireEvent.change(document.querySelector('input[name="folderFiles"]')!, { target: { files } });

    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });
});
