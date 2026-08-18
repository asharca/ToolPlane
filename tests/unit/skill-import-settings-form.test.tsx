import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MAX_SKILL_IMPORT_SKILLS,
  MIN_SKILL_IMPORT_SKILLS,
} from '@/lib/skills/limits';

vi.mock('@/lib/admin/settings-actions', () => ({ updateSkillImportLimitAction: vi.fn() }));
vi.mock('@/components/dashboard/SubmitButton', () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));

import { SkillImportSettingsForm } from '@/components/admin/SkillImportSettingsForm';

describe('SkillImportSettingsForm', () => {
  it('renders the persisted import limit with its hard range', () => {
    render(<SkillImportSettingsForm maxSkills={80} />);

    const input = screen.getByRole('spinbutton', { name: 'Maximum skills per import' });
    expect(input).toHaveValue(80);
    expect(input).toHaveAttribute('min', String(MIN_SKILL_IMPORT_SKILLS));
    expect(input).toHaveAttribute('max', String(MAX_SKILL_IMPORT_SKILLS));
    expect(screen.getByText(/whole number from 1 to 512/)).toBeInTheDocument();
  });
});
