export type McpLogOperation =
  | 'toolCall'
  | 'listTools'
  | 'initialize'
  | 'healthCheck'
  | 'ping'
  | 'notification'
  | 'request';

export type McpLogOutcome = 'success' | 'error';

export type McpLogInspection = {
  operation: McpLogOperation;
  rpcMethod: string | null;
  toolName: string | null;
  outcome: McpLogOutcome;
  errorSummary: string | null;
};

export type McpLogInput = {
  path: string;
  statusCode: number;
  responseBody?: string | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactText(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

function messageFromValue(value: unknown): string | null {
  if (typeof value === 'string') return compactText(value);
  if (!isRecord(value)) return null;

  if (typeof value.message === 'string') return compactText(value.message);
  if (typeof value.error === 'string') return compactText(value.error);
  if (isRecord(value.error)) return messageFromValue(value.error);

  const content = value.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && typeof item.text === 'string') {
        return compactText(item.text);
      }
    }
  }

  return null;
}

function responseErrorSummary(response: unknown): string | null {
  if (!isRecord(response)) return null;

  if (response.error !== undefined) return messageFromValue(response.error) ?? 'MCP error';
  if (response.isError === true) return messageFromValue(response) ?? 'MCP tool error';

  if (isRecord(response.result) && response.result.isError === true) {
    return messageFromValue(response.result) ?? 'MCP tool error';
  }

  return null;
}

function parseOperation(path: string): Pick<McpLogInspection, 'operation' | 'rpcMethod' | 'toolName'> {
  const marker = path.indexOf('#');
  if (marker >= 0) {
    const fragment = path.slice(marker + 1);
    const separator = fragment.indexOf(':');
    const rpcMethod = (separator >= 0 ? fragment.slice(0, separator) : fragment).trim() || null;
    const toolName = separator >= 0 ? fragment.slice(separator + 1).trim() || null : null;

    if (rpcMethod === 'tools/call') return { operation: 'toolCall', rpcMethod, toolName };
    if (rpcMethod === 'tools/list') return { operation: 'listTools', rpcMethod, toolName: null };
    if (rpcMethod === 'initialize') return { operation: 'initialize', rpcMethod, toolName: null };
    if (rpcMethod === 'ping') return { operation: 'ping', rpcMethod, toolName: null };
    if (rpcMethod?.startsWith('notifications/') || rpcMethod === 'initialized') {
      return { operation: 'notification', rpcMethod, toolName: null };
    }
    return { operation: 'request', rpcMethod, toolName };
  }

  if (/(?:^|\/)health(?:$|[/?])/.test(path)) {
    return { operation: 'healthCheck', rpcMethod: null, toolName: null };
  }

  return { operation: 'request', rpcMethod: null, toolName: null };
}

/**
 * Converts the legacy path-based RequestLog shape into the pieces a person
 * needs to scan an MCP request: operation, tool name, and semantic outcome.
 * Historical rows do not have structured RPC columns, so this deliberately
 * keeps the parsing compatible with every existing gateway path.
 */
export function inspectMcpLog(input: McpLogInput): McpLogInspection {
  const parsedResponse = parseJson(input.responseBody);
  const errorSummary = responseErrorSummary(parsedResponse);
  const outcome: McpLogOutcome = input.statusCode >= 400 || errorSummary
    ? 'error'
    : 'success';

  return {
    ...parseOperation(input.path),
    outcome,
    errorSummary: errorSummary ?? (input.statusCode >= 400 ? `HTTP ${input.statusCode}` : null),
  };
}
