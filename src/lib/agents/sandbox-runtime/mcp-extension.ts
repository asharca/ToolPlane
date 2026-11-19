import "server-only";
import { MCP_RESULT_TO_FILE_TOOL } from "../native-tools";

/** Native Pi names use zero-based server/catalog positions, not raw MCP wire names. */
export function nativePiMcpToolName(
  serverIndex: number,
  toolIndex: number,
  wireName: string,
): string {
  const suffix = String(wireName).replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__s${serverIndex + 1}_t${toolIndex + 1}__${suffix}`.slice(0, 63);
}

/** Loaded explicitly with --extension; it discovers and invokes ToolPlane MCP tools over JSON-RPC. */
export function piMcpExtensionSource(
  options: { eventFd?: 1 | 3; workspaceRoot?: string } = {},
): string {
  return buildMcpExtension({
    eventFd: options.eventFd ?? 1,
    workspaceRoot: options.workspaceRoot ?? "/workspace",
    toolNameSource: nativePiMcpToolName.toString(),
    resultToFileName: MCP_RESULT_TO_FILE_TOOL,
  });
}
function buildMcpExtension(options: {
  eventFd: 1 | 3;
  workspaceRoot: string;
  toolNameSource: string;
  resultToFileName: string;
}): string {
  return String.raw`import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_REGISTERED_TOOLS = 256;

function short(value, max = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, max);
}

async function readLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(announced) && announced > maxBytes) {
    throw new Error('MCP response exceeded its byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('MCP response byte limit exceeded').catch(() => undefined);
        throw new Error('MCP response exceeded its byte limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function rpc(server, method, params, signal, maxBytes) {
  const token = process.env.TOOLPLANE_RUNTIME_TOKEN;
  if (!token) throw new Error('Missing ToolPlane runtime token');
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error('MCP request exceeded its byte limit');
  }
  const timeout = AbortSignal.timeout(
    Number.isSafeInteger(server.timeoutMs) && server.timeoutMs > 0 && server.timeoutMs <= 300000
      ? server.timeoutMs
      : 30000,
  );
  const response = await fetch(server.url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + token,
    },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await readLimited(response, maxBytes);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  const reason = payload && payload.error && payload.error.data && payload.error.data.reason;
  const failure = (message) => Object.assign(new Error(message), {
    toolplaneReason: typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)
      ? reason
      : response.status === 401 || response.status === 403 ? 'MCP_GRANT_REVOKED' : 'MCP_UNREACHABLE',
  });
  if (!response.ok) throw failure('MCP HTTP ' + response.status + ': ' + text);
  if (payload === undefined) throw failure('MCP returned invalid JSON');
  if (payload && payload.error) {
    const message = payload.error.message || payload.error;
    throw failure(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return payload && payload.result ? payload.result : {};
}

const nativePiMcpToolName = ${options.toolNameSource};

function toolParameters(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const encoded = new TextEncoder().encode(JSON.stringify(schema));
  if (encoded.byteLength > MAX_SCHEMA_BYTES) throw new Error('MCP tool schema exceeded its byte limit');
  return schema;
}

function textContent(value) {
  return { type: 'text', text: short(value, MAX_RESPONSE_BYTES) };
}

function toPiContent(part) {
  if (part && part.type === 'text' && typeof part.text === 'string') return textContent(part.text);
  if (part && part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
    return { type: 'image', data: part.data, mimeType: part.mimeType };
  }
  if (part && part.type === 'resource' && part.resource && typeof part.resource.text === 'string') {
    return textContent(part.resource.text);
  }
  if (part && part.type === 'resource_link') return textContent('[resource: ' + String(part.uri || '') + ']');
  if (part && part.type === 'audio') return textContent('[audio content: ' + String(part.mimeType || 'unknown') + ']');
  return textContent(part);
}

function errorText(content) {
  return content.map((part) => part && part.type === 'text' ? String(part.text || '') : '').filter(Boolean).join('\n');
}

function mib(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2)) + ' MiB';
}

