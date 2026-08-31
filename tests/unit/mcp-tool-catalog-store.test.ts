import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  liveRedactionValues: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { deployment: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));
vi.mock('@/lib/process/supervisor', () => ({
  liveRedactionValues: mocks.liveRedactionValues,
}));

import { persistDeploymentMcpToolCatalog } from '@/lib/process/mcp-tool-catalog-store';

describe('persistDeploymentMcpToolCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.liveRedactionValues.mockReturnValue([]);
  });

  it('updates only the tool snapshot while preserving private deployment config', async () => {
    const updatedAt = new Date();
    mocks.findUnique.mockResolvedValue({
      source: 'config',
      updatedAt,
      installCfg: { command: 'npx', env: { API_KEY: 'private-value', GITHUB_TOOLSETS: 'all' } },
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(persistDeploymentMcpToolCatalog('dep-1', [
      {
        name: 'search',
        description: 'Search all safely; never echo private-value.',
        inputSchema: { type: 'object' },
        env: { API_KEY: 'leak' },
      },
    ])).resolves.toEqual([{
      name: 'search',
      description: 'Search all safely; never echo [REDACTED].',
      inputSchema: { type: 'object' },
    }]);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'dep-1', updatedAt },
      data: {
        installCfg: {
          command: 'npx',
          env: { API_KEY: 'private-value', GITHUB_TOOLSETS: 'all' },
          toolCatalog: [{
            name: 'search',
            description: 'Search all safely; never echo [REDACTED].',
            inputSchema: { type: 'object' },
          }],
        },
      },
    });
  });

  it('does not replace a snapshot when credential redaction is unsafe', async () => {
    mocks.findUnique.mockResolvedValue({
      source: 'config',
      updatedAt: new Date(),
      installCfg: {
        env: { API_KEY: 'credential-name' },
        toolCatalog: [{ name: 'previous-tool' }],
      },
    });

    await expect(persistDeploymentMcpToolCatalog('dep-1', [
      { name: 'credential-name', inputSchema: { type: 'object' } },
    ])).resolves.toEqual([]);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('redacts sensitive argv and runtime-file values held only by the live supervisor', async () => {
    const updatedAt = new Date();
    mocks.findUnique.mockResolvedValue({
      source: 'config',
      updatedAt,
      installCfg: { command: 'docker', env: {} },
    });
    mocks.liveRedactionValues.mockReturnValue(['argv-password', 'config-file-password']);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(persistDeploymentMcpToolCatalog('dep-1', [{
      name: 'search',
      description: 'argv-password must stay private',
      inputSchema: {
        type: 'object',
        properties: { password: { default: 'config-file-password' } },
      },
    }])).resolves.toEqual([{
      name: 'search',
      description: '[REDACTED] must stay private',
      inputSchema: {
        type: 'object',
        properties: { password: { default: '[REDACTED]' } },
      },
    }]);

    expect(mocks.liveRedactionValues).toHaveBeenCalledWith('dep-1');
    expect(JSON.stringify(mocks.updateMany.mock.calls)).not.toContain('argv-password');
    expect(JSON.stringify(mocks.updateMany.mock.calls)).not.toContain('config-file-password');
  });

  it('uses request-time redaction values after the live entry disappears', async () => {
    mocks.findUnique.mockResolvedValue({
      source: 'config',
      updatedAt: new Date(),
      installCfg: { command: 'docker', env: {} },
    });
    mocks.liveRedactionValues.mockReturnValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(persistDeploymentMcpToolCatalog('dep-1', [{
      name: 'search',
      description: 'response-after-exit-secret',
      inputSchema: { type: 'object' },
    }], ['response-after-exit-secret'])).resolves.toEqual([{
      name: 'search',
      description: '[REDACTED]',
      inputSchema: { type: 'object' },
    }]);
    expect(JSON.stringify(mocks.updateMany.mock.calls)).not.toContain('response-after-exit-secret');
  });
});
