import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';

vi.mock('@/lib/skills/actions', () => ({
  createCustomSkillAction: vi.fn().mockResolvedValue({}),
  importSkillFromGithubAction: vi.fn().mockResolvedValue({}),
  uploadSkillFolderAction: vi.fn().mockResolvedValue({}),
}));

describe('AddSkillDialog', () => {
  beforeEach(() => {
    vi.mocked(createCustomSkillAction).mockReset().mockResolvedValue({});
    vi.mocked(importSkillFromGithubAction).mockReset().mockResolvedValue({});
    vi.mocked(uploadSkillFolderAction).mockReset().mockResolvedValue({});
  });
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

  it.each(['Create new', 'Import from GitHub', 'Upload a folder'])('returns from %s and discards its draft', async (source) => {
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" defaultOpen />);
    await user.click(screen.getByText(source));
    const input = document.querySelector<HTMLInputElement>('input[name="name"], input[name="repo"]')!;
    await user.type(input, 'draft');
    await user.click(screen.getByRole('button', { name: 'Back to sources' }));
    await user.click(screen.getByText(source));
    expect(document.querySelector('input[name="name"], input[name="repo"]')).toHaveValue('');
  });

  it('keeps creation inputs on failure and prevents duplicate pending submissions', async () => {
    const { promise, resolve } = Promise.withResolvers<{ error: string }>();
    vi.mocked(createCustomSkillAction).mockReturnValue(promise);
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" defaultOpen />);
    await user.click(screen.getByText('Create new'));
    await user.type(screen.getByPlaceholderText('My awesome skill'), 'Draft skill');
    await user.click(screen.getByRole('button', { name: 'Create skill' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sources' })).toBeDisabled();
    await act(async () => resolve({ error: 'Save failed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByPlaceholderText('My awesome skill')).toHaveValue('Draft skill');
    expect(createCustomSkillAction).toHaveBeenCalledTimes(1);
  });

  it('retains folder selection on failed upload and blocks pending duplicates', async () => {
    const { promise, resolve } = Promise.withResolvers<{ error: string }>();
    vi.mocked(uploadSkillFolderAction).mockReturnValue(promise);
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" defaultOpen />);
    await user.click(screen.getByText('Upload a folder'));
    const input = document.querySelector<HTMLInputElement>('input[name="folderFiles"]')!;
    const file = new File(['# Smoke'], 'SKILL.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'smoke/SKILL.md' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sources' })).toBeDisabled();
    await act(async () => resolve({ error: 'Upload failed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
    expect(input.files?.[0]).toBe(file);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
    expect(uploadSkillFolderAction).toHaveBeenCalledTimes(1);
  });

  it('rejects a folder without SKILL.md before submission', async () => {
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" defaultOpen />);
    await user.click(screen.getByText('Upload a folder'));
    await user.upload(document.querySelector<HTMLInputElement>('input[name="folderFiles"]')!, new File(['x'], 'notes.txt'));
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(uploadSkillFolderAction).not.toHaveBeenCalled();
  });
});
