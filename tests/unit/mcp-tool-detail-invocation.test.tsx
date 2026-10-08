import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  listMcpTools: vi.fn(),
  runMcpConsoleToolAction: vi.fn(),
  runMcpInspectorToolAction: vi.fn(),
  status: 'running',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: async () => ({ id: 'user-1' }) }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: async () => ({ id: 'workspace-1' }) }));
vi.mock('@/lib/db', () => ({ db: { deployment: { findFirst: mocks.deployment } } }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: () => mocks.status }));
vi.mock('@/lib/process/mcp-client', () => ({ listMcpTools: mocks.listMcpTools }));
vi.mock('@/lib/workspace/actions', () => ({ runMcpConsoleToolAction: mocks.runMcpConsoleToolAction }));
vi.mock('@/lib/workspace/inspector-actions', () => ({
  connectMcpInspectorAction: vi.fn(), runMcpInspectorToolAction: mocks.runMcpInspectorToolAction,
}));
vi.mock('@/lib/sandboxes/actions', () => ({ startSandboxAction: vi.fn() }));

import DeploymentToolPage from '@/app/app/[workspace]/mcp/[deploymentId]/tools/[toolName]/page';

const tools = [
  { name: 'first', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
];
const params = () => Promise.resolve({ workspace: 'acme', deploymentId: 'dep1', toolName: 'echo' });

describe('deployed tool detail invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = 'running';
    mocks.deployment.mockResolvedValue({ id: 'dep1', source: 'remote', status: 'running', installCfg: { toolCatalog: tools } });
    mocks.listMcpTools.mockResolvedValue(tools);
    mocks.runMcpConsoleToolAction.mockResolvedValue({ result: { content: [{ type: 'text', text: 'actual tool output' }] } });
  });

  it('invokes the selected deep-linked tool without any sandbox and displays its result', async () => {
    render(await DeploymentToolPage({ params: params() }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect inspector/i })).not.toBeInTheDocument();
    const args = screen.getByRole('textbox', { name: /arguments/i });
    fireEvent.change(args, { target: { value: '{"message":"hello"}' } });
    await userEvent.click(screen.getByRole('button', { name: /run tool/i }));
    expect(mocks.runMcpConsoleToolAction).toHaveBeenCalledWith({
      workspace: 'acme', deploymentId: 'dep1', toolName: 'echo', arguments: { message: 'hello' },
    });
    expect(await screen.findByText('actual tool output')).toBeInTheDocument();
    expect(mocks.runMcpInspectorToolAction).not.toHaveBeenCalled();
  });

  it('keeps stopped tool schemas visible without an executable form', async () => {
    mocks.status = 'stopped';
    render(await DeploymentToolPage({ params: params() }));
    expect(screen.getByRole('heading', { level: 1, name: 'echo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run tool/i })).not.toBeInTheDocument();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('does not expose a missing deployment or unknown tool', async () => {
    mocks.deployment.mockResolvedValueOnce(null);
    await expect(DeploymentToolPage({ params: params() })).rejects.toThrow('NOT_FOUND');
    await expect(DeploymentToolPage({ params: Promise.resolve({ workspace: 'acme', deploymentId: 'dep1', toolName: 'missing' }) }))
      .rejects.toThrow('NOT_FOUND');
    expect(mocks.runMcpConsoleToolAction).not.toHaveBeenCalled();
  });
});
