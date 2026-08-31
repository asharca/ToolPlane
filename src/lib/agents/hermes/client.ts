import 'server-only';
import type { FileUIPart, UIMessage } from 'ai';
import type { ReasoningEffort } from '../constants';
import {
  ensureHermesRuntimeReady,
  type HermesRuntimeWriteLease,
} from './runtime';
import type {
  HermesAssistantSegment,
  HermesUIMessage,
} from './message-segments';
import {
  ensureHermesProfileProjection,
  hasHermesProfileChatCapabilities,
  hasHermesProfileModel,
  HERMES_DEFAULT_PROFILE,
  listHermesProfileModels,
  normalizeHermesProfile,
} from './profiles';

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

type HermesStoredMessage = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
};

function fileLabel(part: FileUIPart): string {
  const toolplane = part.providerMetadata?.toolplane;
  const runtimePath = toolplane && typeof toolplane === 'object' && 'runtimePath' in toolplane
    ? String(toolplane.runtimePath ?? '').trim()
    : '';
  if (runtimePath) return `[Attached file: ${part.filename || 'file'} at ${runtimePath}]`;
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
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ baseUrl: string; response: Response }> {
  if (!params.agent.runtime || params.agent.runtime.kind !== 'hermes') {
    throw new Error('Hermes runtime is not configured.');
  }
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 60 * 60_000);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;
  const ready = await ensureHermesRuntimeReady(
    params.agent.workspaceId,
    params.agent.id,
    { writeLease: params.writeLease, signal },
  );
  if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');

  const profile = normalizeHermesProfile(params.profile || HERMES_DEFAULT_PROFILE);
  if (!profile) throw new Error('Invalid Hermes profile.');
  if ((params.provider == null) !== (params.model == null)) {
    throw new Error('Hermes provider and model must be selected together.');
  }
  const profilePath = profile === HERMES_DEFAULT_PROFILE ? '' : `/p/${encodeURIComponent(profile)}`;
  const baseUrl = `http://127.0.0.1:${ready.port}/hermes${profilePath}`;
  const body = JSON.stringify({
    messages: params.messages,
    stream: params.stream,
    ...(params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : { model: params.agent.slug }),
    ...(params.reasoningEffort && params.reasoningEffort !== 'default'
      ? { model_options: { reasoning: { enabled: true, effort: params.reasoningEffort } } }
      : {}),
  });
  const request = () => fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hermes-session-id': params.sessionId,
      'x-hermes-session-key': params.sessionKey,
    },
    body,
    signal,
    cache: 'no-store',
  });
  let response = await request();
  if (response.status === 401 && profile !== HERMES_DEFAULT_PROFILE) {
    await response.body?.cancel().catch(() => undefined);
    await ensureHermesProfileProjection(params.agent, profile, params.writeLease);
    response = await request();
  }
  return { baseUrl, response };
}