// Calls one authorized MCP tool once and streams its complete JSON result into
// the sandbox workspace; the model receives only a bounded file summary.
function resultToFileTool(fileTools, maxBytes) {
  return {
    name: ${JSON.stringify(options.resultToFileName)},
    label: 'Save MCP result to file',
    description: 'Call an authorized MCP tool with its exact original arguments and save the complete JSON result in a sandbox file (administrator-configured size limit, no truncation). Returns only a bounded file summary, never result bytes. Use the path for file-aware tools, pi_a2a_submit files or a2a_publish_artifact. The selected MCP tool remains subject to its resource authorization; a failure after execution must never be automatically retried. Ordinary MCP tools remain unchanged.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: [...fileTools.keys()], description: 'Exact name of an available MCP tool.' },
        arguments: { type: 'object', description: 'Arguments exactly as that tool accepts them.' },
        filename: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      },
      required: ['tool', 'arguments'],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal) {
      const tool = fileTools.get(params && params.tool);
      if (!tool) throw new Error('Authorized MCP tool unavailable.');
      if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
        throw new Error('Select an authorized MCP tool with its original arguments.');
      }
      const filename = params.filename ?? 'result.json';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename)) throw new Error('Invalid result filename.');
      writeSync(${options.eventFd}, JSON.stringify({
        type: 'toolplane_mcp_origin',
        source: globalThis[Symbol.for('toolplane.pi.host-context.v1')]?.getEventSource?.(),
        toolCallId,
        deploymentId: tool.server.deploymentId,
        originalToolName: tool.wireName,
      }) + '\n');
      let result;
      try {
        result = await rpc(tool.server, 'tools/call', { name: tool.wireName, arguments: params.arguments }, signal, maxBytes + 64 * 1024);
      } catch (error) {
        throw new Error('MCP invocation failed; its external outcome is unknown. Do not replay the tool blindly.', { cause: error });
      }
      let file;
      try {
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized) > maxBytes) {
          throw new Error('The full MCP result exceeds the ' + mib(maxBytes) + ' file limit; no truncated file was saved.');
        }
        const { writeWorkspaceFile } = await import(new URL('./a2a-sandbox-files.mjs', import.meta.url).href);
        const { Readable } = await import('node:stream');
        const { join } = await import('node:path');
        const callId = String(toolCallId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'call';
        file = await writeWorkspaceFile(
          ${JSON.stringify(options.workspaceRoot)},
          join(process.cwd(), '.a2a-files', 'tool-results', callId + '-' + filename),
          Readable.from([serialized]),
          { maxBytes, signal },
        );
      } catch (error) {
        const limit = error && String(error.message).includes('file limit') ? ': result exceeds the ' + mib(maxBytes) + ' file limit' : '';
        throw new Error('MCP tool already executed, but saving its complete result failed' + limit + '. Do not replay the tool blindly.', { cause: error });
      }
      const summary = { ...file, mediaType: 'application/json' };
      if (result.isError) {
        throw new Error('MCP tool returned an error; its complete result was saved without model echo: ' + JSON.stringify(summary) + '. Do not replay the tool blindly.');
      }
      return {
        content: [textContent(JSON.stringify({ ...summary, summary: 'Full MCP result saved to file; content omitted from model context.' }))],
        details: summary,
      };
    },
  };
}

export async function createPiMcpTools(config) {
  if (!config || !Array.isArray(config.servers)) throw new Error('Invalid ToolPlane Pi MCP config');

  let registeredTools = 0;
  const definitions = [];
  const fileTools = new Map();
  for (let serverIndex = 0; serverIndex < config.servers.length; serverIndex += 1) {
    const server = config.servers[serverIndex];
    if (!server || typeof server.name !== 'string' || typeof server.deploymentId !== 'string' || typeof server.url !== 'string') {
      throw new Error('Invalid ToolPlane MCP server entry');
    }
    let catalog;
    try {
      catalog = await rpc(server, 'tools/list');
    } catch (error) {
      // Tell the host which server failed and why before Pi aborts the session.
      writeSync(${options.eventFd}, JSON.stringify({
        type: 'toolplane_mcp_unavailable',
        deploymentId: server.deploymentId,
        reason: (error && error.toolplaneReason) || 'MCP_UNREACHABLE',
      }) + '\n');
      throw error;
    }
    const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
      const tool = tools[toolIndex];
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      if (registeredTools >= MAX_REGISTERED_TOOLS) throw new Error('MCP tool catalog exceeded its limit');
      const wireName = tool.name;
      const name = nativePiMcpToolName(serverIndex, toolIndex, wireName);
      const parameters = toolParameters(tool.inputSchema);
      if (server.deploymentId !== 'toolplane-runtime') fileTools.set(name, { server, wireName });
      definitions.push({
        name,
        label: wireName,
        description: short((tool.description || '') + '\nMCP server: ' + (typeof server.label === 'string' && server.label ? server.label : server.name)),
        parameters,
        async execute(toolCallId, params, signal) {
          writeSync(${options.eventFd}, JSON.stringify({
            type: 'toolplane_mcp_origin',
            source: globalThis[Symbol.for('toolplane.pi.host-context.v1')]?.getEventSource?.(),
            toolCallId,
            deploymentId: server.deploymentId,
            originalToolName: wireName,
          }) + '\n');
          const result = await rpc(server, 'tools/call', { name: wireName, arguments: params || {} }, signal);
          const content = Array.isArray(result.content) ? result.content : [];
          // Pi's agent loop catches an execute rejection and emits a failed
          // tool result using error.message; it does not reject the turn.
          if (result.isError) throw new Error(errorText(content) || 'MCP tool returned an error');
          return {
            content: content.length ? content.map(toPiContent) : [textContent(result.structuredContent ?? '')],
            details: result.structuredContent ?? null,
          };
        },
      });
      registeredTools += 1;
    }
  }
  if (fileTools.size) {
    if (!Number.isSafeInteger(config.resultFileBytes) || config.resultFileBytes <= 0) throw new Error('Invalid ToolPlane Pi MCP config');
    definitions.push(resultToFileTool(fileTools, config.resultFileBytes));
  }
  return definitions;
}

export default async function toolplaneMcpExtension(pi) {
  const configPath = process.env.TOOLPLANE_PI_MCP_CONFIG;
  if (!configPath) throw new Error('Missing ToolPlane Pi MCP config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const tool of await createPiMcpTools(config)) pi.registerTool(tool);
}
`;
}
