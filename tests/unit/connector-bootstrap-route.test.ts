import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSandboxByConnectorToken: vi.fn(),
  ensureConnectorBroker: vi.fn(),
  connectorPublicWsUrl: vi.fn(),
}));

vi.mock('@/lib/sandboxes/connector-auth', () => ({
  findSandboxByConnectorToken: mocks.findSandboxByConnectorToken,
}));
vi.mock('@/lib/sandboxes/connector-broker', () => ({
  ensureConnectorBroker: mocks.ensureConnectorBroker,
  connectorPublicWsUrl: mocks.connectorPublicWsUrl,
}));

import { GET } from '@/app/api/v1/connectors/bootstrap/route';

describe('connector bootstrap authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectorPublicWsUrl.mockReturnValue('wss://app.example.com/connect');
  });

  it('rejects query-string credentials', async () => {
    mocks.findSandboxByConnectorToken.mockResolvedValue(null);

    const response = await GET(new Request('https://app.example.com/api/v1/connectors/bootstrap?token=mcpcon_leaked'));

    expect(response.status).toBe(401);
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledWith('');
    expect(mocks.ensureConnectorBroker).not.toHaveBeenCalled();
  });

  it('accepts a Bearer token and returns a credential-free WebSocket URL', async () => {
    mocks.findSandboxByConnectorToken.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      name: 'Windows workstation',
      slug: 'windows-workstation',
      connector: {
        serverUrl: 'https://app.example.com',
        remoteRoot: 'C:\\Users\\Ada\\ToolPlane',
      },
    });

    const response = await GET(new Request('https://app.example.com/api/v1/connectors/bootstrap', {
      headers: { authorization: 'Bearer mcpcon_secret' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledWith('mcpcon_secret');
    expect(mocks.ensureConnectorBroker).toHaveBeenCalledOnce();
    expect(mocks.connectorPublicWsUrl).toHaveBeenCalledWith('https://app.example.com');
    expect(body).toMatchObject({
      root: 'C:\\Users\\Ada\\ToolPlane',
      wsUrl: 'wss://app.example.com/connect',
    });
    expect(JSON.stringify(body)).not.toContain('mcpcon_secret');
  });
});
