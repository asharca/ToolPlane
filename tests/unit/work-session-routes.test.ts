// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  createWorkSession: vi.fn(),
  listWorkSessions: vi.fn(),
  getWorkSessionForUser: vi.fn(),
  archiveWorkSession: vi.fn(),
  findWorkSession: vi.fn(),
  livePort: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRequest: mocks.getAgentForRequest }));
vi.mock('@/lib/work/coordinator', () => ({ kickWorkCoordinator: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { workSession: { findFirst: mocks.findWorkSession } } }));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
}));
vi.mock('@/lib/work/sessions', () => ({
  createWorkSession: mocks.createWorkSession,
  listWorkSessions: mocks.listWorkSessions,
  getWorkSessionForUser: mocks.getWorkSessionForUser,
  archiveWorkSession: mocks.archiveWorkSession,
  normalizeWorkDirectory: (value: unknown) => typeof value === 'string' && !value.startsWith('..') ? value || '.' : null,
  workSessionWorkingDirectory: (value: unknown) => (value as { workingDirectory?: string } | null)?.workingDirectory ?? '.',
}));

import { POST as createWork } from '@/app/api/v1/work-sessions/route';
import { GET as getWork } from '@/app/api/v1/work-sessions/[workSessionId]/route';
import { POST as openWorkTerminal } from '@/app/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]/route';

describe('WorkSession API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getAgentForRequest.mockResolvedValue({ id: 'agent-1', workspaceId: 'workspace-1' });
    mocks.createWorkSession.mockResolvedValue({
      id: 'work-1',
      conversationId: 'conversation-1',
      status: 'queued',
    });
    mocks.findWorkSession.mockResolvedValue({
      workspaceId: 'workspace-1',
      runtimeKind: 'pi',
      sandboxId: 'sandbox-1',
      agent: { id: 'agent-1', sandboxes: [{ sandboxId: 'sandbox-1' }], runtime: null },
      sandbox: { deploymentId: 'deployment-1' },
    });
    mocks.livePort.mockReturnValue(4312);
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('creates and enqueues work with an initial task', async () => {
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', sandboxId: 'sandbox-1', task: 'Run the tests' }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      workSessionId: 'work-1',
      conversationId: 'conversation-1',
      status: 'queued',
    });
    expect(mocks.createWorkSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sandboxId: 'sandbox-1',
      task: 'Run the tests',
      workingDirectory: '.',
    });
  });

  it('rejects a working directory outside the sandbox root', async () => {
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', task: 'Run the tests', workingDirectory: '../private' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.createWorkSession).not.toHaveBeenCalled();
  });

  it('requires a non-empty task', async () => {
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', task: '   ' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
  });

  it('reads a session only through the caller workspace boundary', async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: 'work-1',
      status: 'queued',
      conversation: { messages: [] },
      sandbox: null,
    });
    const response = await getWork(
      new Request('http://toolplane.test/api/v1/work-sessions/work-1'),
      { params: Promise.resolve({ workSessionId: 'work-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getWorkSessionForUser).toHaveBeenCalledWith('user-1', 'work-1');
  });

  it('opens the selected Work sandbox terminal session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"terminal-1"}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await openWorkTerminal(new Request('http://toolplane.test/sandbox/terminal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ workSessionId: 'work-1', path: ['terminal'] }) });

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/terminal/session',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('opens the exact Hermes runtime sandbox and starts it on demand', async () => {
    mocks.findWorkSession.mockResolvedValue({
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      sandboxId: 'sandbox-hermes',
      agent: {
        id: 'agent-hermes',
        sandboxes: [],
        runtime: { kind: 'hermes', sandboxId: 'sandbox-hermes' },
      },
      sandbox: { deploymentId: 'deployment-hermes' },
    });
    mocks.livePort.mockReturnValue(null);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"terminal-1"}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await openWorkTerminal(new Request('http://toolplane.test/sandbox/terminal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ workSessionId: 'work-1', path: ['terminal'] }) });

    expect(response.status).toBe(201);
    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith('workspace-1', 'agent-hermes');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/terminal/session',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not proxy a Work session to another Hermes runtime sandbox', async () => {
    mocks.findWorkSession.mockResolvedValue({
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      sandboxId: 'sandbox-other',
      agent: {
        id: 'agent-hermes',
        sandboxes: [],
        runtime: { kind: 'hermes', sandboxId: 'sandbox-hermes' },
      },
      sandbox: { deploymentId: 'deployment-other' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await openWorkTerminal(new Request('http://toolplane.test/sandbox/terminal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ workSessionId: 'work-1', path: ['terminal'] }) });

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
