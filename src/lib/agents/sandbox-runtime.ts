import 'server-only';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { db } from '@/lib/db';
import { estimateContextTokens, type ContextUsageSnapshot } from '@/lib/context-usage';
import { effectiveStatus } from '@/lib/process/supervisor';
import { sandboxContainerName } from '@/lib/sandboxes/runtime';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { safeSkillFilePath, type SkillBundleFile } from '@/lib/skills/bundle';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

export const SANDBOX_RUNTIME_PACKAGES = {
  pi: {
    specs: [
      '@earendil-works/pi-coding-agent@0.80.3',
      '@earendil-works/pi-ai@0.80.3',
    ],
    directory: '/workspace/.toolplane/runtime-packages/pi-0.80.3',
    binary: 'pi',
    ignoreScripts: true,
    allowBuilds: [],
  },
  'claude-code': {
    specs: ['@anthropic-ai/claude-code@2.1.245'],
    directory: '/workspace/.toolplane/runtime-packages/claude-code-2.1.245',
    binary: 'claude',
    ignoreScripts: false,
    allowBuilds: ['@anthropic-ai/claude-code'],
  },
  dsh: {
    specs: ['@deepseek-ai/dsh@0.1.1-rc.2'],
    directory: '/workspace/.toolplane/runtime-packages/dsh-0.1.1-rc.2',
    binary: 'dsh',
    ignoreScripts: false,
    allowBuilds: [
      '@deepseek-ai/dsh-subprocess-local',
      '@google/genai',
      'koffi',
      'node-pty',
      'protobufjs',
    ],
  },
} as const;

const PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 30 * 60_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const RUNTIME_TEMP_ROOT = '/workspace/.toolplane/runtime-tmp';
const NPM_CACHE = '/workspace/.toolplane/npm-cache';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CLAUDE_RUNTIME_USER = '1000:1000';

export type SandboxAgentRuntimeKind = 'pi' | 'claude-code' | 'dsh';

export type SandboxRuntimeProvider = {
  id: string;
  name: string;
  format: string;
};

export type SandboxRuntimeMcpServer = {
  deploymentId: string;
  url: string;
};

export type SandboxRuntimeMessage = {
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

export type RunSandboxAgentTurnOptions = {
  runtimeKind: SandboxAgentRuntimeKind;
  workspaceId: string;
  agentId: string;
  sandboxId: string;
  provider: SandboxRuntimeProvider;
  modelId: string;
  contextWindow: number;
  contextWindowEstimated?: boolean;
  modelProxyBase: string;
  runtimeAccessToken: string;
  systemPrompt?: string | null;
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  mcpServers?: readonly SandboxRuntimeMcpServer[];
  workingDirectory?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
};

export type SandboxRuntimeActivity = {
  type: 'reasoning' | 'tool';
  status: 'running' | 'completed' | 'failed';
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  durationMs?: number;
  deploymentId?: string;
  originalToolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

export type ClaudeStreamLine = {
  delta?: string;
  result?: string;
  assistantText?: string;
  contextTokens?: number;
  isError?: boolean;
  activities?: SandboxRuntimeActivity[];
};

export type PiStreamLine = {
  delta?: string;
  assistantText?: string;
  contextTokens?: number;
  error?: string;
  isError?: boolean;
  activities?: SandboxRuntimeActivity[];
};

export type DshStreamLine = {
  delta?: string;
  activities?: SandboxRuntimeActivity[];
};

type DockerExecOptions = {
  container: string;
  workdir: string;
  executable: string;
  user?: string;
  args?: string[];
  stdin?: string | Buffer;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  secrets?: readonly string[];
};

const installs = new Map<string, Promise<string>>();

function byteSlice(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= maxBytes
    ? value
    : `${bytes.subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
}

function displayValue(value: unknown, maxBytes = 20_000): string {
  if (typeof value === 'string') return byteSlice(value, maxBytes);
  try {
    return byteSlice(JSON.stringify(value), maxBytes);
  } catch {
    return byteSlice(String(value), maxBytes);
  }
}

function safeSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return segment && segment !== '.' && segment !== '..' ? segment : fallback;
}

function runtimeFilePath(part: SandboxRuntimeMessage['parts'][number]): string | null {
  if (!part.providerMetadata || typeof part.providerMetadata !== 'object') return null;
  const metadata = part.providerMetadata as Record<string, unknown>;
  const toolplane = metadata.toolplane;
  if (!toolplane || typeof toolplane !== 'object') return null;
  const value = (toolplane as Record<string, unknown>).runtimePath;
  if (typeof value !== 'string') return null;
  try {
    return normalizeSandboxWorkingDirectory(value);
  } catch {
    return null;
  }
}

function messagePartText(part: SandboxRuntimeMessage['parts'][number]): string | null {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'work-tool' && part.toolName) {
    return [
      `[Recorded ${part.isError ? 'failed' : 'successful'} tool call: ${part.toolName}]`,
      `Input: ${displayValue(part.input)}`,
      `Output: ${displayValue(part.output)}`,
    ].join('\n');
  }
  if (part.type !== 'file' && part.type !== 'image') return null;
  const filename = (typeof part.filename === 'string' ? part.filename.trim() : '') || 'attachment';
  const path = runtimeFilePath(part);
  if (path) return `[Attached file: ${filename.replace(/\s+/g, ' ').slice(0, 240)} at ${path}]`;
  return `[Attached ${part.type === 'image' ? 'image' : 'file'}: ${filename.replace(/\s+/g, ' ').slice(0, 240)}; bytes are not mounted in this sandbox turn]`;
}

/** Resolve a user-selected path and prove it remains under /workspace. */
export function normalizeSandboxWorkingDirectory(value: unknown): string {
  if (value == null || value === '') return '/workspace';
  if (typeof value !== 'string' || value.length > 1_000 || value.includes('\0')) {
    throw new Error('Invalid sandbox working directory.');
  }
  const input = value.trim().replace(/\\/g, '/').replace(/^\/workspace(?:\/|$)/, '') || '.';
  if (input.startsWith('/')) throw new Error('Sandbox working directory must be under /workspace.');
  const resolved = posix.resolve('/workspace', input);
  if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) {
    throw new Error('Sandbox working directory must be under /workspace.');
  }
  return resolved;
}

export function buildSandboxTranscript(messages: readonly SandboxRuntimeMessage[]): string {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const text = message.parts.flatMap((part) => {
      const value = messagePartText(part);
      return value?.trim() ? [value] : [];
    }).join('\n').trim();
    return text ? [`### ${message.role.toUpperCase()}\n${text}`] : [];
  }).join('\n\n').trim();
}

