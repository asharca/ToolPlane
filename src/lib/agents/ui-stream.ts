import 'server-only';

import type { AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';
import type { SandboxRuntimeActivity } from './sandbox-runtime';

type AgentUiChunk =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string };

type AgentUiWriter = { write(chunk: AgentUiChunk): void };

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createNativeUiStreamBridge(writer: AgentUiWriter, prefix: string) {
  const textIds = new Map<number, string>();
  const reasoningIds = new Map<number, string>();
  let sequence = 0;

  function start(kind: 'text' | 'reasoning', contentIndex: number) {
    const ids = kind === 'text' ? textIds : reasoningIds;
    const id = `${prefix}-${kind}-${sequence++}`;
    ids.set(contentIndex, id);
    writer.write({ type: `${kind}-start`, id });
    return id;
  }

  function finishParts(kind: 'text' | 'reasoning') {
    const ids = kind === 'text' ? textIds : reasoningIds;
    for (const id of ids.values()) writer.write({ type: `${kind}-end`, id });
    ids.clear();
  }

  return {
    onEvent(event: AssistantMessageEvent) {
      if (event.type === 'text_start') {
        start('text', event.contentIndex);
      } else if (event.type === 'text_delta') {
        const id = textIds.get(event.contentIndex) ?? start('text', event.contentIndex);
        writer.write({ type: 'text-delta', id, delta: event.delta });
      } else if (event.type === 'text_end') {
        const id = textIds.get(event.contentIndex);
        if (id) writer.write({ type: 'text-end', id });
        textIds.delete(event.contentIndex);
      } else if (event.type === 'thinking_start') {
        start('reasoning', event.contentIndex);
      } else if (event.type === 'thinking_delta') {
        const id = reasoningIds.get(event.contentIndex) ?? start('reasoning', event.contentIndex);
        writer.write({ type: 'reasoning-delta', id, delta: event.delta });
      } else if (event.type === 'thinking_end') {
        const id = reasoningIds.get(event.contentIndex);
        if (id) writer.write({ type: 'reasoning-end', id });
        reasoningIds.delete(event.contentIndex);
      } else if (event.type === 'toolcall_end') {
        writer.write({
          type: 'tool-input-start',
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
        });
        writer.write({
          type: 'tool-input-available',
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          input: event.toolCall.arguments,
        });
      }
    },
    onToolResult(toolCall: ToolCall, output: unknown, isError: boolean) {
      writer.write(isError
        ? { type: 'tool-output-error', toolCallId: toolCall.id, errorText: errorText(output) }
        : { type: 'tool-output-available', toolCallId: toolCall.id, output });
    },
    finish() {
      finishParts('reasoning');
      finishParts('text');
    },
  };
}

export function createSandboxUiStreamBridge(writer: AgentUiWriter, prefix: string) {
  const toolNames = new Map<string, string>();
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();
  let textId: string | null = null;
  let reasoningId: string | null = null;
  let sequence = 0;

  function endText() {
    if (!textId) return;
    writer.write({ type: 'text-end', id: textId });
    textId = null;
  }

  function endReasoning() {
    if (!reasoningId) return;
    writer.write({ type: 'reasoning-end', id: reasoningId });
    reasoningId = null;
  }

  return {
    onTextDelta(delta: string) {
      endReasoning();
      if (!textId) {
        textId = `${prefix}-text-${sequence++}`;
        writer.write({ type: 'text-start', id: textId });
      }
      writer.write({ type: 'text-delta', id: textId, delta });
    },
    onActivity(activity: SandboxRuntimeActivity) {
      endText();
      if (activity.type === 'reasoning') {
        if (activity.status === 'running') {
          if (!reasoningId) {
            reasoningId = `${prefix}-reasoning-${sequence++}`;
            writer.write({ type: 'reasoning-start', id: reasoningId });
          }
          if (activity.delta) {
            writer.write({ type: 'reasoning-delta', id: reasoningId, delta: activity.delta });
          }
        } else {
          endReasoning();
        }
        return;
      }

      endReasoning();
      const toolCallId = activity.toolCallId;
      if (!toolCallId || completedTools.has(toolCallId)) return;
      const toolName = activity.toolName ?? toolNames.get(toolCallId) ?? 'tool';
      toolNames.set(toolCallId, toolName);
      if (!startedTools.has(toolCallId)) {
        startedTools.add(toolCallId);
        writer.write({ type: 'tool-input-start', toolCallId, toolName });
        writer.write({
          type: 'tool-input-available',
          toolCallId,
          toolName,
          input: activity.input ?? {},
        });
      }
      if (activity.status === 'running') return;

      completedTools.add(toolCallId);
      writer.write(activity.isError || activity.status === 'failed'
        ? { type: 'tool-output-error', toolCallId, errorText: errorText(activity.output ?? 'Tool failed') }
        : { type: 'tool-output-available', toolCallId, output: activity.output ?? null });
    },
    finish() {
      endReasoning();
      endText();
    },
  };
}
