// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  finishWorkOutput,
  publishWorkActivity,
  publishWorkOutput,
  startWorkOutput,
  subscribeWorkOutput,
  type WorkOutputEvent,
} from '@/lib/work/run-control';

describe('Work output channel', () => {
  it('replays accumulated output to late subscribers and reports completion', () => {
    const workSessionId = 'work-output-replay';
    const events: WorkOutputEvent[] = [];
    const first = subscribeWorkOutput(workSessionId, (event) => events.push(event));

    expect(first.snapshot).toEqual({ text: '', activities: [], active: false, done: false });
    startWorkOutput(workSessionId);
    publishWorkActivity(workSessionId, {
      id: 'tool:call-1', type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'read_file', input: '{}',
    });
    publishWorkActivity(workSessionId, {
      id: 'tool:call-1', type: 'tool', status: 'completed', toolCallId: 'call-1', toolName: 'read_file', output: 'done',
    });
    publishWorkOutput(workSessionId, 'Hel');
    publishWorkOutput(workSessionId, 'lo');

    const late = subscribeWorkOutput(workSessionId, () => {});
    expect(late.snapshot).toEqual({
      text: 'Hello',
      activities: [{
        id: 'tool:call-1', type: 'tool', status: 'completed', toolCallId: 'call-1', toolName: 'read_file', input: '{}', output: 'done',
      }],
      active: true,
      done: false,
    });

    finishWorkOutput(workSessionId);
    expect(events.map((event) => event.type)).toEqual(['start', 'activity', 'activity', 'delta', 'delta', 'done']);
    expect(events.at(-1)?.snapshot).toEqual({
      text: 'Hello', activities: late.snapshot.activities, active: false, done: true,
    });

    const finished = subscribeWorkOutput(workSessionId, () => {});
    expect(finished.snapshot).toEqual({
      text: 'Hello', activities: late.snapshot.activities, active: false, done: true,
    });

    startWorkOutput(workSessionId);
    const nextTurn = subscribeWorkOutput(workSessionId, () => {});
    expect(nextTurn.snapshot).toEqual({ text: '', activities: [], active: true, done: false });
    finishWorkOutput(workSessionId);
    first.unsubscribe();
    late.unsubscribe();
    finished.unsubscribe();
    nextTurn.unsubscribe();
  });
});
