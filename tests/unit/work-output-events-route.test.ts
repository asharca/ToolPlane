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
    startWorkOutput('work-live');
    const response = await request('work-live');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    publishWorkOutput('work-live', 'Hel');
    publishWorkActivity('work-live', {
      id: 'tool:call-1', type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'read_file', input: '{}',
    });
    publishWorkOutput('work-live', 'lo');
    finishWorkOutput('work-live');

    const body = await response.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('event: delta');
    expect(body).toContain('event: activity');
    expect(body).toContain('"toolName":"read_file"');
    expect(body).toContain('"text":"Hello"');
    expect(body).toContain('"delta":"lo"');
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
            { type: 'work-tool', toolCallId: 'call-1', toolName: 'read_file', input: '{}', output: 'done', isError: false },
            { type: 'text', text: 'Current result' },
          ] },
        ],
      },
    });

    const response = await request('work-finished');
    const body = await response.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('"text":"Current result"');
    expect(body).toContain('"toolName":"read_file"');
    expect(body).not.toContain('Previous turn');
    expect(body).toContain('event: done');
  });
});
