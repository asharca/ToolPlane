import 'server-only';
import { liveMcpRuntimeSnapshot, livePort } from './supervisor';
import { parseMcpToolCatalogResult, type McpToolDefinition } from './mcp-tool-catalog';
import { persistDeploymentMcpToolCatalog } from './mcp-tool-catalog-store';

export type McpTool = McpToolDefinition;

export type McpPromptArgument = {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
};

export type McpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgument[];
};

export type McpPromptMessage = {
  role: 'user' | 'assistant';
  content: {
    type: string;
    text?: string;
  };
};

export type McpPromptResult = {
  description?: string;
  messages: McpPromptMessage[];
};

export class McpPayloadTooLargeError extends Error {
  constructor() {
    super('MCP payload exceeded the configured byte limit.');
    this.name = 'McpPayloadTooLargeError';
  }
}

export type McpRpcOptions = {
  signal?: AbortSignal;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  onResponseBytes?: (bytes: number) => void;
};

const MAX_PROMPT_PAGES = 10;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 1_000;
const MAX_TOOLS_RESPONSE_BYTES = 4_000_000;
const MAX_TOOLS_TOTAL_MS = 15_000;
const MAX_PROMPTS = 200;
const MAX_PROMPT_ARGUMENTS = 50;
const MAX_PROMPT_MESSAGES = 50;
const MAX_PROMPT_NAME_LENGTH = 240;
const MAX_PROMPT_TEXT_LENGTH = 100_000;

function trimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePromptArgument(value: unknown): McpPromptArgument | null {
  const input = record(value);
  const name = trimmedString(input?.name, MAX_PROMPT_NAME_LENGTH);
  if (!name) return null;
  return {
    name,
    ...(trimmedString(input?.title, MAX_PROMPT_NAME_LENGTH) ? { title: trimmedString(input?.title, MAX_PROMPT_NAME_LENGTH) } : {}),
    ...(trimmedString(input?.description, 2_000) ? { description: trimmedString(input?.description, 2_000) } : {}),
    required: input?.required === true,
  };
}

function parsePrompt(value: unknown): McpPrompt | null {
  const input = record(value);
  const name = trimmedString(input?.name, MAX_PROMPT_NAME_LENGTH);
  if (!name) return null;
  const argumentsValue = Array.isArray(input?.arguments) ? input.arguments : [];
  if (argumentsValue.length > MAX_PROMPT_ARGUMENTS) return null;
  const argumentsList = argumentsValue.map(parsePromptArgument);
  if (argumentsList.some((argument) => !argument)) return null;
  const names = new Set(argumentsList.map((argument) => argument!.name));
  if (names.size !== argumentsList.length) return null;
  return {
    name,
    ...(trimmedString(input?.title, MAX_PROMPT_NAME_LENGTH) ? { title: trimmedString(input?.title, MAX_PROMPT_NAME_LENGTH) } : {}),
    ...(trimmedString(input?.description, 2_000) ? { description: trimmedString(input?.description, 2_000) } : {}),
    arguments: argumentsList as McpPromptArgument[],
  };
}

function parsePromptResult(value: unknown): McpPromptResult | null {
  const input = record(value);
  const messages = Array.isArray(input?.messages) ? input.messages : null;
  if (!messages || messages.length > MAX_PROMPT_MESSAGES) return null;
  const parsedMessages: McpPromptMessage[] = [];
  for (const message of messages) {
    const inputMessage = record(message);
    const role = inputMessage?.role;
    const content = record(inputMessage?.content);
    const type = trimmedString(content?.type, 80);
    if ((role !== 'user' && role !== 'assistant') || !type) return null;
    const text = typeof content?.text === 'string' && content.text.length <= MAX_PROMPT_TEXT_LENGTH
      ? content.text
      : undefined;
    parsedMessages.push({ role, content: { type, ...(text !== undefined ? { text } : {}) } });
  }
  return {
    ...(trimmedString(input?.description, 2_000) ? { description: trimmedString(input?.description, 2_000) } : {}),
    messages: parsedMessages,
  };
}

async function readJsonResponse(
  response: Response,
  maxBytes?: number,
  onResponseBytes?: (bytes: number) => void,
): Promise<unknown> {
  if (!maxBytes && !onResponseBytes) return response.json();
  const byteLimit = maxBytes ?? Number.POSITIVE_INFINITY;
  const announced = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(announced) && announced > byteLimit) throw new McpPayloadTooLargeError();
  if (!response.body) {
    onResponseBytes?.(0);
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > byteLimit) {
        await reader.cancel('MCP response byte limit exceeded').catch(() => undefined);
        throw new McpPayloadTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    onResponseBytes?.(received);
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

// Issue a JSON-RPC request straight to a deployment's live process (used for
// server-rendered reads like tools/list). Returns the JSON-RPC `result` or
// null when the process is not reachable.
async function mcpRpcAtPort(
  port: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
  options: McpRpcOptions = {},
): Promise<Record<string, unknown> | null> {
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    if (options.maxRequestBytes && new TextEncoder().encode(body).byteLength > options.maxRequestBytes) {
      throw new McpPayloadTooLargeError();
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
      cache: 'no-store',
    });
    const json = await readJsonResponse(res, options.maxResponseBytes, options.onResponseBytes) as {
      result?: Record<string, unknown>;
    } | null;
    return json?.result ?? null;
  } catch (error) {
    if (error instanceof McpPayloadTooLargeError) throw error;
    return null;
  }
}

