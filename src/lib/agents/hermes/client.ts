import 'server-only';
import type { FileUIPart, UIMessage, UIMessageStreamWriter } from 'ai';
import { ensureHermesRuntimeReady } from './runtime';

type HermesRuntimeAgent = {
  id: string;
  slug: string;
  workspaceId: string;
  runtime: { id: string; kind: string } | null;
};

type HermesContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

type HermesMessage = {
  role: 'user' | 'assistant';
  content: string | HermesContentPart[];
};

function fileLabel(part: FileUIPart): string {
  return `[Attachment: ${part.filename || 'file'} (${part.mediaType}) ${part.url}]`;
}

export function uiMessagesToHermes(messages: UIMessage[]): HermesMessage[] {
  return messages
    .filter((message): message is UIMessage & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .map((message) => {
      const parts: HermesContentPart[] = [];
      for (const part of message.parts) {
        if (part.type === 'text' && part.text) {
          parts.push({ type: 'text', text: part.text });
        } else if (
          part.type === 'file'
          && message.role === 'user'
          && part.mediaType.startsWith('image/')
          && (/^https?:\/\//.test(part.url) || /^data:image\//.test(part.url))
        ) {
          parts.push({ type: 'image_url', image_url: { url: part.url } });
        } else if (part.type === 'file') {
          parts.push({ type: 'text', text: fileLabel(part) });
        }
      }
      const onlyText = parts.every((part) => part.type === 'text');
      return {
        role: message.role,
        content: onlyText
          ? parts.map((part) => part.type === 'text' ? part.text : '').join('\n\n')
          : parts,
      };
    })
    .filter((message) => (
      typeof message.content === 'string' ? Boolean(message.content.trim()) : message.content.length > 0
    ));
}

async function hermesFetch(params: {
  agent: HermesRuntimeAgent;
  messages: HermesMessage[];
  sessionId: string;
  sessionKey: string;
  stream: boolean;
}): Promise<Response> {
  if (!params.agent.runtime || params.agent.runtime.kind !== 'hermes') {
    throw new Error('Hermes runtime is not configured.');
  }
  const ready = await ensureHermesRuntimeReady(params.agent.workspaceId, params.agent.id);
  if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');

  return fetch(`http://127.0.0.1:${ready.port}/hermes/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hermes-session-id': params.sessionId,
      'x-hermes-session-key': params.sessionKey,
    },
    body: JSON.stringify({
      model: params.agent.slug,
      messages: params.messages,
      stream: params.stream,
    }),
    signal: AbortSignal.timeout(60 * 60_000),
    cache: 'no-store',
  });
}

async function responseError(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => '')).trim().slice(0, 1000);
  return new Error(text || `Hermes runtime returned ${response.status}.`);
}

function sseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

function textDelta(data: string): string {
  if (!data || data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('');
    }
  } catch {
    return '';
  }
  return '';
}

export async function writeHermesChatStream(params: {
  agent: HermesRuntimeAgent;
  messages: UIMessage[];
  conversationId: string;
  sessionKey?: string;
  writer: UIMessageStreamWriter;
}) {
  const response = await hermesFetch({
    agent: params.agent,
    messages: uiMessagesToHermes(params.messages),
    sessionId: params.conversationId,
    sessionKey: params.sessionKey || `agent:${params.agent.id}:console:${params.conversationId}`,
    stream: true,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Hermes runtime returned an empty stream.');

  const textPartId = `hermes-${params.conversationId}`;
  params.writer.write({ type: 'text-start', id: textPartId });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let match = /\r?\n\r?\n/.exec(buffer);
    while (match) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const delta = textDelta(sseData(block));
      if (delta) params.writer.write({ type: 'text-delta', id: textPartId, delta });
      match = /\r?\n\r?\n/.exec(buffer);
    }
    if (done) break;
  }
  const trailing = textDelta(sseData(buffer));
  if (trailing) params.writer.write({ type: 'text-delta', id: textPartId, delta: trailing });
  params.writer.write({ type: 'text-end', id: textPartId });
}

export async function runHermesText(params: {
  agent: HermesRuntimeAgent;
  messages: UIMessage[];
  sessionId: string;
  sessionKey: string;
}): Promise<string> {
  const response = await hermesFetch({
    agent: params.agent,
    messages: uiMessagesToHermes(params.messages),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    stream: false,
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('');
  }
  return '';
}