export type SandboxSkillBundle = {
  directory: string;
  markdown: string;
  files: SkillBundleFile[];
};

function sandboxSkillDirectoryName(skill: SkillForPrompt, used: Set<string>): string {
  const label = skillLabel({
    skillId: skill.skillId,
    skill: skill.skill,
    name: skill.name ?? null,
    slug: skill.slug ?? null,
    source: skill.source ?? null,
  });
  const base = label.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill';
  let directory = base;
  for (let suffix = 2; used.has(directory); suffix += 1) directory = `${base}-${suffix}`;
  used.add(directory);
  return directory;
}

export function buildSandboxSkillBundles(skills: readonly SkillForPrompt[]): SandboxSkillBundle[] {
  const usedDirectories = new Set<string>();
  return skills.map((skill) => ({
    directory: sandboxSkillDirectoryName(skill, usedDirectories),
    markdown: buildInstalledSkillMarkdown(skill),
    files: installedSkillExtraFiles(skill),
  }));
}

export function sandboxSkillBundleDigest(bundles: readonly SandboxSkillBundle[]): string {
  return createHash('sha256').update(JSON.stringify(bundles)).digest('hex');
}

export function waitForSandboxRuntimeInstall<T>(install: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return install;
  if (signal.aborted) return Promise.reject(new Error('Sandbox runtime aborted.'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error('Sandbox runtime aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void install.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function dshProviderProtocol(format: string): string {
  if (format === 'anthropic') return 'anthropic-messages';
  if (format === 'openai-responses') return 'openai-responses';
  if (format === 'openai') return 'openai-completions';
  throw new Error(`DeepSeek Harness does not support provider format: ${format}.`);
}

export function piProviderProtocol(format: string): string {
  if (format === 'anthropic') return 'anthropic-messages';
  if (format === 'openai-responses') return 'openai-responses';
  if (format === 'openai') return 'openai-completions';
  throw new Error(`Pi does not support provider format: ${format}.`);
}

function httpUrl(value: string, label: string): string {
  if (value.length > 4_000) throw new Error(`${label} is too long.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function mcpName(server: SandboxRuntimeMcpServer, index: number): string {
  const stem = safeSegment(server.deploymentId, 'server').slice(0, 20);
  return `tp_${index + 1}_${stem}`.slice(0, 32);
}

export function resolveSandboxMcpToolOrigin(
  toolName: string | undefined,
  servers: readonly SandboxRuntimeMcpServer[],
): Pick<SandboxRuntimeActivity, 'deploymentId' | 'originalToolName'> | null {
  if (!toolName) return null;
  const pi = /^mcp__s(\d+)_t\d+__/.exec(toolName);
  if (pi) {
    const server = servers[Number(pi[1]) - 1];
    // Pi's generated suffix is sanitized and can be truncated. The extension
    // reports the exact name separately, so do not present this fallback as raw.
    return server ? { deploymentId: server.deploymentId } : null;
  }
  for (const [index, server] of servers.entries()) {
    const alias = mcpName(server, index);
    for (const prefix of [`mcp__${alias}__`, `${alias}__`]) {
      if (!toolName.startsWith(prefix) || toolName.length === prefix.length) continue;
      return { deploymentId: server.deploymentId, originalToolName: toolName.slice(prefix.length) };
    }
  }
  return null;
}

export function sandboxRuntimeCanReachProxy(network: string): boolean {
  return network !== 'none';
}

export function sandboxRuntimeStateRoot(runtimeKind: SandboxAgentRuntimeKind, agentId: string): string {
  return `/workspace/.toolplane/runtimes/${runtimeKind}/agents/${safeSegment(agentId, 'agent')}`;
}

export function sandboxRuntimeSkillRoot(runtimeKind: SandboxAgentRuntimeKind, agentId: string): string {
  return `${sandboxRuntimeStateRoot(runtimeKind, agentId)}/skills`;
}

export function sandboxRuntimeExecWrapper(controlPrefix: string): string {
  return `pid_file=$1; shift; umask 077; printf '%s\\n' "$$" > "$pid_file"; trap 'rm -f -- "$pid_file"' EXIT; printf '${controlPrefix}%s\\n' "$$"; "$@"`;
}

export function buildDshPatch(options: {
  provider: SandboxRuntimeProvider;
  modelId: string;
  modelProxyBase: string;
  systemPrompt: string;
  skillRoot: string;
  mcpServers?: readonly SandboxRuntimeMcpServer[];
  eventPluginPath?: string;
}): string {
  const protocol = dshProviderProtocol(options.provider.format);
  const proxy = httpUrl(options.modelProxyBase, 'model proxy URL');
  const rows = [
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    customSkillDirs:',
    `      - ${yamlString(options.skillRoot)}`,
    '    watch: false',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      toolplane:',
    `        displayName: ${yamlString(options.provider.name || 'ToolPlane')}`,
    '        apiKeyEnv: TOOLPLANE_RUNTIME_TOKEN',
    `        api: ${protocol}`,
    `        baseURL: ${yamlString(proxy)}`,
    '        models:',
    `          - id: ${yamlString(options.modelId)}`,
    `            name: ${yamlString(options.modelId)}`,
    '- id: agent-default-model',
    '  config:',
    '    provider: toolplane',
    `    model: ${yamlString(options.modelId)}`,
    '- id: system-prompt',
    '  config:',
    `    persona: ${yamlString(options.systemPrompt)}`,
  ];
  const servers = options.mcpServers ?? [];
  if (options.eventPluginPath || servers.length) {
    rows.push('- insert:');
    if (options.eventPluginPath) {
      rows.push(
        '    - id: toolplane-events',
        `      name: ${yamlString(`file://${options.eventPluginPath}`)}`,
      );
    }
    servers.forEach((server, index) => {
      rows.push(
        `    - id: ${yamlString(`toolplane-mcp-${index + 1}`)}`,
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        `        serverName: ${yamlString(mcpName(server, index))}`,
        '        transport: streamable-http',
        `        url: ${yamlString(httpUrl(server.url, 'MCP proxy URL'))}`,
        '        headers:',
        '          Authorization: !!js process.env.TOOLPLANE_MCP_AUTH',
        '        failOnStartupError: true',
      );
    });
  }
  return `${rows.join('\n')}\n`;
}

export function dshEventTapSource(prefix: string): string {
  return `
export const name = 'toolplane-events';
const prefix = ${JSON.stringify(prefix)};
const reasoning = new Set();
function bounded(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return text.length > 20000 ? text.slice(0, 20000) + '\\n[truncated]' : text;
}
function emit(value) { process.stdout.write(prefix + JSON.stringify(value) + '\\n'); }
export function apply(ctx) {
  ctx.on('session/event', (_session, event) => {
    const data = event && event.data;
    if (event?.type === 'assistant/chunk') {
      const chunk = data?.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') emit({ type: 'text', delta: chunk.text });
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoning.add(chunk.index);
        emit({ type: 'reasoning', status: 'running', delta: chunk.text });
      } else if (chunk?.type === 'block-start' && chunk.blockType === 'reasoning') {
        reasoning.add(chunk.index);
        emit({ type: 'reasoning', status: 'running' });
      } else if (chunk?.type === 'block-end' && (reasoning.delete(chunk.index) || chunk.block?.type === 'reasoning')) {
        emit({ type: 'reasoning', status: 'completed' });
      }
      return;
    }
    if (event?.type === 'tool/call' && data?.callId && data?.name) {
      emit({ type: 'tool', status: 'running', toolCallId: String(data.callId), toolName: String(data.name), input: bounded(data.arguments) });
      return;
    }
    if (event?.type === 'tool/result') {
      const block = data?.message?.content?.[0];
      if (!block?.toolCallId) return;
      const failed = data.error !== undefined || block.isError === true;
      emit({ type: 'tool', status: failed ? 'failed' : 'completed', toolCallId: String(block.toolCallId), output: bounded(block.content), isError: failed });
    }
  });
}
`.trimStart();
}

export function buildClaudeMcpConfig(
  servers: readonly SandboxRuntimeMcpServer[],
  runtimeAccessToken: string,
): string {
  const mcpServers = Object.fromEntries(servers.map((server, index) => [
    mcpName(server, index),
    {
      type: 'http',
      url: httpUrl(server.url, 'MCP proxy URL'),
      headers: { Authorization: `Bearer ${runtimeAccessToken}` },
    },
  ]));
  return JSON.stringify({ mcpServers });
}

export function buildPiModelsConfig(options: {
  provider: SandboxRuntimeProvider;
  modelId: string;
  modelProxyBase: string;
}): string {
  return JSON.stringify({
    providers: {
      toolplane: {
        name: options.provider.name || 'ToolPlane',
        baseUrl: httpUrl(options.modelProxyBase, 'model proxy URL'),
        api: piProviderProtocol(options.provider.format),
        apiKey: '$TOOLPLANE_RUNTIME_TOKEN',
        models: [{
          id: options.modelId,
          name: options.modelId,
          reasoning: false,
          input: ['text'],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2);
}

export function buildPiMcpConfig(servers: readonly SandboxRuntimeMcpServer[]): string {
  return JSON.stringify({
    servers: servers.map((server, index) => ({
      name: mcpName(server, index),
      deploymentId: server.deploymentId,
      url: httpUrl(server.url, 'MCP proxy URL'),
    })),
  });
}

/** Loaded explicitly with --extension; it discovers and invokes ToolPlane MCP tools over JSON-RPC. */
export function piMcpExtensionSource(): string {
  return String.raw`import { readFile } from 'node:fs/promises';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_REGISTERED_TOOLS = 256;

function short(value, max = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, max);
}

async function readLimited(response) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
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
      if (received > MAX_RESPONSE_BYTES) {
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

async function rpc(server, method, params, signal) {
  const token = process.env.TOOLPLANE_RUNTIME_TOKEN;
  if (!token) throw new Error('Missing ToolPlane runtime token');
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error('MCP request exceeded its byte limit');
  }
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(server.url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await readLimited(response);
  if (!response.ok) throw new Error('MCP HTTP ' + response.status + ': ' + short(text));
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('MCP returned invalid JSON');
  }
  if (payload && payload.error) throw new Error(short(payload.error.message || payload.error));
  return payload && payload.result ? payload.result : {};
}

function safeToolName(serverIndex, toolIndex, wireName) {
  const suffix = String(wireName).replace(/[^A-Za-z0-9_-]/g, '_');
  return ('mcp__s' + (serverIndex + 1) + '_t' + (toolIndex + 1) + '__' + suffix).slice(0, 63);
}

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

export default async function toolplaneMcpExtension(pi) {
  const configPath = process.env.TOOLPLANE_PI_MCP_CONFIG;
  if (!configPath) throw new Error('Missing ToolPlane Pi MCP config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config || !Array.isArray(config.servers)) throw new Error('Invalid ToolPlane Pi MCP config');

  let registeredTools = 0;
  for (let serverIndex = 0; serverIndex < config.servers.length; serverIndex += 1) {
    const server = config.servers[serverIndex];
    if (!server || typeof server.name !== 'string' || typeof server.deploymentId !== 'string' || typeof server.url !== 'string') {
      throw new Error('Invalid ToolPlane MCP server entry');
    }
    const catalog = await rpc(server, 'tools/list');
    const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
      const tool = tools[toolIndex];
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      if (registeredTools >= MAX_REGISTERED_TOOLS) throw new Error('MCP tool catalog exceeded its limit');
      const wireName = tool.name;
      pi.registerTool({
        name: safeToolName(serverIndex, toolIndex, wireName),
        label: wireName,
        description: short((tool.description || '') + '\nMCP server: ' + server.name),
        parameters: toolParameters(tool.inputSchema),
        async execute(toolCallId, params, signal) {
          process.stdout.write(JSON.stringify({
            type: 'toolplane_mcp_origin',
            toolCallId,
            deploymentId: server.deploymentId,
            originalToolName: wireName,
          }) + '\\n');
          const result = await rpc(server, 'tools/call', { name: wireName, arguments: params || {} }, signal);
          const content = Array.isArray(result.content) ? result.content : [];
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
}
`;
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function piContextTokens(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const total = usageNumber(usage.totalTokens);
  if (total !== null) return total;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  return input !== null && output !== null ? input + output : null;
}

function claudeContextTokens(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const values = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].map(usageNumber);
  return values.some((item) => item !== null)
    ? values.reduce<number>((total, item) => total + (item ?? 0), 0)
    : null;
}

function piMessageResult(message: unknown): PiStreamLine | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.role !== 'assistant') return null;
  const content = Array.isArray(value.content) ? value.content : [];
  const assistantText = content.flatMap((part) => (
    part && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string'
      ? [(part as Record<string, unknown>).text as string]
      : []
  )).join('');
  const isError = value.stopReason === 'error' || value.stopReason === 'aborted';
  const error = typeof value.errorMessage === 'string'
    ? value.errorMessage
    : (isError ? `Pi request ${String(value.stopReason)}.` : '');
  const contextTokens = piContextTokens(value.usage);
  if (!assistantText && !error && contextTokens === null) return null;
  return {
    ...(assistantText ? { assistantText } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(error ? { error } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export function parsePiStreamLine(line: string): PiStreamLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.type === 'toolplane_mcp_origin'
    && typeof payload.toolCallId === 'string'
    && typeof payload.deploymentId === 'string'
    && typeof payload.originalToolName === 'string') {
    return {
      activities: [{
        type: 'tool',
        status: 'running',
        toolCallId: payload.toolCallId,
        deploymentId: payload.deploymentId,
        originalToolName: payload.originalToolName,
      }],
    };
  }
  if (payload.type === 'message_update' && payload.assistantMessageEvent
    && typeof payload.assistantMessageEvent === 'object') {
    const event = payload.assistantMessageEvent as Record<string, unknown>;
    if (event.type === 'text_delta' && typeof event.delta === 'string') return { delta: event.delta };
    if (event.type === 'thinking_start') {
      return { activities: [{ type: 'reasoning', status: 'running' }] };
    }
    if (event.type === 'thinking_delta' && typeof event.delta === 'string') {
      return { activities: [{ type: 'reasoning', status: 'running', delta: event.delta }] };
    }
    if (event.type === 'thinking_end') {
      return { activities: [{ type: 'reasoning', status: 'completed' }] };
    }
  }
  if (payload.type === 'tool_execution_start'
    && typeof payload.toolCallId === 'string'
    && typeof payload.toolName === 'string') {
    return {
      activities: [{
        type: 'tool',
        status: 'running',
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.args,
      }],
    };
  }
  if (payload.type === 'tool_execution_end' && typeof payload.toolCallId === 'string') {
    return {
      activities: [{
        type: 'tool',
        status: payload.isError === true ? 'failed' : 'completed',
        toolCallId: payload.toolCallId,
        ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
        output: payload.result,
        isError: payload.isError === true,
      }],
    };
  }
  if (payload.type === 'message_end' || payload.type === 'turn_end') {
    return piMessageResult(payload.message);
  }
  if (payload.type === 'agent_end' && Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const result = piMessageResult(payload.messages[index]);
      if (result) return result;
    }
  }
  return null;
}

export function parseClaudeStreamLine(line: string): ClaudeStreamLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.type === 'stream_event' && payload.event && typeof payload.event === 'object') {
    const event = payload.event as Record<string, unknown>;
    if (event.type === 'content_block_start' && event.content_block && typeof event.content_block === 'object') {
      const block = event.content_block as Record<string, unknown>;
      if (block.type === 'thinking') {
        return { activities: [{ type: 'reasoning', status: 'running' }] };
      }
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        return {
          activities: [{
            type: 'tool',
            status: 'running',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          }],
        };
      }
    }
    const delta = event.delta;
    if (event.type === 'content_block_delta' && delta && typeof delta === 'object') {
      const block = delta as Record<string, unknown>;
      if (block.type === 'text_delta' && typeof block.text === 'string') return { delta: block.text };
      if (block.type === 'thinking_delta' && typeof block.thinking === 'string') {
        return { activities: [{ type: 'reasoning', status: 'running', delta: block.thinking }] };
      }
    }
  }
  if (payload.type === 'result') {
    const contextTokens = claudeContextTokens(payload.usage);
    return {
      ...(typeof payload.result === 'string' ? { result: payload.result } : {}),
      ...(contextTokens !== null ? { contextTokens } : {}),
      ...(payload.is_error === true ? { isError: true } : {}),
    };
  }
  if (payload.type === 'assistant' && payload.message && typeof payload.message === 'object') {
    const content = (payload.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const assistantText = content.flatMap((part) => (
      part && typeof part === 'object'
        && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    )).join('');
    const activities = content.flatMap((part): SandboxRuntimeActivity[] => {
      if (!part || typeof part !== 'object') return [];
      const block = part as Record<string, unknown>;
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return [];
      return [{
        type: 'tool',
        status: 'running',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      }];
    });
    const contextTokens = claudeContextTokens((payload.message as Record<string, unknown>).usage);
    return assistantText || contextTokens !== null || activities.length
      ? {
          ...(assistantText ? { assistantText } : {}),
          ...(contextTokens !== null ? { contextTokens } : {}),
          ...(activities.length ? { activities } : {}),
        }
      : null;
  }
  if (payload.type === 'user' && payload.message && typeof payload.message === 'object') {
    const content = (payload.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const activities = content.flatMap((part): SandboxRuntimeActivity[] => {
      if (!part || typeof part !== 'object') return [];
      const block = part as Record<string, unknown>;
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return [];
      return [{
        type: 'tool',
        status: block.is_error === true ? 'failed' : 'completed',
        toolCallId: block.tool_use_id,
        output: block.content,
        isError: block.is_error === true,
      }];
    });
    return activities.length ? { activities } : null;
  }
  return null;
}

export function parseDshEventLine(line: string, prefix: string): DshStreamLine | null {
  if (!prefix || !line.startsWith(prefix)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.type === 'text' && typeof payload.delta === 'string') return { delta: payload.delta };
  if (payload.type === 'reasoning'
    && (payload.status === 'running' || payload.status === 'completed')) {
    return {
      activities: [{
        type: 'reasoning',
        status: payload.status,
        ...(typeof payload.delta === 'string' ? { delta: payload.delta } : {}),
      }],
    };
  }
  if (payload.type === 'tool'
    && typeof payload.toolCallId === 'string'
    && (payload.status === 'running' || payload.status === 'completed' || payload.status === 'failed')) {
    let input = payload.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* keep malformed tool arguments readable */ }
    }
    return {
      activities: [{
        type: 'tool',
        status: payload.status,
        toolCallId: payload.toolCallId,
        ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
        ...(payload.input === undefined ? {} : { input }),
        ...(payload.output === undefined ? {} : { output: payload.output }),
        isError: payload.isError === true || payload.status === 'failed',
      }],
    };
  }
  return null;
}

function dockerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', ...extra };
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value);
}

function runDockerOnce(args: string[], timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Docker cleanup timed out.'));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => code === 0
      ? finish()
      : finish(new Error(stderr.trim() || `Docker cleanup failed (${code ?? 'unknown'}).`)));
  });
}

async function terminateDockerExec(container: string, pid: number | null, pidFile: string): Promise<void> {
  const script = `
pid=$1
pid_file=$2
if [ -z "$pid" ] && [ -r "$pid_file" ]; then pid=$(cat "$pid_file" 2>/dev/null || true); fi
rm -f -- "$pid_file"
case "$pid" in ''|*[!0-9]*) exit 3 ;; esac
kill_tree() {
  for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do kill_tree "$child"; done
  kill -KILL "$1" 2>/dev/null || true
}
kill_tree "$pid"
`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await runDockerOnce([
        'exec', container, 'sh', '-c', script, 'toolplane-kill', pid == null ? '' : String(pid), pidFile,
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function runTrackedDockerExec(options: DockerExecOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new Error('Sandbox runtime aborted.'));
  const commandEnv = options.env ?? {};
  for (const [key, value] of Object.entries(commandEnv)) {
    if (!ENV_NAME.test(key) || value.includes('\0')) throw new Error('Invalid sandbox runtime environment.');
  }
  const executionId = randomUUID();
  const controlPrefix = `__TOOLPLANE_RUNTIME_PID_${executionId}__`;
  const pidFile = `/tmp/toolplane-runtime-${executionId}.pid`;
  const wrapper = sandboxRuntimeExecWrapper(controlPrefix);
  const dockerArgs = [
    'exec', '-i', ...(options.user ? ['--user', options.user] : []), '-w', options.workdir,
    ...Object.keys(commandEnv).flatMap((key) => ['--env', key]),
    options.container,
    'sh', '-c', wrapper, 'toolplane-runtime', pidFile, options.executable, ...(options.args ?? []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, {
      env: dockerEnv(commandEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const secrets = options.secrets ?? [];
    const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    let stdout = '';
    let stderr = '';
    let prelude = '';
    let preludeDone = false;
    let innerPid: number | null = null;
    let stopError: Error | null = null;
    let stopping: Promise<void> | null = null;
    let settled = false;
    let callbackChain = Promise.resolve();
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = () => {
      if (stopping) return;
      stopping = terminateDockerExec(options.container, innerPid, pidFile).finally(() => {
        child.kill('SIGKILL');
      });
    };
    const stop = (error: Error) => {
      if (!stopError) stopError = error;
      terminate();
      if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const appendStdout = (chunk: string) => {
      if (!chunk) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > maxStdout) {
        stop(new Error('Sandbox runtime output exceeded its limit.'));
        return;
      }
      stdout += chunk;
      if (options.onStdout) callbackChain = callbackChain.then(() => options.onStdout!(chunk));
    };
    const consumeStdout = (chunk: string) => {
      if (preludeDone) return appendStdout(chunk);
      prelude += chunk;
      const newline = prelude.indexOf('\n');
      if (newline < 0) return;
      const firstLine = prelude.slice(0, newline).replace(/\r$/, '');
      const rest = prelude.slice(newline + 1);
      prelude = '';
      preludeDone = true;
      if (firstLine.startsWith(controlPrefix)) {
        const pid = Number(firstLine.slice(controlPrefix.length));
        if (Number.isSafeInteger(pid) && pid > 0) innerPid = pid;
      } else {
        appendStdout(`${firstLine}\n`);
      }
      if (stopError) terminate();
      appendStdout(rest);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if (stopping) await stopping;
      try {
        await callbackChain;
      } catch (error) {
        reject(error);
        return;
      }
      if (stopError) return reject(stopError);
      if (spawnError) return reject(spawnError);
      if (code !== 0) {
        const detail = redact(stderr.trim(), secrets);
        return reject(new Error(detail || `Sandbox command failed (${signal ?? code ?? 'unknown'}).`));
      }
      resolve(stdout);
    };
    const onAbort = () => stop(new Error('Sandbox runtime aborted.'));
    const timeout = setTimeout(
      () => stop(new Error(`Sandbox runtime timed out after ${options.timeoutMs ?? TURN_TIMEOUT_MS}ms.`)),
      options.timeoutMs ?? TURN_TIMEOUT_MS,
    );

    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
    });
    child.once('error', (error) => void finish(null, null, error));
    child.once('exit', (code, signal) => void finish(code, signal));
    child.stdin?.end(options.stdin ?? '');
  });
}

async function writeSandboxFile(
  container: string,
  path: string,
  content: string | Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const script = 'set -eu; umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"';
  await runTrackedDockerExec({
    container,
    workdir: '/workspace',
    executable: 'sh',
    args: ['-c', script, 'toolplane-write', path],
    stdin: content,
    signal,
    timeoutMs: 30_000,
  });
}

async function materializeSandboxSkills(
  container: string,
  skillRoot: string,
  skills: readonly SkillForPrompt[],
  signal?: AbortSignal,
): Promise<void> {
  const bundles = buildSandboxSkillBundles(skills);
  const digest = sandboxSkillBundleDigest(bundles);
  const marker = `${skillRoot}/.toolplane-skills.sha256`;
  const unchanged = await runTrackedDockerExec({
    container,
    workdir: '/workspace',
    executable: 'sh',
    args: ['-c', 'test -r "$1" && [ "$(cat "$1")" = "$2" ]', 'toolplane-check-skills', marker, digest],
    signal,
    timeoutMs: 10_000,
  }).then(() => true, () => false);
  if (unchanged) return;
  if (signal?.aborted) throw new Error('Sandbox runtime aborted.');
  const reset = `
set -eu
root=$1
case "$root" in /workspace/.toolplane/runtimes/*/agents/*/skills) ;; *) exit 2 ;; esac
rm -rf -- "$root"
mkdir -p "$root"
`;
  await runTrackedDockerExec({
    container,
    workdir: '/workspace',
    executable: 'sh',
    args: ['-c', reset, 'toolplane-reset-skills', skillRoot],
    signal,
    timeoutMs: 30_000,
  });
  for (const bundle of bundles) {
    const directory = `${skillRoot}/${bundle.directory}`;
    await writeSandboxFile(container, `${directory}/SKILL.md`, bundle.markdown, signal);
    for (const file of bundle.files) {
      const path = safeSkillFilePath(file.path);
      if (!path) continue;
      await writeSandboxFile(
        container,
        `${directory}/${path}`,
        file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
        signal,
      );
    }
  }
  await writeSandboxFile(container, marker, digest, signal);
}

async function removeSandboxFiles(container: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await runTrackedDockerExec({
    container,
    workdir: '/workspace',
    executable: 'rm',
    args: ['-f', '--', ...paths],
    timeoutMs: 10_000,
  }).catch(() => undefined);
}

async function assertAssignedDockerSandbox(options: RunSandboxAgentTurnOptions): Promise<string> {
  const link = await db.agentSandbox.findUnique({
    where: { agentId_sandboxId: { agentId: options.agentId, sandboxId: options.sandboxId } },
    select: {
      agent: { select: { workspaceId: true } },
      sandbox: {
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          network: true,
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      },
    },
  });
  if (!link || link.agent.workspaceId !== options.workspaceId || link.sandbox.workspaceId !== options.workspaceId) {
    throw new Error('The sandbox is not assigned to this Agent.');
  }
  if (link.sandbox.kind !== 'docker') throw new Error('Pi, Claude Code, and DeepSeek Harness require a Docker sandbox.');
  if (!sandboxRuntimeCanReachProxy(link.sandbox.network)) {
    throw new Error('The assigned Docker sandbox has networking disabled and cannot reach the model proxy.');
  }
  if (effectiveStatus(link.sandbox.deploymentId, link.sandbox.deployment.status) !== 'running') {
    throw new Error('The assigned Docker sandbox is not running.');
  }
  return link.sandbox.deploymentId;
}

async function ensureRuntimeInstalled(
  runtimeKind: SandboxAgentRuntimeKind,
  container: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('Sandbox runtime aborted.');
  const runtime = SANDBOX_RUNTIME_PACKAGES[runtimeKind];
  const binary = `${runtime.directory}/node_modules/.bin/${runtime.binary}`;
  const cacheKey = `${container}:${runtimeKind}`;
  const existing = installs.get(cacheKey);
  if (existing) return waitForSandboxRuntimeInstall(existing, signal);
  const install = (async () => {
    const found = await runTrackedDockerExec({
      container,
      workdir: '/workspace',
      executable: 'test',
      args: ['-x', binary],
      timeoutMs: 10_000,
    }).then(() => true, () => false);
    if (!found) {
      const installCommand = {
        executable: 'sh',
        args: [
          '-c',
          'set -eu; prefix=$1; shift; mkdir -p "$prefix"; rm -rf -- "$prefix/node_modules"; cd "$prefix"; exec "$@"',
          'toolplane-pnpm-install', runtime.directory,
          'pnpm', 'add', '--prod', '--ignore-workspace',
          ...(runtime.ignoreScripts ? ['--ignore-scripts'] : []),
          ...runtime.allowBuilds.map((name) => `--allow-build=${name}`),
          '--store-dir', `${NPM_CACHE}/pnpm-store`,
          ...runtime.specs,
        ],
      };
      await runTrackedDockerExec({
        container,
        workdir: '/workspace',
        ...installCommand,
        timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
      }).catch((error) => {
        throw new Error(`Could not install ${runtime.specs.join(' and ')} in the assigned sandbox: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await runTrackedDockerExec({
      container,
      workdir: '/workspace',
      executable: 'test',
      args: ['-x', binary],
      timeoutMs: 10_000,
    });
    return binary;
  })();
  installs.set(cacheKey, install);
  const cleanup = () => {
    if (installs.get(cacheKey) === install) installs.delete(cacheKey);
  };
  void install.then(cleanup, cleanup);
  return waitForSandboxRuntimeInstall(install, signal);
}

async function reportContextUsage(
  options: RunSandboxAgentTurnOptions,
  usedTokens: number,
  estimated: boolean,
) {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0 || !options.onContextUsage) return;
  await options.onContextUsage({
    usedTokens: Math.round(usedTokens),
    maxTokens: options.contextWindow,
    modelName: options.modelId,
    estimated: estimated || options.contextWindowEstimated === true,
  });
}

async function reportActivities(
  options: RunSandboxAgentTurnOptions,
  activities: readonly SandboxRuntimeActivity[],
  mcpServers: readonly SandboxRuntimeMcpServer[] = [],
) {
  if (!options.onActivity) return;
  for (const activity of activities) {
    const origin = activity.type === 'tool'
      ? resolveSandboxMcpToolOrigin(activity.toolName, mcpServers)
      : null;
    const enriched = {
      ...activity,
      ...(activity.deploymentId || !origin?.deploymentId ? {} : { deploymentId: origin.deploymentId }),
      ...(activity.originalToolName || !origin?.originalToolName ? {} : { originalToolName: origin.originalToolName }),
    };
    await options.onActivity({
      ...enriched,
      ...(enriched.delta ? { delta: redact(enriched.delta, [options.runtimeAccessToken]) } : {}),
      ...(enriched.toolName ? { toolName: redact(enriched.toolName, [options.runtimeAccessToken]) } : {}),
      ...(enriched.deploymentId ? { deploymentId: redact(enriched.deploymentId, [options.runtimeAccessToken]) } : {}),
      ...(enriched.originalToolName ? { originalToolName: redact(enriched.originalToolName, [options.runtimeAccessToken]) } : {}),
      ...(enriched.input === undefined
        ? {}
        : { input: redact(displayValue(enriched.input), [options.runtimeAccessToken]) }),
      ...(enriched.output === undefined
        ? {}
        : { output: redact(displayValue(enriched.output), [options.runtimeAccessToken]) }),
    });
  }
}

async function runPi(
  options: RunSandboxAgentTurnOptions,
  container: string,
  binary: string,
  workdir: string,
  systemPrompt: string,
  prompt: string,
  skillRoot: string,
  mcpServers: readonly SandboxRuntimeMcpServer[],
): Promise<string> {
  const stateRoot = sandboxRuntimeStateRoot('pi', options.agentId);
  const runId = randomUUID();
  const modelsPath = `${stateRoot}/models.json`;
  const extensionPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-mcp.js`;
  const mcpConfigPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-mcp.json`;
  const systemPromptPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-system.txt`;
  const tempPaths: string[] = [];
  await writeSandboxFile(container, modelsPath, buildPiModelsConfig({
    provider: options.provider,
    modelId: options.modelId,
    modelProxyBase: options.modelProxyBase,
  }), options.signal);

  const args = [
    '--mode', 'json', '--no-session', '--no-approve', '--offline',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--skill', skillRoot,
    '--provider', 'toolplane', '--model', options.modelId,
  ];
  let lineBuffer = '';
  let streamed = '';
  let assistantFallback = '';
  let runtimeError = '';
  let exactUsage = false;
  const consumeLine = async (line: string) => {
    const parsed = parsePiStreamLine(line);
    if (!parsed) return;
    if (parsed.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed.activities) await reportActivities(options, parsed.activities, mcpServers);
    if (parsed.assistantText) assistantFallback = redact(parsed.assistantText, [options.runtimeAccessToken]);
    if (parsed.contextTokens !== undefined) {
      exactUsage = true;
      await reportContextUsage(options, parsed.contextTokens, false);
    }
    if (parsed.isError) runtimeError = redact(parsed.error || 'Pi failed.', [options.runtimeAccessToken]);
  };

  try {
    if (systemPrompt) {
      tempPaths.push(systemPromptPath);
      await writeSandboxFile(container, systemPromptPath, systemPrompt, options.signal);
      args.push('--append-system-prompt', systemPromptPath);
    }
    if (mcpServers.length) {
      tempPaths.push(extensionPath, mcpConfigPath);
      await writeSandboxFile(container, extensionPath, piMcpExtensionSource(), options.signal);
      await writeSandboxFile(container, mcpConfigPath, buildPiMcpConfig(mcpServers), options.signal);
      args.push('--extension', extensionPath);
    }
    await runTrackedDockerExec({
      container,
      workdir,
      executable: binary,
      args,
      stdin: prompt,
      env: {
        TOOLPLANE_RUNTIME_TOKEN: options.runtimeAccessToken,
        PI_CODING_AGENT_DIR: stateRoot,
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        NO_COLOR: '1',
        ...(mcpServers.length ? { TOOLPLANE_PI_MCP_CONFIG: mcpConfigPath } : {}),
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
      secrets: [options.runtimeAccessToken],
      onStdout: async (chunk) => {
        lineBuffer += chunk;
        for (;;) {
          const newline = lineBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline).trim();
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line) await consumeLine(line);
        }
      },
    });
    if (lineBuffer.trim()) await consumeLine(lineBuffer.trim());
    if (runtimeError) throw new Error(runtimeError);
    const text = streamed || assistantFallback;
    if (!text) throw new Error('Pi returned no assistant text.');
    if (!streamed) await options.onTextDelta?.(text);
    if (!exactUsage) await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    await removeSandboxFiles(container, tempPaths);
  }
}

async function runClaudeCode(
  options: RunSandboxAgentTurnOptions,
  container: string,
  binary: string,
  workdir: string,
  systemPrompt: string,
  prompt: string,
  mcpServers: readonly SandboxRuntimeMcpServer[],
): Promise<string> {
  const modelProxyBase = httpUrl(options.modelProxyBase, 'model proxy URL');
  const stateRoot = sandboxRuntimeStateRoot('claude-code', options.agentId);
  const tempPath = `${RUNTIME_TEMP_ROOT}/${randomUUID()}-claude-mcp.json`;
  const args = [
    '--bare', '--print', '--verbose', '--output-format', 'stream-json',
    '--include-partial-messages', '--no-session-persistence',
    '--setting-sources', 'user',
    '--dangerously-skip-permissions', '--model', options.modelId,
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
  ];
  if (mcpServers.length) {
    await writeSandboxFile(container, tempPath, buildClaudeMcpConfig(mcpServers, options.runtimeAccessToken), options.signal);
    args.push('--mcp-config', tempPath, '--strict-mcp-config');
  }
  await runTrackedDockerExec({
    container,
    workdir: '/workspace',
    executable: 'sh',
    args: [
      '-c',
      'set -eu; mkdir -p "$1"; chown -R "$2" /workspace',
      'toolplane-claude-user',
      stateRoot,
      CLAUDE_RUNTIME_USER,
    ],
    signal: options.signal,
    timeoutMs: 2 * 60_000,
  });
  let lineBuffer = '';
  let streamed = '';
  let finalResult = '';
  let assistantFallback = '';
  let runtimeError = '';
  let exactUsage = false;
  const consumeLine = async (line: string) => {
    const parsed = parseClaudeStreamLine(line);
    if (!parsed) return;
    if (parsed.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed.activities) await reportActivities(options, parsed.activities, mcpServers);
    if (parsed.result) finalResult = redact(parsed.result, [options.runtimeAccessToken]);
    if (parsed.assistantText) assistantFallback = redact(parsed.assistantText, [options.runtimeAccessToken]);
    if (parsed.contextTokens !== undefined) {
      exactUsage = true;
      await reportContextUsage(options, parsed.contextTokens, false);
    }
    if (parsed.isError) runtimeError = finalResult || 'Claude Code failed.';
  };
  try {
    await runTrackedDockerExec({
      container,
      workdir,
      executable: binary,
      user: CLAUDE_RUNTIME_USER,
      args,
      stdin: prompt,
      env: {
        ANTHROPIC_API_KEY: options.runtimeAccessToken,
        ANTHROPIC_AUTH_TOKEN: options.runtimeAccessToken,
        ANTHROPIC_BASE_URL: modelProxyBase,
        CLAUDE_CONFIG_DIR: stateRoot,
        HOME: stateRoot,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_TELEMETRY: '1',
        NO_COLOR: '1',
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
      secrets: [options.runtimeAccessToken],
      onStdout: async (chunk) => {
        lineBuffer += chunk;
        for (;;) {
          const newline = lineBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline).trim();
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line) await consumeLine(line);
        }
      },
    });
    if (lineBuffer.trim()) await consumeLine(lineBuffer.trim());
    if (runtimeError) throw new Error(runtimeError);
    const text = streamed || finalResult || assistantFallback;
    if (!text) throw new Error('Claude Code returned no assistant text.');
    if (!streamed && options.onTextDelta) await options.onTextDelta(text);
    if (!exactUsage) await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    await removeSandboxFiles(container, mcpServers.length ? [tempPath] : []);
  }
}

async function runDsh(
  options: RunSandboxAgentTurnOptions,
  container: string,
  binary: string,
  workdir: string,
  systemPrompt: string,
  prompt: string,
  skillRoot: string,
  mcpServers: readonly SandboxRuntimeMcpServer[],
): Promise<string> {
  const modelProxyBase = httpUrl(options.modelProxyBase, 'model proxy URL');
  const stateRoot = sandboxRuntimeStateRoot('dsh', options.agentId);
  const runId = randomUUID();
  const patchPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh.patch.yml`;
  const promptPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh.prompt.txt`;
  const eventPluginPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh-events.mjs`;
  const eventPrefix = `__TOOLPLANE_DSH_EVENT_${runId}__`;
  const patch = buildDshPatch({
    provider: options.provider,
    modelId: options.modelId,
    modelProxyBase,
    systemPrompt,
    skillRoot,
    mcpServers,
    eventPluginPath,
  });
  await writeSandboxFile(container, eventPluginPath, dshEventTapSource(eventPrefix), options.signal);
  await writeSandboxFile(container, patchPath, patch, options.signal);
  await writeSandboxFile(container, promptPath, prompt, options.signal);
  const promptWrapper = 'set -eu; prompt_file=$1; shift; prompt=$(cat "$prompt_file"); exec "$@" "$prompt"';
  let lineBuffer = '';
  let streamed = '';
  const consumeLine = async (line: string) => {
    const parsed = parseDshEventLine(line, eventPrefix);
    if (!parsed) return;
    if (parsed.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed.activities) await reportActivities(options, parsed.activities, mcpServers);
  };
  try {
    const output = await runTrackedDockerExec({
      container,
      workdir,
      executable: 'sh',
      args: [
        '-c', promptWrapper, 'toolplane-dsh', promptPath,
        binary, '--profile', 'headless', '--patch', patchPath,
      ],
      env: {
        TOOLPLANE_RUNTIME_TOKEN: options.runtimeAccessToken,
        TOOLPLANE_MCP_AUTH: `Bearer ${options.runtimeAccessToken}`,
        DSH_HOME: stateRoot,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: 'native',
        NO_COLOR: '1',
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
      secrets: [options.runtimeAccessToken],
      onStdout: async (chunk) => {
        lineBuffer += chunk;
        for (;;) {
          const newline = lineBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line.startsWith(eventPrefix)) await consumeLine(line);
        }
      },
    });
    if (lineBuffer.startsWith(eventPrefix)) await consumeLine(lineBuffer);
    const fallback = output.split(/\r?\n/).filter((line) => !line.startsWith(eventPrefix)).join('\n').trim();
    const text = streamed || redact(fallback, [options.runtimeAccessToken]);
    if (!text) throw new Error('DeepSeek Harness returned no assistant text.');
    if (!streamed) await options.onTextDelta?.(text);
    await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    await removeSandboxFiles(container, [patchPath, promptPath, eventPluginPath]);
  }
}

export async function runSandboxAgentTurn(options: RunSandboxAgentTurnOptions): Promise<string> {
  if (!options.runtimeAccessToken || options.runtimeAccessToken.length > 8_192 || /[\0\r\n]/.test(options.runtimeAccessToken)) {
    throw new Error('Invalid sandbox runtime access token.');
  }
  if (!options.modelId.trim() || options.modelId.length > 500 || options.modelId.includes('\0')) {
    throw new Error('Invalid sandbox runtime model.');
  }
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error('Invalid sandbox runtime context window.');
  }
  const sandboxDeploymentId = await assertAssignedDockerSandbox(options);
  const container = sandboxContainerName(options.sandboxId);
  const workdir = normalizeSandboxWorkingDirectory(options.workingDirectory);
  const prompt = buildSandboxTranscript(options.messages);
  if (!prompt) throw new Error('The sandbox runtime turn has no user-visible message.');
  const systemPrompt = options.systemPrompt?.trim() ?? '';
  const mcpServers = (options.mcpServers ?? []).filter((server) => server.deploymentId !== sandboxDeploymentId);
  const binary = await ensureRuntimeInstalled(options.runtimeKind, container, options.signal);
  const skillRoot = sandboxRuntimeSkillRoot(options.runtimeKind, options.agentId);
  await materializeSandboxSkills(container, skillRoot, options.skills ?? [], options.signal);
  if (options.runtimeKind === 'pi') {
    return runPi(options, container, binary, workdir, systemPrompt, prompt, skillRoot, mcpServers);
  }
  if (options.runtimeKind === 'claude-code') {
    return runClaudeCode(options, container, binary, workdir, systemPrompt, prompt, mcpServers);
  }
  return runDsh(options, container, binary, workdir, systemPrompt, prompt, skillRoot, mcpServers);
}