export async function mcpRpc(
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
  options: McpRpcOptions = {},
): Promise<Record<string, unknown> | null> {
  const port = livePort(deploymentId);
  return port ? mcpRpcAtPort(port, method, params, timeoutMs, options) : null;
}

export async function listMcpTools(
  deploymentId: string,
  options: McpRpcOptions = {},
): Promise<McpTool[]> {
  let tools: McpTool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const requestRedactionValues = new Set<string>();
  let requestGeneration: string | undefined;
  let requestPort: number | undefined;
  let remainingResponseBytes = MAX_TOOLS_RESPONSE_BYTES;
  const deadline = Date.now() + MAX_TOOLS_TOTAL_MS;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return [];
    const before = liveMcpRuntimeSnapshot(deploymentId);
    if (
      !before
      || (requestGeneration !== undefined && before.generation !== requestGeneration)
      || (requestPort !== undefined && before.port !== requestPort)
    ) return [];
    requestGeneration ??= before.generation;
    requestPort ??= before.port;
    for (const secret of before.redactionValues) requestRedactionValues.add(secret);
    let result: Record<string, unknown> | null;
    let responseBytes = 0;
    try {
      result = await mcpRpcAtPort(
        before.port,
        'tools/list',
        cursor ? { cursor } : undefined,
        Math.min(5_000, remainingMs),
        {
          ...options,
          maxResponseBytes: Math.min(
            options.maxResponseBytes ?? MAX_TOOLS_RESPONSE_BYTES,
            remainingResponseBytes,
          ),
          onResponseBytes: (bytes) => {
            responseBytes = bytes;
            options.onResponseBytes?.(bytes);
          },
        },
      );
    } catch (error) {
      if (error instanceof McpPayloadTooLargeError) return [];
      throw error;
    }
    const after = liveMcpRuntimeSnapshot(deploymentId);
    if (
      !after
      || after.generation !== before.generation
      || after.port !== before.port
    ) return [];
    // Never replace a complete snapshot with a partial pagination result.
    remainingResponseBytes -= responseBytes;
    if (!result || !Array.isArray(result.tools)) return [];
    if (result.tools.length > MAX_TOOLS - tools.length) return [];
    const pageCatalog = parseMcpToolCatalogResult(result.tools);
    if (!pageCatalog.ok) return [];
    const combined = parseMcpToolCatalogResult([...tools, ...pageCatalog.tools]);
    if (!combined.ok) return [];
    tools = combined.tools;

    if (result.nextCursor === undefined) {
      return persistDeploymentMcpToolCatalog(
        deploymentId,
        tools,
        [...requestRedactionValues],
      ).catch(() => []);
    }
    const nextCursor = result.nextCursor;
    if (
      typeof nextCursor !== 'string'
      || !nextCursor
      || nextCursor.length > 4_000
      || seenCursors.has(nextCursor)
      || page === MAX_TOOL_PAGES - 1
      || tools.length >= MAX_TOOLS
      || remainingResponseBytes <= 0
    ) return [];
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return [];
}

export async function listMcpPrompts(
  deploymentId: string,
  options: McpRpcOptions = {},
): Promise<McpPrompt[]> {
  const prompts: McpPrompt[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PROMPT_PAGES && prompts.length < MAX_PROMPTS; page += 1) {
    const result = await mcpRpc(
      deploymentId,
      'prompts/list',
      cursor ? { cursor } : undefined,
      5000,
      options,
    );
    const listed = Array.isArray(result?.prompts) ? result.prompts : [];
    for (const value of listed) {
      const prompt = parsePrompt(value);
      if (prompt && !seen.has(prompt.name)) {
        seen.add(prompt.name);
        prompts.push(prompt);
        if (prompts.length >= MAX_PROMPTS) break;
      }
    }
    const nextCursor = trimmedString(result?.nextCursor, 4_000);
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return prompts;
}

export async function getMcpPrompt(
  deploymentId: string,
  name: string,
  argumentsValue: Record<string, string> = {},
  options: McpRpcOptions = {},
): Promise<McpPromptResult | null> {
  const result = await mcpRpc(
    deploymentId,
    'prompts/get',
    { name, ...(Object.keys(argumentsValue).length ? { arguments: argumentsValue } : {}) },
    30_000,
    options,
  );
  return parsePromptResult(result);
}
