// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getWorkSessionForUser: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/work/sessions', () => ({ getWorkSessionForUser: mocks.getWorkSessionForUser }));

import { GET } from '@/app/api/v1/work-sessions/[workSessionId]/events/route';
import {
  finishWorkOutput,
  publishWorkActivity,
  publishWorkOutput,
  startWorkOutput,
} from '@/lib/work/run-control';

function request(workSessionId: string) {
  return GET(
    new Request(`http://toolplane.test/api/v1/work-sessions/${workSessionId}/events`),
    { params: Promise.resolve({ workSessionId }) },
  );
}

describe('Work output events route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
  });

  it('enforces authentication and the Work workspace boundary', async () => {
    mocks.resolveRequestUser.mockResolvedValueOnce(null);
    expect((await request('work-private')).status).toBe(401);

    mocks.getWorkSessionForUser.mockResolvedValueOnce(null);
    expect((await request('work-missing')).status).toBe(404);
    expect(mocks.getWorkSessionForUser).toHaveBeenCalledWith('user-1', 'work-missing');
  });

  it('streams replayable deltas and closes after completion', async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: 'work-live',
      status: 'running',
      conversation: { messages: [] },
    });
    startWorkOutput('work-live', { startedAt: 1_700_000_000_000, runtimeKind: 'pi', modelName: 'model-a' });
    const response = await request('work-live');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    publishWorkOutput('work-live', 'Hel');
    publishWorkActivity('work-live', {
      id: 'tool:call-1', type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'read_file',
      deploymentName: 'Filesystem MCP', originalToolName: 'read/file', input: '{}',
    });
    publishWorkOutput('work-live', 'lo');
    finishWorkOutput('work-live');

    const body = await response.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('event: delta');
    expect(body).toContain('event: activity');
    expect(body).toContain('"toolName":"read_file"');
    expect(body).toContain('"deploymentName":"Filesystem MCP"');
    expect(body).toContain('"originalToolName":"read/file"');
    expect(body).toContain('"text":"Hello"');
    expect(body).toContain('"delta":"lo"');
    expect(body).toContain('"startedAt":1700000000000');
    expect(body).toContain('"runtimeKind":"pi"');
    expect(body).toContain('"modelName":"model-a"');
    expect(body).toContain('event: done');
    expect(body).toContain('data: [DONE]');
  });

  it('replays the latest turn from the database when Work already ended', async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: 'work-finished',
      status: 'idle',
      conversation: {
        messages: [
          { role: 'assistant', parts: [{ type: 'text', text: 'Previous turn' }] },
          { role: 'user', parts: [{ type: 'text', text: 'Current turn' }] },
          { role: 'assistant', parts: [
            {
              type: 'work-tool', toolCallId: 'call-1', toolName: 'read_file',
              deploymentName: 'Filesystem MCP', originalToolName: 'read/file', durationMs: 1200,
              input: '{}', output: 'done', isError: false,
            },
            { type: 'text', text: 'Current result' },
            {
              type: 'data-work-timing',
              data: { startedAt: 1_700_000_000_000, completedAt: 1_700_000_029_000, durationMs: 29_000, runtimeKind: 'pi', modelName: 'model-a' },
            },
          ] },
        ],
      },
    });

    const response = await request('work-finished');
    const body = await response.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('"text":"Current result"');
    expect(body).toContain('"toolName":"read_file"');
    expect(body).toContain('"deploymentName":"Filesystem MCP"');
    expect(body).toContain('"originalToolName":"read/file"');
    expect(body).toContain('"durationMs":1200');
    expect(body).toContain('"startedAt":1700000000000');
    expect(body).toContain('"runtimeKind":"pi"');
    expect(body).toContain('"modelName":"model-a"');
    expect(body).not.toContain('Previous turn');
    expect(body).toContain('event: done');
  });

  it('replays persisted process activities in their original order', async () => {
    mocks.getWorkSessionForUser.mockResolvedValue({
      id: 'work-ordered',
      status: 'failed',
      conversation: {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Trace this' }] },
          { role: 'assistant', parts: [
            { type: 'reasoning', text: 'First thought' },
            { type: 'work-tool', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'README.md' }, status: 'running' },
            { type: 'work-runtime', runtimeKind: 'pi', status: 'failed' },
            { type: 'work-tool', toolCallId: 'call-1', toolName: 'read_file', output: 'contents', status: 'completed' },
            { type: 'reasoning', text: 'Second thought' },
          ] },
        ],
      },
    });

    const body = await (await request('work-ordered')).text();
    const snapshot = JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)?.[1] ?? '{}') as {
      activities: Array<{ id: string; type: string; status: string; text?: string; output?: unknown }>;
    };
    expect(snapshot.activities.map(({ id, type, status }) => ({ id, type, status }))).toEqual([
      { id: 'reasoning:1', type: 'reasoning', status: 'completed' },
      { id: 'tool:call-1', type: 'tool', status: 'completed' },
      { id: 'runtime:1', type: 'runtime', status: 'failed' },
      { id: 'reasoning:2', type: 'reasoning', status: 'completed' },
    ]);
    expect(snapshot.activities[1]).toMatchObject({ output: 'contents' });
  });
});
