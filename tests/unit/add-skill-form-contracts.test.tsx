import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';
import { createCustomSkillAction } from '@/lib/skills/actions';

vi.mock('@/lib/skills/actions', () => ({
  createCustomSkillAction: vi.fn(),
  importSkillFromGithubAction: vi.fn(),
  uploadSkillFolderAction: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe('beUI skill form contracts', () => {
  it('keeps required validation and accessible field names after the control migration', async () => {
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" />);
    await user.click(screen.getByRole('button', { name: 'Add skill' }));
    await user.click(screen.getByText('Create new', { exact: true }));
    const name = screen.getByRole('textbox', { name: 'Skill name' });
    expect(name).toBeRequired();
    expect(name).toHaveAttribute('name', 'name');
    expect(screen.getByPlaceholderText("Summarize this skill's purpose")).toHaveAccessibleName();
    await user.click(screen.getByRole('button', { name: 'Create skill' }));
    expect(createCustomSkillAction).not.toHaveBeenCalled();
    expect(name).toBeInvalid();
  });

  it('uses native FormData and disables repeat submission while the action is pending', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(createCustomSkillAction).mockImplementationOnce(() => pending);
    render(<AddSkillDialog slug="acme" />);
    await user.click(screen.getByRole('button', { name: 'Add skill' }));
    await user.click(screen.getByText('Create new', { exact: true }));
    await user.type(screen.getByRole('textbox', { name: 'Skill name' }), 'Native form skill');
    await user.type(screen.getByPlaceholderText("Summarize this skill's purpose"), 'UTF-8 中文');
    const submit = screen.getByRole('button', { name: 'Create skill' });
    try {
      await user.click(submit);
      await waitFor(() => expect(submit).toBeDisabled());
      expect(submit).toHaveAttribute('aria-busy', 'true');
      await user.click(submit);
      expect(createCustomSkillAction).toHaveBeenCalledTimes(1);
      const form = vi.mocked(createCustomSkillAction).mock.calls[0][0];
      expect(form.get('workspace')).toBe('acme');
      expect(form.get('name')).toBe('Native form skill');
      expect(form.get('description')).toBe('UTF-8 中文');
    } finally {
      await act(async () => { release(); await pending; });
    }
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('associates directory errors with the native picker and resets on close', async () => {
    const user = userEvent.setup();
    render(<AddSkillDialog slug="acme" />);
    const trigger = screen.getByRole('button', { name: 'Add skill' });
    await user.click(trigger);
    await user.click(screen.getByText('Upload a folder', { exact: true }));
    const input = screen.getByLabelText('Upload a folder', { exact: true });
    const file = new File(['# Not a skill'], 'README.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'invalid/README.md' });
    fireEvent.change(input, { target: { files: [file] } });
    const error = screen.getByRole('alert');
    expect(input).toHaveAttribute('aria-describedby', error.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByText('Upload a folder', { exact: true }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Upload a folder', { exact: true })).toHaveAttribute('aria-invalid', 'false');
    expect(document.querySelector('input[name="filePaths"]')).toHaveValue('[]');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });
});
