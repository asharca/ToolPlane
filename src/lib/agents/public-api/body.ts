import { z } from 'zod';

export const AGENT_API_MAX_BODY_BYTES = 256 * 1024;
export const AGENT_API_MAX_INPUT_CHARACTERS = 20_000;
export const AGENT_API_MAX_OUTPUT_CHARACTERS = 200_000;
export const AGENT_API_MAX_CONTEXT_CHARACTERS = 400_000;
export const AGENT_API_MAX_CONTEXT_MESSAGES = 100;
export const AGENT_API_MAX_TRANSCRIPT_CHARACTERS = 200_000;
export const AGENT_API_MAX_METADATA_ENTRIES = 16;
export const AGENT_API_BODY_READ_TIMEOUT_MS = 30_000;

const MetadataValue = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const Metadata = z
  .record(z.string().trim().min(1).max(64), MetadataValue)
  .refine((value) => Object.keys(value).length <= AGENT_API_MAX_METADATA_ENTRIES, {
    message: `metadata may contain at most ${AGENT_API_MAX_METADATA_ENTRIES} entries`,
  });

const AgentResponseBodySchema = z
  .object({
    input: z.string().trim().min(1).max(AGENT_API_MAX_INPUT_CHARACTERS),
    conversation_id: z.string().trim().min(1).max(160).optional(),
    end_user: z.string().trim().min(1).max(200),
    stream: z.boolean().default(false),
    metadata: Metadata.optional(),
  })
  .strict();

const OpenAIMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(AGENT_API_MAX_INPUT_CHARACTERS),
  })
  .strict();

const OpenAIChatBodySchema = z
  .object({
    model: z.string().trim().min(1).max(160),
    messages: z.array(OpenAIMessageSchema).min(1).max(100),
    stream: z.boolean().default(false),
    user: z.string().trim().min(1).max(200),
    conversation_id: z.string().trim().min(1).max(160).optional(),
    metadata: Metadata.optional(),
  })
  .strict()
  .refine(
    (value) => value.messages.reduce((total, message) => total + message.content.length, 0)
      <= AGENT_API_MAX_INPUT_CHARACTERS,
    { message: `messages may contain at most ${AGENT_API_MAX_INPUT_CHARACTERS} characters` },
  )
  .refine(
    (value) => value.messages[value.messages.length - 1]?.role === 'user',
    { message: 'the final message must have role user' },
  );

const ClientTokenBodySchema = z
  .object({
    end_user: z.string().trim().min(1).max(200),
    expires_in: z.number().int().min(60).max(15 * 60).default(15 * 60),
    origin: z.string().url().max(2_000).optional(),
  })
  .strict();

export type AgentResponseBody = z.infer<typeof AgentResponseBodySchema>;
export type OpenAIChatBody = z.infer<typeof OpenAIChatBodySchema>;
export type AgentClientTokenBody = z.infer<typeof ClientTokenBodySchema>;

export type ParsedPublicApiBody<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'too_large' | 'invalid_json' | 'invalid_body'; detail?: string };

export function requestBodyMayFit(req: Request, maxBytes = AGENT_API_MAX_BODY_BYTES): boolean {
  const announced = Number(req.headers.get('content-length') ?? 0);
  return !Number.isFinite(announced) || announced <= 0 || announced <= maxBytes;
}

async function readRequestText(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const readSignal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(AGENT_API_BODY_READ_TIMEOUT_MS),
  ]);
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abortRead = () => {
    void reader.cancel(readSignal.reason).catch(() => undefined);
    rejectAbort?.(readSignal.reason ?? new DOMException('Request body read aborted.', 'AbortError'));
  };
  if (readSignal.aborted) abortRead();
  else readSignal.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('request body limit exceeded').catch(() => undefined);
        return { ok: false };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    readSignal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
}

export async function parseJson<T>(
  req: Request,
  schema: z.ZodType<T>,
  maxBytes = AGENT_API_MAX_BODY_BYTES,
): Promise<ParsedPublicApiBody<T>> {
  if (!requestBodyMayFit(req, maxBytes)) return { ok: false, reason: 'too_large' };
  let body: Awaited<ReturnType<typeof readRequestText>>;
  try {
    body = await readRequestText(req, maxBytes);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!body.ok) return { ok: false, reason: 'too_large' };
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_body',
      detail: parsed.error.issues[0]?.message,
    };
  }
  return { ok: true, value: parsed.data };
}

export function parseAgentResponseRequest(req: Request) {
  return parseJson(req, AgentResponseBodySchema);
}

export function parseOpenAIChatRequest(req: Request) {
  return parseJson(req, OpenAIChatBodySchema);
}

export function parseAgentClientTokenRequest(req: Request) {
  return parseJson(req, ClientTokenBodySchema, 16 * 1024);
}

export function openAIInput(body: OpenAIChatBody): string {
  return body.messages
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n');
}
