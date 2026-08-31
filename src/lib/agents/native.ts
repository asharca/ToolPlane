import 'server-only';
import {
  validateToolCall,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type { ContextUsageSnapshot } from '@/lib/context-usage';
import { buildModel, providerModelIds, type ProviderConfig } from './model';
import { resolveMaxSteps, type ReasoningEffort } from './constants';
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
  parts: Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
    data?: unknown;
    mimeType?: unknown;
    filename?: unknown;
    providerMetadata?: unknown;
  }>;
};

function runtimeFileText(part: UiMessageLike['parts'][number]): string | null {
  if (part.type !== 'file' || !part.providerMetadata || typeof part.providerMetadata !== 'object') return null;
  const toolplane = 'toolplane' in part.providerMetadata ? part.providerMetadata.toolplane : null;
  if (!toolplane || typeof toolplane !== 'object' || !('runtimePath' in toolplane)) return null;
  const runtimePath = typeof toolplane.runtimePath === 'string' ? toolplane.runtimePath.trim() : '';
  if (!runtimePath) return null;
  const filename = (typeof part.filename === 'string' ? part.filename.trim() : '') || 'file';
  return `[Attached file: ${filename.replace(/\s+/g, ' ').slice(0, 240)} at ${runtimePath.replace(/\s+/g, ' ').slice(0, 1_000)}]`;
}

function messageText(parts: UiMessageLike['parts']): string {
  return parts
    .flatMap((part) => {
      if (part.type === 'text' && typeof part.text === 'string') return [part.text];
      const runtimeFile = runtimeFileText(part);
      if (runtimeFile) return [runtimeFile];
      if (part.type !== 'work-tool' || !part.toolName) return [];
      const input = toolResultText(part.input).slice(0, 20_000);
      const output = toolResultText(part.output).slice(0, 20_000);
      return [`[Recorded ${part.isError ? 'failed' : 'successful'} tool call: ${part.toolName}]\nInput: ${input}\nOutput: ${output}`];
    })
    .join('\n')
    .trim();
}

export function uiMessagesToPi(messages: readonly UiMessageLike[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const text = messageText(message.parts);
    const images = message.parts.flatMap((part) => (
      part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string'
        ? [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }]
        : []
    ));
    if ((!text && !images.length) || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: images.length
          ? [...(text ? [{ type: 'text' as const, text }] : []), ...images]
          : text,
        timestamp: Date.now(),
      });
      continue;
    }
    if (!text) continue;
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
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
  onToolResult?: (toolCall: ToolCall, output: unknown, isError: boolean) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
};

export async function runNativeAgent(options: NativeRunOptions): Promise<string> {
  const { models, model } = buildModel(options.provider, options.modelId);
  const reasoning = options.reasoningEffort && options.reasoningEffort !== 'default'
    ? options.reasoningEffort
    : undefined;
  const runtimeModel = reasoning ? { ...model, reasoning: true } : model;
  const contextWindowEstimated = providerModelIds(options.provider)?.includes(options.modelId) !== true;
  const tools = Object.values(options.tools);
  const maxSteps = resolveMaxSteps(options.maxSteps);
  const context: Context = {
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    messages: [...options.messages],
    ...(tools.length ? { tools } : {}),
  };
  let text = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const stream = models.streamSimple(runtimeModel, context, {
      signal: options.signal,
      maxRetries: 0,
      ...(reasoning ? { reasoning } : {}),
    });
    for await (const event of stream) await options.onEvent?.(event);
    const message = await stream.result();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(message.errorMessage || 'Model request failed.');
    }
    if (Number.isFinite(message.usage.totalTokens) && message.usage.totalTokens > 0) {
      await options.onContextUsage?.({
        usedTokens: message.usage.totalTokens,
        maxTokens: model.contextWindow,
        modelName: model.name,
        estimated: contextWindowEstimated,
      });
    }
    context.messages.push(message);
    const responseText = message.content
      .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
      .map((content) => content.text)
      .join('');
    if (responseText) text += responseText;

    const toolCalls = message.content.filter((content): content is ToolCall => content.type === 'toolCall');
    if (!toolCalls.length) return text;

    for (const toolCall of toolCalls) {
      if (options.signal?.aborted) throw new Error('Model request aborted.');
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
