import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ToolPlayground } from '@/components/dashboard/ToolPlayground';

const mocks = vi.hoisted(() => ({
  connectMcpInspectorAction: vi.fn(),
  runMcpInspectorToolAction: vi.fn(),
  startSandboxAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/lib/workspace/inspector-actions', () => ({
  connectMcpInspectorAction: mocks.connectMcpInspectorAction,
  runMcpInspectorToolAction: mocks.runMcpInspectorToolAction,
}));
vi.mock('@/lib/sandboxes/actions', () => ({ startSandboxAction: mocks.startSandboxAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

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
const sandbox = { id: 'sandbox-1', name: 'Inspector lab', kind: 'docker', running: true, networkEnabled: true };

describe('ToolPlayground', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectMcpInspectorAction.mockReset();
    mocks.runMcpInspectorToolAction.mockReset();
    mocks.startSandboxAction.mockReset();
    mocks.refresh.mockReset();
  });

  it('renders tool chips and the first tool description', () => {
    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={tools} sandboxes={[sandbox]} connectedSandboxId="sandbox-1" />);
    expect(screen.getByRole('button', { name: 'echo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument();
    expect(screen.getByText('Echo back the provided message.')).toBeInTheDocument();
  });

  it('runs a tool through the workspace-scoped console action and shows the result', async () => {
    mocks.runMcpInspectorToolAction.mockResolvedValue({
      result: { content: [{ type: 'text', text: 'HELLO' }] },
    });

    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={tools} sandboxes={[sandbox]} connectedSandboxId="sandbox-1" />);
    await userEvent.click(screen.getByRole('button', { name: /run tool/i }));

    expect(mocks.runMcpInspectorToolAction).toHaveBeenCalledWith({
      workspace: 'acme',
      deploymentId: 'dep1',
      sandboxId: 'sandbox-1',
      toolName: 'echo',
      arguments: { message: '' },
    });
    expect(await screen.findByText('HELLO')).toBeInTheDocument();
  });

  it('shows an empty state when there are no tools', () => {
    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={[]} sandboxes={[sandbox]} connectedSandboxId="sandbox-1" />);
    expect(screen.getByText(/no tools are currently available/i)).toBeInTheDocument();
  });

  it('loads tools only after connecting the selected sandbox', async () => {
    mocks.connectMcpInspectorAction.mockResolvedValue({ tools });
    render(<ToolPlayground workspace="acme" deploymentId="dep1" tools={[]} sandboxes={[sandbox]} />);

    expect(screen.queryByRole('button', { name: 'echo' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /connect inspector/i }));

    expect(mocks.connectMcpInspectorAction).toHaveBeenCalledWith({
      workspace: 'acme', deploymentId: 'dep1', sandboxId: 'sandbox-1',
    });
    expect(await screen.findByRole('button', { name: 'echo' })).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('starts a stopped sandbox and refreshes its live status', async () => {
    mocks.startSandboxAction.mockResolvedValue(undefined);
    render(<ToolPlayground
      workspace="acme"
      deploymentId="dep1"
      tools={[]}
      sandboxes={[{ ...sandbox, running: false }]}
    />);

    await userEvent.click(screen.getByRole('button', { name: /start sandbox/i }));
    expect(mocks.startSandboxAction).toHaveBeenCalledWith(expect.any(FormData));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('requires connector credentials before offering sandbox controls', () => {
    render(<ToolPlayground
      workspace="acme team"
      deploymentId="dep/1"
      tools={[]}
      sandboxes={[sandbox]}
      credentialsRequired
    />);

    expect(screen.getByText(/configure this connector's required credentials/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /configure variables/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/mcp/dep%2F1?tab=variables',
    );
    expect(screen.queryByRole('button', { name: /connect inspector/i })).not.toBeInTheDocument();
  });
});
