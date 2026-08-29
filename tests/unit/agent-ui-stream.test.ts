// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeUiStreamBridge,
  createSandboxUiStreamBridge,
} from '@/lib/agents/ui-stream';

describe('agent UI stream bridges', () => {
  it('preserves reasoning, tools, and final text in execution order', () => {
    const write = vi.fn();
    const native = createNativeUiStreamBridge({ write }, 'native');

    native.onEvent({ type: 'thinking_delta', contentIndex: 0, delta: 'Planning' } as never);
    native.onEvent({
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 'call-1', name: 'web_search', arguments: { query: 'ToolPlane' } },
    } as never);
    native.onToolResult({ id: 'call-1' } as never, { content: [] }, false);
    native.onEvent({ type: 'text_delta', contentIndex: 2, delta: 'Done' } as never);
    native.finish();

    expect(write.mock.calls.map(([chunk]) => chunk.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'text-start',
      'text-delta',
      'reasoning-end',
      'text-end',
    ]);

    write.mockClear();
    const sandbox = createSandboxUiStreamBridge({ write }, 'sandbox');
    sandbox.onActivity({ type: 'reasoning', status: 'running', delta: 'Inspecting' });
    sandbox.onActivity({ type: 'tool', status: 'running', toolCallId: 'call-2', toolName: 'fetch', input: { url: 'https://example.com' } });
    sandbox.onActivity({ type: 'tool', status: 'completed', toolCallId: 'call-2', output: 'ok' });
    sandbox.onTextDelta('Answer');
    sandbox.finish();

    expect(write.mock.calls.map(([chunk]) => chunk.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'text-start',
      'text-delta',
      'text-end',
    ]);
  });
});
