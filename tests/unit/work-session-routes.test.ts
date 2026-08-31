// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  createWorkSession: vi.fn(),
  listWorkSessions: vi.fn(),
  getWorkSessionForUser: vi.fn(),
  appendWorkSessionInput: vi.fn(),
  archiveWorkSession: vi.fn(),
  findWorkSession: vi.fn(),
  livePort: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
  prepareHermesConversationSelection: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRequest: mocks.getAgentForRequest }));
vi.mock('@/lib/work/coordinator', () => ({ kickWorkCoordinator: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { workSession: { findFirst: mocks.findWorkSession } } }));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
}));
vi.mock('@/lib/agents/hermes/conversation-selection', () => ({
  prepareHermesConversationSelection: mocks.prepareHermesConversationSelection,
}));
vi.mock('@/lib/work/sessions', () => ({
  createWorkSession: mocks.createWorkSession,
  listWorkSessions: mocks.listWorkSessions,
  getWorkSessionForUser: mocks.getWorkSessionForUser,
  appendWorkSessionInput: mocks.appendWorkSessionInput,
  archiveWorkSession: mocks.archiveWorkSession,
  normalizeWorkDirectory: (value: unknown) => typeof value === 'string' && !value.startsWith('..') ? value || '.' : null,
  workSessionWorkingDirectory: (value: unknown) => (value as { workingDirectory?: string } | null)?.workingDirectory ?? '.',
}));

import { POST as createWork } from '@/app/api/v1/work-sessions/route';
import { GET as getWork } from '@/app/api/v1/work-sessions/[workSessionId]/route';
import { POST as appendWorkInput } from '@/app/api/v1/work-sessions/[workSessionId]/input/route';
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
    mocks.appendWorkSessionInput.mockResolvedValue({ ok: true, changed: true, status: 'queued' });
    mocks.findWorkSession.mockResolvedValue({
      workspaceId: 'workspace-1',
      runtimeKind: 'pi',
      sandboxId: 'sandbox-1',
      agent: { id: 'agent-1', sandboxes: [{ sandboxId: 'sandbox-1' }], runtime: null },
      sandbox: { deploymentId: 'deployment-1' },
    });
    mocks.livePort.mockReturnValue(4312);
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
    mocks.prepareHermesConversationSelection.mockImplementation(async (_agent, selection) => selection);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('creates and enqueues work with an initial task', async () => {
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-1',
        sandboxId: 'sandbox-1',
        task: 'Run the tests',
        reasoningEffort: 'high',
      }),
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
      reasoningEffort: 'high',
      workingDirectory: '.',
    });
  });

  it('rejects an unsupported Work reasoning effort', async () => {
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', task: 'Run the tests', reasoningEffort: 'ultra' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
  });

  it('validates and forwards a Hermes model selected for the new Work conversation', async () => {
    const agent = {
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'hermes',
      runtime: {
        kind: 'hermes',
        sandboxId: 'sandbox-1',
        sandbox: { workspaceId: 'workspace-1', kind: 'hermes', network: 'bridge' },
      },
    };
    mocks.getAgentForRequest.mockResolvedValueOnce(agent);
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-1',
        task: 'Run the tests',
        hermesProfile: 'research',
        hermesProvider: 'openrouter',
        hermesModel: 'model-b',
      }),
    }));

    expect(response.status).toBe(202);
    expect(mocks.prepareHermesConversationSelection).toHaveBeenCalledWith(agent, {
      profile: 'research',
      provider: 'openrouter',
      model: 'model-b',
    });
    expect(mocks.createWorkSession).toHaveBeenCalledWith(expect.objectContaining({
      hermesSelection: { profile: 'research', provider: 'openrouter', model: 'model-b' },
    }));
  });

  it('rejects an incomplete Hermes provider and model pair', async () => {
    mocks.getAgentForRequest.mockResolvedValueOnce({ id: 'agent-1', workspaceId: 'workspace-1', runtimeKind: 'hermes' });
    const response = await createWork(new Request('http://toolplane.test/api/v1/work-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', task: 'Run the tests', hermesProfile: 'default', hermesProvider: 'openrouter' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.prepareHermesConversationSelection).not.toHaveBeenCalled();
    expect(mocks.createWorkSession).not.toHaveBeenCalled();
  });

  it('updates a scoped Work conversation reasoning effort before requeueing', async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: 'work-1',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      runtimeSnapshot: null,
      sandbox: { id: 'sandbox-1' },
    });
    const response = await appendWorkInput(new Request('http://toolplane.test/api/v1/work-sessions/work-1/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Continue', reasoningEffort: 'low' }),
    }), { params: Promise.resolve({ workSessionId: 'work-1' }) });

    expect(response.status).toBe(202);
    expect(mocks.getWorkSessionForUser).toHaveBeenCalledWith('user-1', 'work-1');
    expect(mocks.appendWorkSessionInput).toHaveBeenCalledWith(
      'workspace-1',
      'work-1',
      'Continue',
      { reasoningEffort: 'low' },
    );
  });

  it('rejects an unsupported effort before loading a Work session', async () => {
    const response = await appendWorkInput(new Request('http://toolplane.test/api/v1/work-sessions/work-1/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Continue', reasoningEffort: 'ultra' }),
    }), { params: Promise.resolve({ workSessionId: 'work-1' }) });

    expect(response.status).toBe(400);
    expect(mocks.getWorkSessionForUser).not.toHaveBeenCalled();
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