async function hermesProfileChatStream(params: {
  agent: HermesRuntimeAgent;
  messages: HermesMessage[];
  sessionId: string;
  sessionKey: string;
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
}): Promise<{ baseUrl: string; response: Response; sessionEvents: boolean }> {
  if (!params.agent.runtime || params.agent.runtime.kind !== 'hermes') {
    throw new Error('Hermes runtime is not configured.');
  }
  const profile = normalizeHermesProfile(params.profile || HERMES_DEFAULT_PROFILE);
  if (!profile) throw new Error('Invalid Hermes profile.');
  if ((params.provider == null) !== (params.model == null)) {
    throw new Error('Hermes provider and model must be selected together.');
  }

  if (profile !== HERMES_DEFAULT_PROFILE) {
    await ensureHermesProfileProjection(params.agent, profile, params.writeLease);
  }

  const timeoutSignal = AbortSignal.timeout(60 * 60_000);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;
  const ready = await ensureHermesRuntimeReady(
    params.agent.workspaceId,
    params.agent.id,
    { writeLease: params.writeLease, signal },
  );
  if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');
  const profilePath = profile === HERMES_DEFAULT_PROFILE ? '' : `/p/${encodeURIComponent(profile)}`;
  const baseUrl = `http://127.0.0.1:${ready.port}/hermes${profilePath}`;
  const headers = {
    'content-type': 'application/json',
    'x-hermes-session-id': params.sessionId,
    'x-hermes-session-key': params.sessionKey,
  };

  const capabilities = await fetch(`${baseUrl}/v1/capabilities`, {
    headers,
    signal,
    cache: 'no-store',
  });
  const profileChatSupported = capabilities.ok
    && hasHermesProfileChatCapabilities(await capabilities.json().catch(() => null));
  if (!profileChatSupported) {
    await capabilities.body?.cancel().catch(() => undefined);
    if (profile === HERMES_DEFAULT_PROFILE && params.provider == null && params.model == null) {
      return {
        ...await hermesFetch({
          agent: params.agent,
          messages: params.messages,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          stream: true,
          reasoningEffort: params.reasoningEffort,
          writeLease: params.writeLease,
          signal: params.signal,
        }),
        sessionEvents: false,
      };
    }
    throw new Error('Hermes profile/model chat requires runtime v0.20.0 or newer. Upgrade this Agent\'s Hermes image.');
  }

  let provider = params.provider;
  let model = params.model;
  if (!provider || !model) {
    const options = await listHermesProfileModels(params.agent, profile, params.writeLease);
    provider = options.provider;
    model = options.model;
    if (!provider || !model || !hasHermesProfileModel(options, provider, model)) {
      throw new Error(`Hermes profile "${profile}" has no available default model.`);
    }
  }
  const userMessage = params.messages.filter((message) => message.role === 'user').at(-1);
  if (!userMessage) throw new Error('Hermes chat requires a user message.');

  const create = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: params.sessionId, source: 'api_server' }),
    signal,
    cache: 'no-store',
  });
  if (create.status !== 201 && create.status !== 409) throw await responseError(create);
  await create.body?.cancel().catch(() => undefined);

  const response = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(params.sessionId)}/chat/stream`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: userMessage.content,
        provider,
        model,
        // Hermes resolves named custom providers to the runtime class
        // "custom". Its confirmed-lock check compares that class with the
        // requested provider alias and rejects an otherwise correct turn.
        // Explicit provider requests already fail closed during resolution.
        ...(params.reasoningEffort && params.reasoningEffort !== 'default'
          ? { model_options: { reasoning: { enabled: true, effort: params.reasoningEffort } } }
          : {}),
      }),
      signal,
      cache: 'no-store',
    },
  );
  return { baseUrl, response, sessionEvents: true };
}

async function responseError(response: Response): Promise<Error> {
  const reader = response.body?.getReader();
  if (!reader) return new Error(`Hermes runtime returned ${response.status}.`);
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (received <= 4_096) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received > 4_096) {
        await reader.cancel('error body limit exceeded').catch(() => undefined);
        break;
      }
    }
    text += decoder.decode();
  } catch {
    text = '';
  } finally {
    reader.releaseLock();
  }
  text = text.trim().slice(0, 1_000);
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

function sessionStreamEvent(block: string): { event: string; data: Record<string, unknown> } | null {
  const event = block
    .split(/\r?\n/)
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim() ?? '';
  const data = sseData(block);
  if (!event || !data) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object'
      ? { event, data: parsed as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

function storedMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
      ? [String((part as { text?: unknown }).text ?? '')]
      : []
  )).join('');
}

async function readHermesAssistantSegments(
  baseUrl: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<HermesAssistantSegment[]> {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const response = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(conversationId)}/messages`,
    {
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      cache: 'no-store',
    },
  );
  if (!response.ok) return [];
  const body = await response.json().catch(() => ({})) as { data?: HermesStoredMessage[] };
  const messages = Array.isArray(body.data) ? body.data : [];
  let turnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      turnStart = index + 1;
      break;
    }
  }
  if (turnStart < 0) return [];
  return messages.slice(turnStart).flatMap((message, index) => {
    if (message.role !== 'assistant') return [];
    const text = storedMessageText(message.content);
    if (!text.trim()) return [];
    return [{ id: String(message.id ?? index), text }];
  });
}

