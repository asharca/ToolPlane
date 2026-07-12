import type { UIMessage } from 'ai';

export type HermesAssistantSegment = {
  id: string;
  text: string;
};

export type HermesTurnMessages = {
  segments: HermesAssistantSegment[];
};

export type HermesUIData = {
  'hermes-messages': HermesTurnMessages;
};

export type HermesUIMessage = UIMessage<unknown, HermesUIData>;

type MessagePartLike = {
  type: string;
  data?: unknown;
};

export function hermesAssistantSegments(parts: readonly MessagePartLike[]): HermesAssistantSegment[] {
  const transcript = parts.find((part) => part.type === 'data-hermes-messages');
  if (!transcript || !transcript.data || typeof transcript.data !== 'object') return [];
  const segments = (transcript.data as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) return [];
  return segments.flatMap((segment) => {
    if (!segment || typeof segment !== 'object') return [];
    const { id, text } = segment as { id?: unknown; text?: unknown };
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof text !== 'string' || !text.trim()) {
      return [];
    }
    return [{ id: String(id), text }];
  });
}

export function expandHermesAssistantMessages(messages: readonly HermesUIMessage[]): HermesUIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message];
    const segments = hermesAssistantSegments(message.parts);
    if (!segments.length) return [message];
    return segments.map((segment) => ({
      id: `${message.id}:hermes:${segment.id}`,
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: segment.text, state: 'done' as const }],
    }));
  });
}
