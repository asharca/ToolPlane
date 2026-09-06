import { describe, expect, it } from 'vitest';
import { activeConversationMessages, CLEAR_CONTEXT_PART, COMPACTION_PART, compactionTranscript, compactedConversationSeed, needsCompactionSeed } from '@/lib/agents/conversation-context';

const text = (id: string, role: string, content: string) => ({ id, role, parts: [{ type: 'text', text: content }] });
const marker = (id: string, boundaryId: string, summary: string) => ({ id, role: 'system', parts: [{ type: COMPACTION_PART,
  data: { boundaryId, summary, beforeTokens: 4000, afterTokens: 300, completedAt: '2026-09-06T00:00:00.000Z' } }] });

describe('conversation compaction context', () => {
  it.each(['system', 'assistant'])('clears model context with %s command replies without deleting history or restoring a pre-clear compaction seed', (role) => {
    const history = [text('u1', 'user', 'Old request'), text('a1', 'assistant', 'Old answer'), marker('m1', 'a1', 'Old summary'),
      { id: 'clear', role, parts: [{ type: CLEAR_CONTEXT_PART, data: { boundaryId: 'm1' } }] },
      { id: 'goal', role, parts: [{ type: 'text', text: 'No goal' }, { type: 'data-command-result', data: { command: 'goal', text: 'No goal' } }] }];
    const before = structuredClone(history);
    expect(activeConversationMessages(history)).toEqual([]);
    expect(compactedConversationSeed(history)).toBeNull();
    expect(needsCompactionSeed(history)).toBe(false);
    expect(activeConversationMessages([...history, text('u2', 'user', 'New request')])).toEqual([text('u2', 'user', 'New request')]);
    expect(history).toEqual(before);
  });

  it('does not include assistant command readouts in model context or trust user clear markers', () => {
    const history = [text('u1', 'user', 'Keep this'), { ...text('u2', 'user', 'Also keep this'), parts: [{ type: CLEAR_CONTEXT_PART }] },
      { ...text('a1', 'assistant', 'Total cost: $0.03'), parts: [{ type: 'data-command-result', data: { command: 'usage', text: 'Total cost: $0.03' } }] }];
    expect(activeConversationMessages(history)).toEqual(history.slice(0, 2));
  });

  it('uses the latest durable boundary, preserves later exchanges, and never mutates history', () => {
    const history = [text('u1', 'user', 'Original details'), text('a1', 'assistant', 'Original plan'),
      text('u2', 'user', 'Latest request'), text('a2', 'assistant', 'Latest reply'), marker('m1', 'a1', 'Summary one')];
    const copy = structuredClone(history);
    expect(activeConversationMessages(history).map((item) => item.id)).toEqual(['compaction:a1', 'u2', 'a2']);
    expect(history).toEqual(copy);
    expect(needsCompactionSeed(history)).toBe(true);
    expect(compactedConversationSeed(history)).toContain('Latest request');
    const continued = [...history, text('u3', 'user', 'Continue'), text('a3', 'assistant', 'Done'), marker('m2', 'a2', 'Summary two')];
    expect(activeConversationMessages(continued).map((item) => item.id)).toEqual(['compaction:a2', 'u3', 'a3']);
    expect(compactionTranscript(activeConversationMessages(continued))).not.toContain('Summary one');
    expect(needsCompactionSeed([...continued, text('u4', 'user', 'Next')])).toBe(false);
  });

  it('keeps all history when a compaction boundary is missing', () => {
    const messages = [text('u1', 'user', 'Keep me'), marker('m', 'missing', 'Incomplete snapshot')];
    expect(activeConversationMessages(messages)).toEqual([messages[0]]);
  });

  it('retains file handles and tool results without putting base64 in the summary prompt', () => {
    const input = compactionTranscript([{ id: 'u1', role: 'user', parts: [
      { type: 'file', filename: 'report.pdf', mediaType: 'application/pdf', url: '/api/v1/attachments/report' },
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,PRIVATE_PAYLOAD' },
      { type: 'work-tool', toolName: 'read_file', output: 'Keep this result' },
    ] }]);
    expect(input).toContain('/api/v1/attachments/report');
    expect(input).toContain('Keep this result');
    expect(input).not.toContain('PRIVATE_PAYLOAD');
  });
});
