import 'server-only';
import {
  validateToolCall,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { buildModel, type ProviderConfig } from './model';
import { resolveMaxSteps } from './constants';
import type { AgentToolSet } from './agent-tool';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type UiMessageLike = {
  role: string;
  parts: Array<{ type: string; text?: string }>;
};

function messageText(parts: UiMessageLike['parts']): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function uiMessagesToPi(messages: readonly UiMessageLike[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const text = messageText(message.parts);
    if (!text || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.role === 'user') {
      converted.push({ role: 'user', content: text, timestamp: Date.now() });
      continue;
    }
    converted.push({
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'toolplane-history',
      model: 'history',
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    });
  }
  return converted;
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type NativeRunOptions = {
  provider: ProviderConfig;
  modelId: string;
  systemPrompt: string;
  messages: Message[];
  tools: AgentToolSet;
  maxSteps: number;
  signal?: AbortSignal;
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
  onToolResult?: (toolCall: ToolCall, output: unknown, isError: boolean) => void | Promise<void>;
};

export async function runNativeAgent(options: NativeRunOptions): Promise<string> {
  const { models, model } = buildModel(options.provider, options.modelId);
  const tools = Object.values(options.tools);
  const maxSteps = resolveMaxSteps(options.maxSteps);
  const context: Context = {
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    messages: [...options.messages],
    ...(tools.length ? { tools } : {}),
  };
  let text = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const stream = models.streamSimple(model, context, { signal: options.signal, maxRetries: 0 });
    for await (const event of stream) await options.onEvent?.(event);
    const message = await stream.result();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(message.errorMessage || 'Model request failed.');
    }
    context.messages.push(message);
    const responseText = message.content
      .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
      .map((content) => content.text)
      .join('');
    if (responseText) text += responseText;

    const toolCalls = message.content.filter((content): content is ToolCall => content.type === 'toolCall');
    if (!toolCalls.length) return text;
    if (step + 1 >= maxSteps) return text;

    for (const toolCall of toolCalls) {
      const localTool = options.tools[toolCall.name];
      let output: unknown;
      let isError = false;
      try {
        if (!localTool) throw new Error(`Unknown tool: ${toolCall.name}`);
        output = await localTool.execute(validateToolCall(tools, toolCall) as Record<string, unknown>);
      } catch (error) {
        isError = true;
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      await options.onToolResult?.(toolCall, output, isError);
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: toolResultText(output) }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  return text;
}
