import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectorConfig } from '@/lib/sandboxes/connector';

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: { sandbox: { findMany: mocks.findMany } },
}));

import { findSandboxByConnectorToken } from '@/lib/sandboxes/connector-auth';

describe('connector token lookup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not query for an empty credential', async () => {
    await expect(findSandboxByConnectorToken('')).resolves.toBeNull();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('only considers active connector deployments and matches the token hash', async () => {
    const token = 'mcpcon_active_connector';
    const connector = buildConnectorConfig({
      serverUrl: 'https://app.example.com',
      remoteRoot: 'C:\\Users\\Ada\\ToolPlane',
    }, token);
    mocks.findMany.mockResolvedValue([{
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      name: 'Windows workstation',
      slug: 'windows-workstation',
      config: { connector },
    }]);

    await expect(findSandboxByConnectorToken(token)).resolves.toMatchObject({
      id: 'sb1',
      workspaceId: 'ws1',
      connector: { remoteRoot: 'C:\\Users\\Ada\\ToolPlane' },
    });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        kind: 'connector',
        deployment: { status: { in: ['running', 'provisioning'] } },
      },
    }));
  });
});
