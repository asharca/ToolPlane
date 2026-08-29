// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getMcpPrompt: vi.fn(),
  listMcpPrompts: vi.fn(),
  liveStatus: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: { deployment: { findMany: mocks.findMany } } }));
vi.mock('@/lib/process/supervisor', () => ({ liveStatus: mocks.liveStatus }));
vi.mock('@/lib/process/mcp-client', () => ({
  getMcpPrompt: mocks.getMcpPrompt,
  listMcpPrompts: mocks.listMcpPrompts,
}));

import { resolveAttachedMcpPromptText } from '@/lib/process/mcp-prompts';

const prompt = {
  name: 'summarize',
  arguments: [{ name: 'text', required: true }],
};

describe('MCP prompt resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([{
      id: 'allowed',
      name: 'Prompt server',
      source: 'npm',
      sourceRef: 'prompt-server',
      serverId: null,
      server: null,
    }]);
    mocks.liveStatus.mockReturnValue('running');
    mocks.listMcpPrompts.mockResolvedValue([prompt]);
  });

  it('rejects a deployment that is not attached to the conversation', async () => {
    await expect(resolveAttachedMcpPromptText({
      workspaceId: 'ws1',
      deploymentIds: ['allowed'],
      deploymentId: 'foreign',
      name: 'summarize',
      argumentsValue: { text: 'Hello' },
    })).rejects.toMatchObject({ status: 404 });
    expect(mocks.listMcpPrompts).not.toHaveBeenCalled();
  });

  it('requires declared prompt arguments before resolving', async () => {
    await expect(resolveAttachedMcpPromptText({
      workspaceId: 'ws1',
      deploymentIds: ['allowed'],
      deploymentId: 'allowed',
      name: 'summarize',
      argumentsValue: {},
    })).rejects.toMatchObject({ status: 400 });
    expect(mocks.getMcpPrompt).not.toHaveBeenCalled();
  });

  it('fails closed for non-user-text prompt responses', async () => {
    mocks.getMcpPrompt.mockResolvedValue({
      messages: [{ role: 'assistant', content: { type: 'text', text: 'Not a draft' } }],
    });

    await expect(resolveAttachedMcpPromptText({
      workspaceId: 'ws1',
      deploymentIds: ['allowed'],
      deploymentId: 'allowed',
      name: 'summarize',
      argumentsValue: { text: 'Hello' },
    })).rejects.toMatchObject({ status: 422 });
  });
});