export async function writeHermesChatStream(params: {
  agent: HermesRuntimeAgent;
  messages: UIMessage[];
  // The ToolPlane conversation ID remains useful for UI stream identifiers.
  // A cloned conversation can supply its source-volume Hermes session ID here.
  conversationId: string;
  runtimeSessionId?: string;
  sessionKey?: string;
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  writer: import('ai').UIMessageStreamWriter<HermesUIMessage>;
}): Promise<{ runtimeSessionId: string }> {
  const runtimeSessionId = params.runtimeSessionId || params.conversationId;
  const projectedMessages = uiMessagesToHermes(params.messages);
  const { baseUrl, response, sessionEvents } = await hermesProfileChatStream({
    agent: params.agent,
    messages: projectedMessages,
    sessionId: runtimeSessionId,
    sessionKey: params.sessionKey || `agent:${params.agent.id}:console:${runtimeSessionId}`,
    profile: params.profile,
    provider: params.provider,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    writeLease: params.writeLease,
    signal: params.signal,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Hermes runtime returned an empty stream.');

  const textPartId = `hermes-${params.conversationId}`;
  params.writer.write({ type: 'text-start', id: textPartId });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  let completedText = '';
  let completed = false;
  let effectiveSessionId = response.headers.get('x-hermes-session-id') || runtimeSessionId;

  const handleBlock = (block: string) => {
    if (!sessionEvents) {
      const data = sseData(block);
      if (data === '[DONE]') {
        completed = true;
        return;
      }
      const delta = textDelta(data);
      if (delta) {
        streamedText += delta;
        params.writer.write({ type: 'text-delta', id: textPartId, delta });
      }
      return;
    }
    const item = sessionStreamEvent(block);
    if (!item) return;
    if (item.event === 'assistant.delta') {
      const delta = typeof item.data.delta === 'string' ? item.data.delta : '';
      if (delta) {
        streamedText += delta;
        params.writer.write({ type: 'text-delta', id: textPartId, delta });
      }
    } else if (item.event === 'assistant.completed' && typeof item.data.content === 'string') {
      completedText = item.data.content;
      completed = true;
      if (typeof item.data.session_id === 'string') effectiveSessionId = item.data.session_id;
    } else if (item.event === 'run.completed') {
      completed = true;
      if (typeof item.data.session_id === 'string') effectiveSessionId = item.data.session_id;
    } else if (item.event === 'error') {
      throw new Error(typeof item.data.message === 'string' ? item.data.message : 'Hermes runtime request failed.');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let match = /\r?\n\r?\n/.exec(buffer);
    while (match) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      handleBlock(block);
      match = /\r?\n\r?\n/.exec(buffer);
    }
    if (done) break;
  }
  handleBlock(buffer);
  if (!completed) throw new Error('Hermes runtime ended the stream before the turn completed.');
  if (!streamedText && completedText) {
    params.writer.write({ type: 'text-delta', id: textPartId, delta: completedText });
  }
  params.writer.write({ type: 'text-end', id: textPartId });
  const safeSessionId = effectiveSessionId.trim();
  if (!safeSessionId || safeSessionId.length > 256 || /[\u0000-\u001f]/.test(safeSessionId)) {
    throw new Error('Hermes runtime returned an invalid session ID.');
  }
  const segments = sessionEvents
    ? await readHermesAssistantSegments(baseUrl, safeSessionId, params.signal)
    : [];
  if (segments.length) {
    params.writer.write({
      type: 'data-hermes-messages',
      id: `hermes-messages-${params.conversationId}`,
      data: { segments },
    });
  }
  return { runtimeSessionId: safeSessionId };
}

export async function runHermesText(params: {
  agent: HermesRuntimeAgent;
  messages: UIMessage[];
  sessionId: string;
  sessionKey: string;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const { response } = await hermesFetch({
    agent: params.agent,
    messages: uiMessagesToHermes(params.messages),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    stream: false,
    writeLease: params.writeLease,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
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

export class HermesResponseTooLargeError extends Error {
  constructor() {
    super('Hermes response exceeded the configured output limit.');
    this.name = 'HermesResponseTooLargeError';
  }
}

/** Delete a Hermes session before deleting the corresponding public record. */
export async function deleteHermesSession(params: {
  agent: HermesRuntimeAgent;
  sessionId: string;
  sessionKey: string;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!params.agent.runtime || params.agent.runtime.kind !== 'hermes') {
    throw new Error('Hermes runtime is not configured.');
  }
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 30_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const ready = await ensureHermesRuntimeReady(
    params.agent.workspaceId,
    params.agent.id,
    { writeLease: params.writeLease, signal },
  );
  if (!ready.port) throw new Error(ready.error || 'Hermes runtime is unavailable.');
  const response = await fetch(
    `http://127.0.0.1:${ready.port}/hermes/api/sessions/${encodeURIComponent(params.sessionId)}`,
    {
      method: 'DELETE',
      headers: {
        'x-hermes-session-id': params.sessionId,
        'x-hermes-session-key': params.sessionKey,
      },
      signal,
      cache: 'no-store',
    },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw await responseError(response);
  return true;
}

/**
 * Streams only assistant text from Hermes' OpenAI-compatible SSE response.
 * Public API callers deliberately do not receive internal tool arguments,
 * tool output, approval events, provider errors, or runtime identifiers.
 */
export async function runHermesTextStream(params: {
  agent: HermesRuntimeAgent;
  messages: UIMessage[];
  sessionId: string;
  sessionKey: string;
  writeLease?: HermesRuntimeWriteLease;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputCharacters?: number;
  onDelta: (delta: string) => void | Promise<void>;
}): Promise<string> {
  const { response } = await hermesFetch({
    agent: params.agent,
    messages: uiMessagesToHermes(params.messages),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    stream: true,
    writeLease: params.writeLease,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Hermes runtime returned an empty stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (params.maxOutputCharacters && buffer.length > params.maxOutputCharacters + 65_536) {
        throw new HermesResponseTooLargeError();
      }
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const delta = textDelta(sseData(block));
        if (delta) {
          if (params.maxOutputCharacters && text.length + delta.length > params.maxOutputCharacters) {
            throw new HermesResponseTooLargeError();
          }
          text += delta;
          await params.onDelta(delta);
        }
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
    const trailing = textDelta(sseData(buffer));
    if (trailing) {
      if (params.maxOutputCharacters && text.length + trailing.length > params.maxOutputCharacters) {
        throw new HermesResponseTooLargeError();
      }
      text += trailing;
      await params.onDelta(trailing);
    }
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
