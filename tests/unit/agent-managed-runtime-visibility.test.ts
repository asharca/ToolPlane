// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindMany: vi.fn(),
  agentFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    agent: {
      findMany: mocks.agentFindMany,
      findFirst: mocks.agentFindFirst,
    },
  },
}));

import {
  getAgent,
  getAgentEndpointRuntimeForExecution,
  getAgentForRequest,
  getAgentForRun,
  getAgentPageData,
  getHermesTerminalForRequest,
  listAgents,
} from '@/lib/agents/queries';

describe('managed public runtime Agent visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentFindMany.mockResolvedValue([]);
    mocks.agentFindFirst.mockResolvedValue(null);
  });

  it('excludes managed runtime Agents from ordinary list and detail queries', async () => {
    await listAgents('workspace-1');
    expect(mocks.agentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      where: {
        workspaceId: 'workspace-1',
        publicRuntimeAllocation: { is: null },
        NOT: expect.objectContaining({ runtime: expect.any(Object) }),
      },
    }));

    await getAgentPageData('workspace-1', 'runtime-agent-1');
    expect(mocks.agentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        id: 'runtime-agent-1',
        workspaceId: 'workspace-1',
        publicRuntimeAllocation: { is: null },
        NOT: expect.objectContaining({ runtime: expect.any(Object) }),
      },
    }));
  });

  it('blocks console chat, terminal, and sub-agent loaders from reaching a managed runtime', async () => {
    await getAgentForRequest('runtime-agent-1', 'user-1');
    expect(mocks.agentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ publicRuntimeAllocation: { is: null } }),
    }));

    await getHermesTerminalForRequest('runtime-agent-1', 'user-1');
    expect(mocks.agentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ publicRuntimeAllocation: { is: null } }),
    }));

    await getAgentForRun('runtime-agent-1', 'workspace-1');
    expect(mocks.agentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ publicRuntimeAllocation: { is: null } }),
    }));
  });

  it('keeps the internal lifecycle loader able to resolve a managed runtime', async () => {
    await getAgent('workspace-1', 'runtime-agent-1');
    const call = mocks.agentFindFirst.mock.calls.at(-1)?.[0];
    expect(call.where).toEqual({ id: 'runtime-agent-1', workspaceId: 'workspace-1' });
    expect(call.include.publicRuntimeAllocation).toEqual(expect.objectContaining({
      select: expect.objectContaining({ revisionId: true }),
    }));

    await getAgentEndpointRuntimeForExecution(
      'workspace-1',
      'runtime-agent-1',
      'allocation-1',
    );
    expect(mocks.agentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        id: 'runtime-agent-1',
        workspaceId: 'workspace-1',
        publicRuntimeAllocation: {
          is: { id: 'allocation-1', status: 'ready' },
        },
      },
    }));
  });
});
