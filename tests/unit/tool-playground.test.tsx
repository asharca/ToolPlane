import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ToolPlayground } from '@/components/dashboard/ToolPlayground';

const mocks = vi.hoisted(() => ({
  runMcpConsoleToolAction: vi.fn(),
}));

vi.mock('@/lib/workspace/actions', () => ({
  runMcpConsoleToolAction: mocks.runMcpConsoleToolAction,
}));

type PlaygroundTool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

const tools: PlaygroundTool[] = [
  {
    name: 'echo',
    description: 'Echo back the provided message.',
    inputSchema: { properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' } } },
  },
];

describe('ToolPlayground', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.runMcpConsoleToolAction.mockReset();
  });

  it('renders tool chips and the first tool description', () => {
    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={tools} />);
    expect(screen.getByRole('button', { name: 'echo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument();
    expect(screen.getByText('Echo back the provided message.')).toBeInTheDocument();
  });

  it('runs a tool through the workspace-scoped console action and shows the result', async () => {
    mocks.runMcpConsoleToolAction.mockResolvedValue({
      result: { content: [{ type: 'text', text: 'HELLO' }] },
    });

    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={tools} />);
    await userEvent.click(screen.getByRole('button', { name: /run tool/i }));

    expect(mocks.runMcpConsoleToolAction).toHaveBeenCalledWith({
      workspace: 'acme',
      deploymentId: 'dep1',
      toolName: 'echo',
      arguments: { message: '' },
    });
    expect(await screen.findByText('HELLO')).toBeInTheDocument();
  });

  it('shows an empty state when there are no tools', () => {
    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={[]} />);
    expect(screen.getByText(/no tools are currently available/i)).toBeInTheDocument();
  });
});
