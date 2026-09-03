import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listMcpTools: vi.fn(),
  listSandboxes: vi.fn(),
  sandboxFindFirst: vi.fn(),
  redirect: vi.fn(),
  status: 'running',
}));

const translations: Record<string, string> = {
  aboutThisMcp: 'About this MCP',
  author: 'Author',
  sourceLabel: 'Source',
  networkMode: 'Network',
  networkNone: 'No network',
  networkIsolated: 'Isolated',
  tools: 'Tools',
  toolCatalog: 'Tool catalog',
  toolCatalogDescription: 'Inspect every tool.',
  instructions: 'Instructions',
  inputSchema: 'Input schema',
  schemaJson: 'JSON schema',
  parameter: 'Parameter',
  type: 'Type',
  required: 'Required',
  defaultValue: 'Default',
  noDescription: 'No description.',
  noArguments: 'No arguments.',
  toolsUnavailable: 'Tools unavailable',
  deploymentNotRunningTools: 'Start the deployment to inspect tools.',
  toolTestingUnavailable: 'Tool testing unavailable',
  deploymentNotRunningTesting: 'The saved catalog is available, but testing requires a running deployment.',
};

vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string, values?: { count?: number }) => (
    key === 'toolsCount' ? `${values?.count ?? 0} tools` : translations[key] ?? key
  )),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    deployment: { findFirst: mocks.deployment },
    sandbox: { findFirst: mocks.sandboxFindFirst },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  effectiveStatus: () => mocks.status,
  getDeploymentRuntimeSnapshot: vi.fn(),
}));
vi.mock('@/lib/process/mcp-client', () => ({ listMcpTools: mocks.listMcpTools }));
vi.mock('@/lib/sandboxes/queries', () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock('@/lib/http/origin', () => ({ originFromHeaders: () => 'http://localhost:3000' }));
vi.mock('@/lib/observability/log', () => ({ getDeploymentLogs: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/timezone', () => ({
  resolveUserTimeZone: () => 'UTC',
  formatInTimeZone: () => 'Aug 28, 2026',
}));
vi.mock('@/lib/workspace/actions', () => ({
  startDeploymentAction: vi.fn(), stopDeploymentAction: vi.fn(), restartDeploymentAction: vi.fn(),
  rebuildDeploymentAction: vi.fn(), removeDeploymentAction: vi.fn(), renameDeploymentAction: vi.fn(),
  cloneDeploymentAction: vi.fn(),
}));
vi.mock('@/components/dashboard/DashboardHeader', () => ({ DashboardHeader: () => null }));
vi.mock('@/components/dashboard/StatusBadge', () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock('@/components/dashboard/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('@/components/dashboard/ReadyToConnectBanner', () => ({ ReadyToConnectBanner: () => null }));
vi.mock('@/components/dashboard/ConnectDialog', () => ({ ConnectDialog: () => null }));
vi.mock('@/components/dashboard/TabBar', () => ({ TabBar: () => null }));
vi.mock('@/components/dashboard/ToolPlayground', () => ({
  ToolPlayground: ({ defaultRuntime }: { defaultRuntime?: boolean }) => (
    <div data-testid="playground" data-default-runtime={defaultRuntime ? 'true' : 'false'}>Playground</div>
  ),
}));
vi.mock('@/components/dashboard/McpToolExposureEditor', () => ({ McpToolExposureEditor: () => <div>Exposure</div> }));
vi.mock('@/components/dashboard/VariablesEditor', () => ({ VariablesEditor: () => null }));
vi.mock('@/components/dashboard/McpJsonConfigEditor', () => ({ McpJsonConfigEditor: () => null }));
vi.mock('@/components/dashboard/RuntimeFilesEditor', () => ({ RuntimeFilesEditor: () => null }));
vi.mock('@/components/dashboard/DeploymentLogs', () => ({ DeploymentLogs: () => null }));
vi.mock('@/components/dashboard/ContainerLogs', () => ({ ContainerLogs: () => null }));
vi.mock('@/components/dashboard/ProvisioningRefresher', () => ({ ProvisioningRefresher: () => null }));
vi.mock('@/components/dashboard/SafeStreamdown', () => ({ SafeStreamdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/dashboard/SubmitButton', () => ({ SubmitButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock('@/components/dashboard/ConfirmSubmitButton', () => ({ ConfirmSubmitButton: () => null }));

import DeploymentInspectorPage from '@/app/app/[workspace]/mcp/[deploymentId]/page';
import DeploymentToolPage from '@/app/app/[workspace]/mcp/[deploymentId]/tools/[toolName]/page';

const baseDeployment = {
  id: 'deployment-1',
  workspaceId: 'workspace-1',
  serverId: 'server-1',
  server: {
    name: 'Catalog MCP', slug: 'catalog-mcp', author: 'Acme', description: 'Catalog description',
    readme: '# Detailed README', verifiedTools: 7, installCfg: {},
  },
  name: null,
  source: 'npm',
  sourceRef: '@acme/catalog-mcp',
  installCfg: { network: 'isolated', env: {} },
  status: 'running',
  mcpToolExposure: 'all',
  mcpAllowedTools: [],
  publicInvocable: false,
  configFiles: [],
  createdAt: new Date('2026-08-27T12:00:00.000Z'),
  updatedAt: new Date('2026-08-28T12:00:00.000Z'),
};

const tools = [{
  name: 'search_products',
  description: 'Search the product catalog by keyword.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search term' } },
    required: ['query'],
  },
}];

describe('workspace MCP deployment detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = 'running';
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme' });
    mocks.deployment.mockResolvedValue(baseDeployment);
    mocks.listMcpTools.mockResolvedValue(tools);
    mocks.listSandboxes.mockResolvedValue([]);
    mocks.sandboxFindFirst.mockResolvedValue(null);
  });

  it('shows catalog metadata and the saved tool count without querying the runtime', async () => {
    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByText('# Detailed README')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Catalog description')).toBeInTheDocument();
    expect(screen.getByText('Isolated')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(mocks.deployment).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'deployment-1', workspaceId: 'workspace-1' },
    }));
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('shows a compact linked live tool catalog for a custom deployment', async () => {
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      serverId: null,
      server: null,
      name: 'Private MCP',
      source: 'docker',
      sourceRef: 'ghcr.io/acme/private-mcp:latest',
    });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(screen.getByText('Search the product catalog by keyword.')).toBeInTheDocument();
    expect(screen.queryByText('Search term')).not.toBeInTheDocument();
    expect(screen.queryByText('Input schema')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'search_products' })).toHaveAttribute(
      'href',
      '/app/acme/mcp/deployment-1/tools/search_products',
    );
    expect(screen.getByText('Playground')).toBeInTheDocument();
  });

  it('uses the managed runtime for a self-created remote MCP without an inspector', async () => {
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      name: 'Private remote MCP',
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      marketInstall: null,
      toolkitLinks: [],
      installCfg: { network: 'isolated', env: {}, toolCatalog: tools },
    });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(mocks.listMcpTools).toHaveBeenCalledWith('deployment-1');
    expect(screen.getByRole('link', { name: 'search_products' })).toBeInTheDocument();
    expect(screen.getByTestId('playground')).toHaveAttribute('data-default-runtime', 'true');
    expect(mocks.sandboxFindFirst).not.toHaveBeenCalled();
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });

  it('shows one tool with its complete parameter schema on the scoped detail route', async () => {
    render(await DeploymentToolPage({
      params: Promise.resolve({
        workspace: 'acme',
        deploymentId: 'deployment-1',
        toolName: 'search_products',
      }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'search_products' })).toBeInTheDocument();
    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(screen.getByText('Input schema')).toBeInTheDocument();
    expect(screen.getByText(/"required"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute(
      'href',
      '/app/acme/mcp/deployment-1?tab=tools',
    );
    expect(mocks.deployment).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'deployment-1',
        workspaceId: 'workspace-1',
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
    }));
    expect(mocks.listMcpTools).toHaveBeenCalledWith('deployment-1');
  });

  it('opens a self-created remote tool deep link through its managed runtime', async () => {
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      name: 'Private remote MCP',
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      marketInstall: null,
      toolkitLinks: [],
      installCfg: { network: 'isolated', env: {}, toolCatalog: tools },
    });

    render(await DeploymentToolPage({
      params: Promise.resolve({
        workspace: 'acme', deploymentId: 'deployment-1', toolName: 'search_products',
      }),
    }));

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.sandboxFindFirst).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).toHaveBeenCalledWith('deployment-1');
    expect(screen.getByRole('heading', { level: 1, name: 'search_products' })).toBeInTheDocument();
  });

  it.each(['stopped', 'error'])('keeps a useful empty state while the runtime is %s', async (status) => {
    mocks.status = status;
    mocks.deployment.mockResolvedValue({ ...baseDeployment, status });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(screen.getByText('Tools unavailable')).toBeInTheDocument();
    expect(screen.getByText('Start the deployment to inspect tools.')).toBeInTheDocument();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('keeps the saved tool catalog visible while a deployment is stopped', async () => {
    mocks.status = 'stopped';
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      status: 'stopped',
      installCfg: { network: 'isolated', env: {}, toolCatalog: tools },
    });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(screen.getByText('Search the product catalog by keyword.')).toBeInTheDocument();
    expect(screen.getByText('Tool testing unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Playground')).not.toBeInTheDocument();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('falls back to the verified server catalog for a stopped legacy deployment', async () => {
    mocks.status = 'stopped';
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      status: 'stopped',
      server: {
        ...baseDeployment.server,
        installCfg: { toolCatalog: tools },
      },
    });

    render(await DeploymentToolPage({
      params: Promise.resolve({
        workspace: 'acme',
        deploymentId: 'deployment-1',
        toolName: 'search_products',
      }),
    }));

    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });

  it('treats a live empty catalog as authoritative instead of showing stale tools', async () => {
    mocks.listMcpTools.mockResolvedValue([]);
    mocks.deployment
      .mockResolvedValueOnce({
        ...baseDeployment,
        installCfg: { network: 'isolated', env: {}, toolCatalog: tools },
      })
      .mockResolvedValueOnce({ installCfg: { network: 'isolated', env: {}, toolCatalog: [] } });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(screen.queryByText('Search the product catalog by keyword.')).not.toBeInTheDocument();
    expect(screen.queryByText('Playground')).toBeInTheDocument();
  });

  it('keeps the last complete snapshot when live discovery fails', async () => {
    mocks.listMcpTools.mockResolvedValue([]);
    const deployment = {
      ...baseDeployment,
      installCfg: { network: 'isolated', env: {}, toolCatalog: tools },
    };
    mocks.deployment
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ installCfg: deployment.installCfg });

    render(await DeploymentInspectorPage({
      params: Promise.resolve({ workspace: 'acme', deploymentId: 'deployment-1' }),
      searchParams: Promise.resolve({ tab: 'tools' }),
    }));

    expect(screen.getByText('Search the product catalog by keyword.')).toBeInTheDocument();
  });

  it('redirects a remote tool deep link when its connected sandbox is unavailable', async () => {
    mocks.deployment.mockResolvedValue({
      ...baseDeployment,
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      status: 'stopped',
      marketInstall: { id: 'market-install-1' },
      toolkitLinks: [],
      installCfg: {
        toolCatalog: tools,
        mcpInspector: { sandboxId: 'sandbox-1', connectedAt: '2026-08-29T00:00:00.000Z' },
      },
    });

    await DeploymentToolPage({
      params: Promise.resolve({
        workspace: 'acme', deploymentId: 'deployment-1', toolName: 'search_products',
      }),
    });

    expect(mocks.redirect).toHaveBeenCalledWith('/app/acme/mcp/deployment-1?tab=tools');
    expect(mocks.sandboxFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'sandbox-1', workspaceId: 'workspace-1' }),
    }));
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
  });
});
