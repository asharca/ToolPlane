import 'server-only';
import { agentTool, jsonSchema, type AgentToolSet } from '@/lib/agents/agent-tool';

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_QUERY_LENGTH = 500;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_OUTPUT_LENGTH = 24_000;

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    bytesRead += value.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Exa MCP response exceeded the size limit.');
    }
    body += decoder.decode(value, { stream: true });
  }
}

function responseText(raw: string): string {
  const payloads = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s*/, '').trim())
    .filter((line) => line && line !== '[DONE]');

  for (const payload of payloads.length ? payloads : [raw]) {
    try {
      const parsed = JSON.parse(payload) as {
        error?: { message?: unknown };
        result?: { content?: Array<{ text?: unknown }> };
      };
      if (typeof parsed.error?.message === 'string') throw new Error(parsed.error.message);
      const text = parsed.result?.content
        ?.map((item) => typeof item.text === 'string' ? item.text.trim() : '')
        .filter(Boolean)
        .join('\n\n');
      if (text) {
        return text.length > MAX_OUTPUT_LENGTH
          ? `${text.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Search results truncated]`
          : text;
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }

  throw new Error('Exa MCP returned no readable search results.');
}

async function searchWeb(query: unknown, requestSignal?: AbortSignal) {
  const normalized = typeof query === 'string' ? query.trim() : '';
  if (!normalized) throw new Error('Search query is required.');
  if (normalized.length > MAX_QUERY_LENGTH) throw new Error(`Search query must be at most ${MAX_QUERY_LENGTH} characters.`);

  const response = await fetch(EXA_MCP_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: { query: normalized, type: 'auto', numResults: 5, livecrawl: 'fallback' },
      },
    }),
    signal: requestSignal
      ? AbortSignal.any([requestSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`Exa MCP search failed (${response.status}): ${body.replace(/\s+/g, ' ').slice(0, 500)}`);
  }

  return { content: [{ type: 'text', text: responseText(body) }] };
}

export function buildKeylessWebSearchToolSet(requestSignal?: AbortSignal): AgentToolSet {
  return {
    web_search: agentTool({
      name: 'web_search',
      description: 'Search the live web for current information and source URLs. Use this when the user asks for recent, changing, or externally verifiable facts.',
      parameters: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async ({ query }: { query: string }) => searchWeb(query, requestSignal),
    }),
  };
}
