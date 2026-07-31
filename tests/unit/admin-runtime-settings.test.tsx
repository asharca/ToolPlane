import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RuntimeSettingsForm } from '@/components/admin/RuntimeSettingsForm';

vi.mock('@/lib/admin/settings-actions', () => ({
  updateAgentAttachmentLimitAction: vi.fn(),
}));

describe('RuntimeSettingsForm', () => {
  it('shows the active admin override and allows restoring the environment default', () => {
    render(<RuntimeSettingsForm bytes={250_000_000} source="database" minMegabytes={1} maxMegabytes={10_000} />);

    expect(screen.getByRole('spinbutton', { name: 'Maximum attachment size' })).toHaveValue(250);
    expect(screen.getByText('Admin override')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore environment default' })).toBeInTheDocument();
  });

  it('identifies the environment fallback without showing a reset button', () => {
    render(<RuntimeSettingsForm bytes={800_000_000} source="environment" minMegabytes={1} maxMegabytes={10_000} />);

    expect(screen.getByText('Environment variable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore environment default' })).not.toBeInTheDocument();
  });
});
