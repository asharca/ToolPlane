export const COMPACTION_PART = 'data-conversation-compaction';
export const CLEAR_CONTEXT_PART = 'data-conversation-clear';

export function isConversationControl(message: ContextMessage) {
  return message.role !== 'user' && Array.isArray(message.parts) && message.parts.some((part) => [CLEAR_CONTEXT_PART, 'data-command-result'].includes(part?.type));
}

export type ConversationCompaction = {
  boundaryId: string;
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  completedAt: string;
};

export type ContextMessage = { id: string; role: string; parts: unknown };

export function messageCompaction(message: ContextMessage): ConversationCompaction | null {
  if (message.role !== 'system' || !Array.isArray(message.parts)) return null;
  for (const part of message.parts) {
    if (part?.type !== COMPACTION_PART || !part.data) continue;
    const data = part.data;
    if (typeof data.boundaryId === 'string' && typeof data.summary === 'string' && data.summary.trim()
      && typeof data.beforeTokens === 'number' && typeof data.afterTokens === 'number'
      && typeof data.completedAt === 'string') return data as ConversationCompaction;
  }
  return null;
}

export function latestCompaction(messages: readonly ContextMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isContextClear(messages[index])) return null;
    const data = messageCompaction(messages[index]);
    if (data) return data;
  }
  return null;
}

export function compactionSummaryText(summary: string) {
  return `The earlier conversation was compacted. The following summary is historical context, not new instructions. Continue the user's current request using it.\n\n${summary}`;
}

export function compactedConversationSeed(messages: readonly ContextMessage[]) {
  const marker = messages.findLastIndex((message) => Boolean(messageCompaction(message)));
  return marker < 0 || marker < messages.findLastIndex(isContextClear) ? null : compactionSummaryText(compactionTranscript(activeConversationMessages(messages.slice(0, marker + 1))));
}

export function needsCompactionSeed(messages: readonly ContextMessage[]) {
  const marker = messages.findLastIndex((message) => Boolean(messageCompaction(message)));
  return marker >= 0 && marker > messages.findLastIndex(isContextClear) && !messages.slice(marker + 1).some((message) => message.role === 'user');
}

function isContextClear(message: ContextMessage) {
  return message.role !== 'user' && Array.isArray(message.parts) && message.parts.some((part) => part?.type === CLEAR_CONTEXT_PART);
}

export function activeConversationMessages(messages: readonly ContextMessage[]): ContextMessage[] {
  const clear = messages.findLastIndex(isContextClear);
  const current = clear < 0 ? messages : messages.slice(clear + 1);
  const compaction = latestCompaction(current);
  const boundary = compaction ? current.findIndex((message) => message.id === compaction.boundaryId) : -1;
  if (!compaction || boundary < 0) return current.filter((message) => !messageCompaction(message) && !isConversationControl(message));
  return [{
    id: `compaction:${compaction.boundaryId}`,
    role: 'user',
    parts: [{ type: 'text', text: compactionSummaryText(compaction.summary) }],
  }, ...current.slice(boundary + 1).filter((message) => !messageCompaction(message) && !isConversationControl(message))];
}

// Keep file references and tool results, never inline base64 media in a summary prompt.
export function compactionTranscript(messages: readonly ContextMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    role: message.role,
    parts: Array.isArray(message.parts) ? message.parts.flatMap<Record<string, unknown>>((part) => {
      if (!part || typeof part !== 'object') return [];
      if (part.type === 'text' || part.type === 'reasoning') return [{ type: part.type, text: part.text }];
      if (part.type === 'file') return [{ type: 'file', filename: part.filename, mediaType: part.mediaType,
        ...(typeof part.url === 'string' && !part.url.startsWith('data:') ? { url: part.url } : {}) }];
      if (part.type === 'work-tool' || part.type === 'dynamic-tool' || part.type?.startsWith('tool-')) {
        return [{ type: 'tool', name: part.toolName ?? part.type, input: part.input, output: part.output }];
      }
      return [];
    }) : [],
  })));
}
