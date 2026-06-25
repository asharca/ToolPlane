import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';

vi.mock('@/lib/skills/actions', () => ({
  createCustomSkillAction: vi.fn(),
  importSkillFromGithubAction: vi.fn(),
  uploadSkillFolderAction: vi.fn(),
}));

describe('AddSkillDialog', () => {
  it('shows three sources and reveals the create form', async () => {
    render(<AddSkillDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add skill/i }));
    expect(screen.getByText('Import from GitHub')).toBeInTheDocument();
    expect(screen.getByText('Upload a folder')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Create new'));
    expect(screen.getByPlaceholderText('My awesome skill')).toBeInTheDocument();
  });
});
