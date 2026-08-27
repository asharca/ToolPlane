import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHermesWork, stopHermesWorkRun } from '@/lib/agents/hermes/work';

const mocks = vi.hoisted(() => ({
  ensureHermesRuntimeReady: vi.fn(async () => ({ port: 4312 })),
}));

vi.mock('@/lib/agents/hermes/runtime', () => ({
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
}));

const agent = {
  id: 'agent-1',
  workspaceId: 'workspace-1',
  runtime: { id: 'runtime-1', kind: 'hermes' },
};

describe('Hermes Work runs client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
  });

  it('submits the real runs schema, maps SSE events, and resolves approvals', async () => {
    const stream = [
      'data: {"event":"message.delta","run_id":"run_1","timestamp":1,"delta":"Done"}',
      '',
      'data: {"event":"reasoning.available","run_id":"run_1","timestamp":2,"text":"Plan"}',
      '',
      'data: {"event":"tool.started","run_id":"run_1","timestamp":3,"tool":"terminal","preview":"pnpm test"}',
      '',
      'data: {"event":"tool.completed","run_id":"run_1","timestamp":4,"tool":"terminal","duration":1.25,"error":false}',
      '',
      'data: {"event":"subagent.start","run_id":"run_1","timestamp":5,"subagent_id":"sub_1","goal":"Review"}',
      '',
      'data: {"event":"approval.request","run_id":"run_1","timestamp":6,"command":"pnpm test","description":"Run tests","pattern_key":"shell","pattern_keys":["shell"],"choices":["once","deny"],"allow_permanent":false,"allow_session":true}',
      '',
      'data: {"event":"run.completed","run_id":"run_1","timestamp":7,"output":"Done","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}',
      '',
    ].join('\n');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run_id: 'run_1', status: 'started' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run_id: 'run_1', choice: 'once', resolved: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onRunStarted = vi.fn();
    const onMessageDelta = vi.fn();
    const onReasoningAvailable = vi.fn();
    const onToolStarted = vi.fn();
    const onToolCompleted = vi.fn();
    const onSubagent = vi.fn();
    const onApproval = vi.fn(async () => 'allow' as const);
    const onRunTerminal = vi.fn();

    const result = await runHermesWork({
      agent,
      task: 'Fix the tests.',
      instructions: 'Use pnpm.',
      workingDirectory: 'packages/app',
      sessionId: 'conversation-1',
      sessionKey: 'agent:agent-1:work:conversation-1',
      onRunStarted,
      onMessageDelta,
      onReasoningAvailable,
      onToolStarted,
      onToolCompleted,
      onSubagent,
      onApproval,
      onRunTerminal,
    });

    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4312/hermes/v1/capabilities',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4312/hermes/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-hermes-session-id': 'conversation-1',
          'x-hermes-session-key': 'agent:agent-1:work:conversation-1',
        }),
      }),
    );
    const startBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(startBody).toEqual({
      input: 'Fix the tests.',
      instructions: 'Use pnpm.\n\nThe working directory for this task is /opt/data/workspace/packages/app. Perform and verify the requested work there.',
      session_id: 'conversation-1',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4312/hermes/v1/runs/run_1/approval',
      expect.objectContaining({ body: JSON.stringify({ choice: 'once' }) }),
    );
    expect(onRunStarted).toHaveBeenCalledWith('run_1');
    expect(onRunStarted.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[2]);
    expect(onMessageDelta).toHaveBeenCalledWith({ runId: 'run_1', timestamp: 1, delta: 'Done' });
    expect(onReasoningAvailable).toHaveBeenCalledWith({ runId: 'run_1', timestamp: 2, text: 'Plan' });
    expect(onToolStarted).toHaveBeenCalledWith({
      runId: 'run_1', timestamp: 3, tool: 'terminal', preview: 'pnpm test',
    });
    expect(onToolCompleted).toHaveBeenCalledWith({
      runId: 'run_1', timestamp: 4, tool: 'terminal', duration: 1.25, error: false,
    });
    expect(onSubagent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'subagent.start', runId: 'run_1', subagentId: 'sub_1', goal: 'Review',
    }));
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run_1', command: 'pnpm test', patternKeys: ['shell'], choices: ['once', 'deny'],
    }));
    expect(onRunTerminal).toHaveBeenCalledWith(expect.objectContaining({ event: 'run.completed', output: 'Done' }));
    expect(result).toEqual({
      runId: 'run_1',
      status: 'completed',
      text: 'Done',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });

  it('stops the Hermes run when the caller aborts its event stream', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run_id: 'run_abort', status: 'started' }), { status: 202 }))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        queueMicrotask(() => controller.abort(new Error('cancelled by user')));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run_id: 'run_abort', status: 'stopping' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runHermesWork({
      agent,
      task: 'Long task',
      workingDirectory: '.',
      sessionId: 'conversation-1',
      sessionKey: 'agent:agent-1:work:conversation-1',
      signal: controller.signal,
    })).rejects.toThrow('cancelled by user');

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4312/hermes/v1/runs/run_abort/stop',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });

  it('requires the Hermes 0.20 Work runs capabilities before submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: { run_submission: true },
    }), { status: 200 })));

    await expect(runHermesWork({
      agent,
      task: 'Task',
      workingDirectory: '.',
      sessionId: 'conversation-1',
      sessionKey: 'agent:agent-1:work:conversation-1',
    })).rejects.toThrow('Upgrade this Agent\'s Hermes image');
  });

  it('treats an already-finished run as successfully stopped during reconciliation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stopHermesWorkRun({ agent, runId: 'run_finished' })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/hermes/v1/runs/run_finished/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });
});
