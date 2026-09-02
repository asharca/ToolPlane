import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/admin/settings-actions', () => ({
  updateRemoteMcpPrivateHostsSettingsAction: vi.fn(),
}));

import { RemoteMcpPrivateHostsSettingsForm } from '@/components/admin/RemoteMcpPrivateHostsSettingsForm';

describe('RemoteMcpPrivateHostsSettingsForm', () => {
  it('shows the current admin override and can restore the environment default', () => {
    render(
      <RemoteMcpPrivateHostsSettingsForm
        value="*.rhzy.ai,10.0.10.42"
        source="database"
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Allowed hosts and IP addresses' }))
      .toHaveValue('*.rhzy.ai,10.0.10.42');
    expect(screen.getByText('Admin override')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore environment default' })).toBeInTheDocument();
  });

  it('identifies the environment fallback without a reset button', () => {
    render(<RemoteMcpPrivateHostsSettingsForm value="*.rhzy.ai" source="environment" />);

    expect(screen.getByText('Environment variable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore environment default' })).not.toBeInTheDocument();
  });
});
