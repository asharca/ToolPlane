import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpRequestLogs } from '@/components/dashboard/McpRequestLogs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const logs = [
  {
    id: 'ok',
    deploymentName: 'Memory',
    deploymentHref: '/app/smoke/mcp/memory',
    method: 'POST',
    path: '/mcp/memory/rpc#tools/call:remember',
    statusCode: 200,
    durationMs: 42,
    requestBody: JSON.stringify({ params: { name: 'remember' } }),
    responseBody: JSON.stringify({ result: { content: [{ type: 'text', text: 'Saved' }] } }),
    time: 'Aug 12, 1:10 PM',
  },
  {
    id: 'semantic-error',
    deploymentName: 'Memory',
    deploymentHref: '/app/smoke/mcp/memory',
    method: 'POST',
    path: '/mcp/memory/rpc#tools/call:private_tool',
    statusCode: 200,
    durationMs: 623,
    requestBody: JSON.stringify({ params: { name: 'private_tool' } }),
    responseBody: JSON.stringify({ error: { message: 'Unknown tool: private_tool' } }),
    time: 'Aug 12, 1:09 PM',
  },
];

describe('McpRequestLogs', () => {
  it('prioritizes the tool operation and semantic errors over an internal path', async () => {
    render(<McpRequestLogs logs={logs} showServer />);

    expect(screen.getAllByText('Call tool')).toHaveLength(2);
    expect(screen.getByText('private_tool')).toBeInTheDocument();
    expect(screen.getByText('Unknown tool: private_tool')).toBeInTheDocument();
    expect(screen.getAllByText('HTTP 200')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /failed 1/i }));
    expect(screen.queryByText('remember')).not.toBeInTheDocument();
    expect(screen.getByText('private_tool')).toBeInTheDocument();
  });

  it('keeps raw transport details behind an expandable row', async () => {
    render(<McpRequestLogs logs={logs} />);

    expect(screen.queryByText('/mcp/memory/rpc#tools/call:remember')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /call tool.*remember/i }));
    expect(screen.getByText('/mcp/memory/rpc#tools/call:remember')).toBeInTheDocument();
    expect(screen.getByText('Raw endpoint:')).toBeInTheDocument();
  });
});
