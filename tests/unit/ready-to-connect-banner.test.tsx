import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReadyToConnectBanner } from '@/components/dashboard/ReadyToConnectBanner';

const props = {
  noun: 'server' as const,
  endpoint: 'https://toolplane.test/api/v1/mcp/dep-1/rpc',
  name: 'Example MCP',
};

describe('ReadyToConnectBanner', () => {
  it('renders connection controls only for a live running deployment', () => {
    const { rerender } = render(<ReadyToConnectBanner {...props} status="setup_required" />);

    expect(screen.queryByText('Ready to connect')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect with…' })).not.toBeInTheDocument();

    rerender(<ReadyToConnectBanner {...props} status="running" />);

    expect(screen.getByText('Ready to connect')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with…' })).toBeInTheDocument();
  });
});
