import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';

vi.mock('@/lib/admin/settings-actions', () => ({ updateHermesArchiveUploadLimitAction: vi.fn() }));
vi.mock('@/components/dashboard/SubmitButton', () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));

import { SystemSettingsForm } from '@/components/admin/SystemSettingsForm';

describe('SystemSettingsForm', () => {
  it('renders the persisted archive limit with the safe configurable range', () => {
    render(<SystemSettingsForm hermesArchiveMaxUploadMiB={24} />);

    const input = screen.getByRole('spinbutton', { name: 'Maximum archive size (MiB)' });
    expect(input).toHaveValue(24);
    expect(input).toHaveAttribute('min', String(MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB));
    expect(input).toHaveAttribute('max', String(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB));
    expect(screen.getByText(/whole number from 1 to 60 MiB/)).toBeInTheDocument();
  });
});
