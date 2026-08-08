import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/admin/settings-actions', () => ({
  updateMcpStartupTimeoutSettingsAction: vi.fn(),
}));

import { McpRuntimeSettingsForm } from '@/components/admin/McpRuntimeSettingsForm';

describe('McpRuntimeSettingsForm', () => {
  it('shows the active administrator override and supports restoring the Compose default', () => {
    render(
      <McpRuntimeSettingsForm
        idleTimeoutMs={300_000}
        maxTimeoutMs={900_000}
        source="database"
        minTimeoutSeconds={1}
        maxTimeoutSeconds={1_800}
      />,
    );

    expect(screen.getByRole('spinbutton', { name: 'Idle timeout (seconds)' })).toHaveValue(300);
    expect(screen.getByRole('spinbutton', { name: 'Maximum startup time (seconds)' })).toHaveValue(900);
    expect(screen.getByText('Admin override')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore environment default' })).toBeInTheDocument();
  });

  it('identifies an environment fallback without a reset button', () => {
    render(
      <McpRuntimeSettingsForm
        idleTimeoutMs={300_000}
        maxTimeoutMs={900_000}
        source="environment"
        minTimeoutSeconds={1}
        maxTimeoutSeconds={1_800}
      />,
    );

    expect(screen.getByText('Environment variable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore environment default' })).not.toBeInTheDocument();
  });
});
