import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  Type,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ThinkingLevel,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import { buildModel, type ProviderConfig } from './model';
import { parseJson } from './public-api/body';

export const ANTHROPIC_GATEWAY_MAX_BODY_BYTES = 32 * 1024 * 1024;

const MAX_MESSAGES = 1_000;
const MAX_BLOCKS = 2_000;
const MAX_TOOLS = 512;
const MAX_TEXT = ANTHROPIC_GATEWAY_MAX_BODY_BYTES;

const ContentBlockSchema = z.object({
  type: z.string().trim().min(1).max(64),
}).passthrough();

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([
    z.string().max(MAX_TEXT),
    z.array(ContentBlockSchema).max(MAX_BLOCKS),
  ]),
}).passthrough();

const ToolSchema = z.object({
  name: z.string().trim().min(1).max(512),
  description: z.string().max(100_000).optional(),
  input_schema: z.record(z.string(), z.unknown()),
}).passthrough();

const BaseRequestSchema = z.object({
  model: z.string().trim().min(1).max(512),
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  system: z.union([
    z.string().max(MAX_TEXT),
    z.array(ContentBlockSchema).max(MAX_BLOCKS),
  ]).optional(),
  tools: z.array(ToolSchema).max(MAX_TOOLS).optional(),
  tool_choice: z.object({ type: z.string().max(32) }).passthrough().optional(),
  thinking: z.object({ type: z.string().max(32) }).passthrough().optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  top_p: z.number().finite().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  stop_sequences: z.array(z.string().max(10_000)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const MessagesRequestSchema = BaseRequestSchema.extend({
  max_tokens: z.number().int().positive().max(1_000_000),
  stream: z.boolean().default(false),
});

type BaseRequest = z.infer<typeof BaseRequestSchema>;
type MessagesRequest = z.infer<typeof MessagesRequestSchema>;
type ContentBlock = z.infer<typeof ContentBlockSchema>;
type GatewayProvider = ProviderConfig & { id: string };

type ToolNames = {
  toProvider(name: string): string;
  toClaude(name: string): string;
};

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function providerToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  if (sanitized === name && sanitized.length <= 64) return sanitized;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${sanitized.slice(0, 51)}_${hash}`;
}

function createToolNames(tools: readonly { name: string }[] = []): ToolNames {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const toProvider = (name: string) => {
    const cached = forward.get(name);
    if (cached) return cached;
    const mapped = providerToolName(name);
    forward.set(name, mapped);
    reverse.set(mapped, name);
    return mapped;
  };
  for (const tool of tools) toProvider(tool.name);
  return { toProvider, toClaude: (name) => reverse.get(name) ?? name };
}

function safeToolUseId(value: string): string {
  const callId = value.split('|', 1)[0] ?? value;
  const sanitized = callId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) return sanitized;
  return `toolu_${createHash('sha256').update(value).digest('hex').slice(0, 48)}`;
}

function textAndImages(blocks: readonly ContentBlock[]): Array<TextContent | ImageContent> {
  const content: Array<TextContent | ImageContent> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = stringValue(block.text);
      if (text) content.push({ type: 'text', text });
      continue;
    }
    if (block.type !== 'image') continue;
    const source = objectValue(block.source);
    const data = stringValue(source?.data);
    const mimeType = stringValue(source?.media_type);
    if (source?.type === 'base64' && data && mimeType) {
      content.push({ type: 'image', data, mimeType });
    }
  }
  return content;
}

function toolResultContent(value: unknown): Array<TextContent | ImageContent> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (Array.isArray(value)) return textAndImages(value as ContentBlock[]);
  if (value == null) return [];
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function systemPrompt(system: BaseRequest['system']): string | undefined {
  if (typeof system === 'string') return system || undefined;
  const text = (system ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => stringValue(block.text))
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

function assistantHistory(
  blocks: readonly ContentBlock[],
  model: Model<Api>,
  names: ToolNames,
  toolNameById: Map<string, string>,
): AssistantMessage | null {
  const content: AssistantMessage['content'] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = stringValue(block.text);
      if (text) content.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: stringValue(block.thinking),
        ...(stringValue(block.signature) ? { thinkingSignature: stringValue(block.signature) } : {}),
      });
      continue;
    }
    if (block.type === 'redacted_thinking') {
      content.push({
        type: 'thinking',
        thinking: '',
        thinkingSignature: stringValue(block.data),
        redacted: true,
      });
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const id = safeToolUseId(stringValue(block.id) || `toolu_${randomUUID().replaceAll('-', '')}`);
    const name = names.toProvider(stringValue(block.name) || 'tool');
    toolNameById.set(id, name);
    content.push({
      type: 'toolCall',
      id,
      name,
      arguments: objectValue(block.input) ?? {},
    });
  }
  if (!content.length) return null;
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

function requestContext(body: BaseRequest, model: Model<Api>, names: ToolNames): Context {
  const messages: Message[] = [];
  const toolNameById = new Map<string, string>();
  const pushUser = (content: string | Array<TextContent | ImageContent>) => {
    if ((typeof content === 'string' && !content) || (Array.isArray(content) && !content.length)) return;
    messages.push({ role: 'user', content, timestamp: Date.now() });
  };

  for (const message of body.messages) {
    if (message.role === 'assistant') {
      const blocks = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
      const assistant = assistantHistory(blocks, model, names, toolNameById);
      if (assistant) messages.push(assistant);
      continue;
    }
    if (typeof message.content === 'string') {
      pushUser(message.content);
      continue;
    }

    let pending: Array<TextContent | ImageContent> = [];
    const flush = () => {
      pushUser(pending);
      pending = [];
    };
    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        pending.push(...textAndImages([block]));
        continue;
      }
      flush();
      const toolCallId = safeToolUseId(stringValue(block.tool_use_id));
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName: toolNameById.get(toolCallId) ?? 'tool',
        content: toolResultContent(block.content),
        isError: block.is_error === true,
        timestamp: Date.now(),
      });
    }
    flush();
  }

  return {
    ...(systemPrompt(body.system) ? { systemPrompt: systemPrompt(body.system) } : {}),
    messages,
    ...(body.tools?.length ? {
      tools: body.tools.map((tool) => ({
        name: names.toProvider(tool.name),
        description: tool.description ?? '',
        parameters: Type.Unsafe(tool.input_schema),
      })),
    } : {}),
  };
}

function reasoningLevel(thinking: BaseRequest['thinking']): ThinkingLevel | undefined {
  if (!thinking || thinking.type === 'disabled') return undefined;
  const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 8_192;
  if (budget <= 2_048) return 'low';
  if (budget <= 8_192) return 'medium';
  return 'high';
}

function applyToolChoice(
  payload: unknown,
  choice: BaseRequest['tool_choice'],
  format: string,
  names: ToolNames,
): unknown {
  if (!choice || !objectValue(payload)) return undefined;
  const next = { ...objectValue(payload) } as Record<string, unknown>;
  const type = choice.type;
  if (type === 'any') next.tool_choice = 'required';
  else if (type === 'none') next.tool_choice = 'none';
  else if (type === 'tool' && stringValue(choice.name)) {
    const name = names.toProvider(stringValue(choice.name));
    next.tool_choice = format === 'openai-responses'
      ? { type: 'function', name }
      : { type: 'function', function: { name } };
  } else if (type === 'auto') next.tool_choice = 'auto';
  if (choice.disable_parallel_tool_use === true) next.parallel_tool_calls = false;
  return next;
}

// ponytail: conservative character estimate; replace with a provider tokenizer if context trimming drifts.
export function estimateAnthropicTokens(body: BaseRequest): number {
  return Math.max(1, Math.ceil(JSON.stringify({
    system: body.system,
    messages: body.messages,
    tools: body.tools,
  }).length / 4));
}

function errorResponse(message: string, status: number, type = 'invalid_request_error'): Response {
  return Response.json({ type: 'error', error: { type, message } }, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function usage(message: AssistantMessage, estimatedInput?: number) {
  return {
    input_tokens: estimatedInput ?? message.usage.input,
    output_tokens: message.usage.output,
    ...(message.usage.cacheWrite ? { cache_creation_input_tokens: message.usage.cacheWrite } : {}),
    ...(message.usage.cacheRead ? { cache_read_input_tokens: message.usage.cacheRead } : {}),
  };
}

function stopReason(reason: AssistantMessage['stopReason']) {
  if (reason === 'toolUse') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function responseContent(message: AssistantMessage, names: ToolNames) {
  return message.content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') {
      if (block.redacted) return { type: 'redacted_thinking', data: block.thinkingSignature ?? '' };
      return { type: 'thinking', thinking: block.thinking, signature: block.thinkingSignature ?? '' };
    }
    return {
      type: 'tool_use',
      id: safeToolUseId(block.id),
      name: names.toClaude(block.name),
      input: block.arguments,
    };
  });
}

function messageResponse(message: AssistantMessage, body: MessagesRequest, names: ToolNames): Response {
  return Response.json({
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: message.responseModel ?? body.model,
    content: responseContent(message, names),
    stop_reason: stopReason(message.stopReason),
    stop_sequence: null,
    usage: usage(message),
  }, { headers: { 'cache-control': 'no-store' } });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ActiveBlock = { type: 'text' | 'thinking' | 'tool'; json?: string };

function streamResponse(
  body: MessagesRequest,
  names: ToolNames,
  first: AssistantMessageEvent,
  iterator: AsyncIterator<AssistantMessageEvent>,
  abort: AbortController,
): Response {
  const encoder = new TextEncoder();
  const active = new Map<number, ActiveBlock>();
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const estimatedInput = estimateAnthropicTokens(body);
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)));
      const fail = (message: string) => {
        if (closed) return;
        write('error', { type: 'error', error: { type: 'api_error', message } });
        closed = true;
        controller.close();
      };
      const handle = (event: AssistantMessageEvent) => {
        if (event.type === 'start') return;
        if (event.type === 'error') {
          fail(event.error.errorMessage ?? 'Model request failed.');
          return;
        }
        if (event.type === 'text_start') {
          active.set(event.contentIndex, { type: 'text' });
          write('content_block_start', {
            type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' },
          });
          return;
        }
        if (event.type === 'text_delta') {
          write('content_block_delta', {
            type: 'content_block_delta', index: event.contentIndex,
            delta: { type: 'text_delta', text: event.delta },
          });
          return;
        }
        if (event.type === 'thinking_start') {
          const block = event.partial.content[event.contentIndex];
          active.set(event.contentIndex, { type: 'thinking' });
          write('content_block_start', {
            type: 'content_block_start', index: event.contentIndex,
            content_block: block?.type === 'thinking' && block.redacted
              ? { type: 'redacted_thinking', data: block.thinkingSignature ?? '' }
              : { type: 'thinking', thinking: '' },
          });
          return;
        }
        if (event.type === 'thinking_delta') {
          write('content_block_delta', {
            type: 'content_block_delta', index: event.contentIndex,
            delta: { type: 'thinking_delta', thinking: event.delta },
          });
          return;
        }
        if (event.type === 'toolcall_start') {
          const block = event.partial.content[event.contentIndex] as ToolCall | undefined;
          active.set(event.contentIndex, { type: 'tool', json: '' });
          write('content_block_start', {
            type: 'content_block_start', index: event.contentIndex,
            content_block: {
              type: 'tool_use',
              id: safeToolUseId(block?.id ?? `toolu_${randomUUID().replaceAll('-', '')}`),
              name: names.toClaude(block?.name ?? 'tool'),
              input: {},
            },
          });
          return;
        }
        if (event.type === 'toolcall_delta') {
          const block = active.get(event.contentIndex);
          if (block?.type === 'tool') block.json = `${block.json ?? ''}${event.delta}`;
          write('content_block_delta', {
            type: 'content_block_delta', index: event.contentIndex,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          });
          return;
        }
        if (event.type === 'toolcall_end') {
          const block = active.get(event.contentIndex);
          const full = JSON.stringify(event.toolCall.arguments);
          if (block?.type === 'tool' && !block.json) {
            write('content_block_delta', {
              type: 'content_block_delta', index: event.contentIndex,
              delta: { type: 'input_json_delta', partial_json: full },
            });
          }
        }
        if (event.type === 'thinking_end') {
          const block = event.partial.content[event.contentIndex];
          if (block?.type === 'thinking' && block.thinkingSignature && !block.redacted) {
            write('content_block_delta', {
              type: 'content_block_delta', index: event.contentIndex,
              delta: { type: 'signature_delta', signature: block.thinkingSignature },
            });
          }
        }
        if (event.type === 'text_end' || event.type === 'thinking_end' || event.type === 'toolcall_end') {
          active.delete(event.contentIndex);
          write('content_block_stop', { type: 'content_block_stop', index: event.contentIndex });
          return;
        }
        if (event.type === 'done') {
          write('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason(event.message.stopReason), stop_sequence: null },
            usage: { output_tokens: event.message.usage.output },
          });
          write('message_stop', { type: 'message_stop' });
          closed = true;
          controller.close();
        }
      };

      write('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInput, output_tokens: 0 },
        },
      });

      try {
        handle(first);
        while (!closed) {
          const next = await iterator.next();
          if (next.done) break;
          handle(next.value);
        }
        if (!closed) fail('Model stream ended before completion.');
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    cancel() {
      abort.abort('Anthropic gateway client disconnected.');
      void iterator.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

async function parsedRequest<T>(req: Request, schema: z.ZodType<T>) {
  const parsed = await parseJson(req, schema, ANTHROPIC_GATEWAY_MAX_BODY_BYTES);
  if (parsed.ok) return parsed;
  const status = parsed.reason === 'too_large' ? 413 : 400;
  return {
    ok: false as const,
    response: errorResponse(
      parsed.reason === 'too_large' ? 'Request body is too large.' : parsed.detail ?? 'Invalid JSON request body.',
      status,
    ),
  };
}

export async function handleAnthropicMessages(req: Request, provider: GatewayProvider): Promise<Response> {
  const parsed = await parsedRequest(req, MessagesRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const names = createToolNames(body.tools);
  const { models, model } = buildModel(provider, body.model);
  const context = requestContext(body, model, names);
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal]);
  const samplingParams: Record<string, unknown> = {};
  if (!model.reasoning && body.top_p !== undefined) samplingParams.top_p = body.top_p;
  if (provider.format === 'openai' && body.stop_sequences?.length) samplingParams.stop = body.stop_sequences;
  const modelStream = models.streamSimple(model, context, {
    maxTokens: body.max_tokens,
    ...(!model.reasoning && body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(Object.keys(samplingParams).length ? { samplingParams } : {}),
    ...(reasoningLevel(body.thinking) ? { reasoning: reasoningLevel(body.thinking) } : {}),
    maxRetries: 0,
    signal,
    onPayload: (payload) => applyToolChoice(payload, body.tool_choice, provider.format, names),
  });

  if (!body.stream) {
    const message = await modelStream.result();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return errorResponse(message.errorMessage ?? 'Model request failed.', 502, 'api_error');
    }
    return messageResponse(message, body, names);
  }

  const iterator = modelStream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return errorResponse('Model stream ended before it started.', 502, 'api_error');
  if (first.value.type === 'error') {
    return errorResponse(first.value.error.errorMessage ?? 'Model request failed.', 502, 'api_error');
  }
  return streamResponse(body, names, first.value, iterator, abort);
}

export async function handleAnthropicCountTokens(req: Request): Promise<Response> {
  const parsed = await parsedRequest(req, BaseRequestSchema);
  if (!parsed.ok) return parsed.response;
  return Response.json({ input_tokens: estimateAnthropicTokens(parsed.value) }, {
    headers: { 'cache-control': 'no-store' },
  });
}
