import 'server-only';
import { nativeApprovalAdapter, claudeApprovalSettings } from './native-tool-approval';
import { withSandboxExecutionLease } from './sandbox-execution-gate';
import { runHermesRpcTurn } from './hermes-rpc';
import { PiRuntimeInterruptedError } from './pi-harness';
import { assertRuntimeOwner, trackRuntimeOperation, runtimeAbortSignal, markRuntimeUncertain } from '@/lib/runtime/ownership-state';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readFile } from 'node:fs/promises';
import { db } from '@/lib/db';
import { estimateContextTokens, parseContextUsage, type ContextUsageSnapshot } from '@/lib/context-usage';
import { effectiveStatus } from '@/lib/process/supervisor';
import { sandboxContainerName } from '@/lib/sandboxes/runtime';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { safeSkillFilePath, type SkillBundleFile } from '@/lib/skills/bundle';
import { skillLabel } from '@/lib/workspace/skill-label';
import { agentRuntimeBuiltinToolGroups, normalizeDisabledBuiltinTools } from './runtime-kind';
import type { SkillForPrompt } from './resolve';
import { RuntimeCommandsSchema, parseRuntimeUsage, type RuntimeCommand, type RuntimeUsage } from './runtime-commands';
import { parsePiPackageReleaseManifest } from '@/lib/market/pi-package-manifest';
import type { PiPackageManifestV1 } from '@/lib/market/pi-package-manifest';
import { HOST_ONLY_COMMAND_NAMES } from './runtime-commands';
import type { RuntimeCommandResult } from './runtime-commands';

export const DEFAULT_PI_VERSION = '0.80.3';
export type PiRuntimeVersion = { version: string; installed: boolean };

// Harness storage format 4 is pre-stable: never follow the user's CLI pin.
export const PI_HARNESS_RUNTIME = {
  specs: [
    '@earendil-works/pi-agent-core@0.87.1',
    '@earendil-works/pi-session-backend-sqlite-node@0.87.1',
    '@earendil-works/pi-coding-agent@0.87.1',
    '@earendil-works/pi-ai@0.87.1',
    '@modelcontextprotocol/sdk@1.30.0',
    '@a2a-js/sdk@1.2.0',
  ],
  directory: '/workspace/.toolplane/runtime-packages/pi-harness-0.87.1',
  binary: 'pi',
  ignoreScripts: true,
  allowBuilds: [],
} as const;

export const PI_SDK_RUNTIME = {
  specs: ['@earendil-works/pi-coding-agent@0.87.1', '@earendil-works/pi-ai@0.87.1'],
  directory: '/workspace/.toolplane/runtime-packages/pi-sdk-0.87.1',
  binary: 'pi', ignoreScripts: true, allowBuilds: [],
} as const;

export function validatePiVersion(value: string): string {
  if (value.length > 80 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
    throw new Error('Enter an exact Pi version, for example 0.80.3.');
  }
  return value;
}

export const SANDBOX_RUNTIME_PACKAGES = {
  pi: {
    specs: [
      `@earendil-works/pi-coding-agent@${DEFAULT_PI_VERSION}`,
      `@earendil-works/pi-ai@${DEFAULT_PI_VERSION}`,
    ],
    directory: `/workspace/.toolplane/runtime-packages/pi-${DEFAULT_PI_VERSION}`,
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

export type SandboxAgentRuntimeKind = 'pi' | 'pi-sdk' | 'claude-code' | 'dsh' | 'hermes-rpc';

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
  maxSteps?: number;
  contextWindow: number;
  contextWindowEstimated?: boolean;
  modelProxyBase: string;
  runtimeAccessToken: string;
  nativeApprovalUrl?: string;
  systemPrompt?: string | null;
  disabledBuiltinTools?: readonly string[];
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  mcpServers?: readonly SandboxRuntimeMcpServer[];
  piPackages?: readonly { marketInstallId: string; releaseId: string; checksum: string; manifest: PiPackageManifestV1; mcpBindingsChecksum?: string }[];
  workingDirectory?: string | null;
  runtimeSessionId?: string;
  command?: string;
  piHarness?: { historyRequired?: boolean; sessionRequired?: boolean; communicationEnabled?: boolean; thinkingLevel?: string };
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
  onCommands?: (commands: RuntimeCommand[]) => void | Promise<void>;
  onUsage?: (usage: RuntimeUsage) => void | Promise<void>;
  onCommandResult?: (result: RuntimeCommandResult) => void | Promise<void>;
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
  piHarness?: boolean;
};

const installs = new Map<string, Promise<string>>();
const uncertainPiSandboxes = new Set<string>();

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
  disabledBuiltinTools?: readonly string[];
  eventPluginPath?: string;
  driverPluginPath?: string;
  approvalPluginPath?: string;
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
  const dshRowsByTool: Record<string, string[]> = {
    read: ['tool-fs'],
    read_image: ['tool-fs'],
    edit: ['tool-fs'],
    write: ['tool-fs'],
    str_replace_editor: ['tool-fs'],
    glob: ['tool-fs-search'],
    grep: ['tool-fs-search'],
    web_search: ['tool-web'],
    bash: ['tool-bash'],
    job_output: ['tool-jobs'],
    job_list: ['tool-jobs'],
    job_kill: ['tool-jobs'],
    todo_write: ['tool-todo'],
    skill: ['tool-skill'],
    get_goal: ['tool-goal'],
    create_goal: ['tool-goal'],
    update_goal: ['tool-goal'],
    exit_plan_mode: ['plan-mode'],
    subagent: ['tool-subagent'],
    subagent_fork: ['tool-subagent-fork'],
    send_message: ['tool-subagent-control'],
    interrupt_agent: ['tool-subagent-control'],
    list_agents: ['tool-subagent-list-agents'],
    workflow: ['tool-workflow'],
    ralph: ['tool-ralph'],
  };
  const disabledRows = new Set((options.disabledBuiltinTools ?? [])
    .flatMap((tool) => dshRowsByTool[tool] ?? []));
  for (const row of disabledRows) {
    rows.push(`- id: ${yamlString(row)}`, '  disabled: true');
  }
  const servers = options.mcpServers ?? [];
  if (options.driverPluginPath) rows.push('- id: headless-runner', '  disabled: true');
  if (options.approvalPluginPath || options.eventPluginPath || options.driverPluginPath || servers.length) {
    rows.push('- insert:');
    if (options.approvalPluginPath) rows.push('    - id: toolplane-native-approval', `      name: ${yamlString(`file://${options.approvalPluginPath}`)}`);
    if (options.driverPluginPath) rows.push('    - id: toolplane-driver', `      name: ${yamlString(`file://${options.driverPluginPath}`)}`);
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

export function buildClaudeSkillPluginManifest(): string {
  return `${JSON.stringify({
    name: 'toolplane-agent',
    version: '0.0.0',
    description: 'Skills selected for this ToolPlane agent.',
    skills: './skills/',
  }, null, 2)}\n`;
}

export function buildClaudeRuntimeArgs(options: {
  modelId: string;
  runtimeSessionId?: string;
  systemPrompt: string;
  disabledBuiltinTools: readonly string[];
  skillPluginRoot?: string;
  approvalSettings?: string;
}): string[] {
  return [
    ...(options.approvalSettings ? [] : ['--bare']), '--print', '--verbose', '--output-format', 'stream-json',
    '--include-partial-messages', ...(options.runtimeSessionId ? ['--input-format', 'stream-json'] : ['--no-session-persistence']),
    '--setting-sources', options.approvalSettings ? '' : 'user',
    ...(options.approvalSettings ? ['--permission-mode', 'dontAsk', '--settings', options.approvalSettings] : ['--dangerously-skip-permissions']), '--model', options.modelId,
    ...(options.disabledBuiltinTools.length ? ['--disallowedTools', ...options.disabledBuiltinTools] : []),
    ...(options.skillPluginRoot ? ['--plugin-dir', options.skillPluginRoot] : []),
    ...(options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []),
  ];
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
export function piMcpExtensionSource(options: { eventFd?: 1 | 3 } = {}): string {
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

export async function createPiMcpTools(config) {
  if (!config || !Array.isArray(config.servers)) throw new Error('Invalid ToolPlane Pi MCP config');

  let registeredTools = 0;
  const definitions = [];
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
      definitions.push({
        name: safeToolName(serverIndex, toolIndex, wireName),
        label: wireName,
        description: short((tool.description || '') + '\nMCP server: ' + server.name),
        parameters: toolParameters(tool.inputSchema),
        async execute(toolCallId, params, signal) {
          writeSync(${options.eventFd ?? 1}, JSON.stringify({
            type: 'toolplane_mcp_origin',
            toolCallId,
            deploymentId: server.deploymentId,
            originalToolName: wireName,
          }) + '\n');
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
  if (payload.type === 'system' && payload.subtype === 'status' && (payload.compact_result === 'failed' || typeof payload.compact_error === 'string')) {
    return { result: typeof payload.compact_error === 'string' ? payload.compact_error : 'Compaction failed.', isError: true };
  }
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
      ...(typeof payload.result === 'string' ? { result: payload.result } : Array.isArray(payload.errors) ? { result: payload.errors.filter((error) => typeof error === 'string').join('\n') } : {}),
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
  assertRuntimeOwner(true);
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
      markRuntimeUncertain();
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

async function terminateDockerExec(container: string, pid: number | null, pidFile: string, confirm = false): Promise<void> {
  const script = `
pid=$1
pid_file=$2
if [ -z "$pid" ] && [ -r "$pid_file" ]; then pid=$(cat "$pid_file" 2>/dev/null || true); fi
rm -f -- "$pid_file"
case "$pid" in ''|*[!0-9]*) exit 3 ;; esac
pids=''
kill_tree() {
  for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do kill_tree "$child"; done
  pids="$pids $1"
  kill -KILL "$1" 2>/dev/null || true
}
kill_tree "$pid"
if [ "$3" = confirm ]; then
  for stopped in $pids; do
    attempts=0
    while kill -0 "$stopped" 2>/dev/null; do
      stat=$(cat "/proc/$stopped/stat" 2>/dev/null || true)
      case "$stat" in ''|*') Z '*) break ;; esac
      attempts=$((attempts + 1))
      [ "$attempts" -lt 50 ] || exit 4
      sleep 0.1
    done
  done
fi
`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await runDockerOnce([
        'exec', container, 'sh', '-c', script, 'toolplane-kill', pid == null ? '' : String(pid), pidFile, confirm ? 'confirm' : '',
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (confirm) {
    uncertainPiSandboxes.add(container);
    markRuntimeUncertain();
    throw new Error('PI_PROCESS_STOP_UNCONFIRMED: runtime owner recovery is required before reopening this sandbox.');
  }
}

function runTrackedDockerExec(options: DockerExecOptions): Promise<string> {
  const ownerSignal = runtimeAbortSignal();
  const signal = ownerSignal ? (options.signal ? AbortSignal.any([options.signal, ownerSignal]) : ownerSignal) : options.signal;
  return trackRuntimeOperation(() => runTrackedDockerExecOwned({ ...options, signal }));
}
function runTrackedDockerExecOwned(options: DockerExecOptions): Promise<string> {
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
    let terminationError: unknown;
    let aborted = false;
    let settled = false;
    let callbackChain = Promise.resolve();
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = () => {
      if (stopping) return;
      stopping = terminateDockerExec(options.container, innerPid, pidFile, options.piHarness).catch((error: unknown) => {
        terminationError = error;
      }).finally(() => { child.kill('SIGKILL'); });
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
      if (options.piHarness && code !== 0 && !spawnError) terminate();
      if (stopping) await stopping;
      if (terminationError) return reject(terminationError);
      try {
        await callbackChain;
      } catch (error) {
        reject(error);
        return;
      }
      if (stopError) return reject(options.piHarness && aborted
        ? new PiRuntimeInterruptedError('Pi driver stopped before its operation settled.', { cause: stopError }) : stopError);
      if (spawnError) return reject(options.piHarness && ['EPIPE', 'ECONNRESET', 'ECONNABORTED'].includes((spawnError as NodeJS.ErrnoException).code ?? '')
        ? new PiRuntimeInterruptedError('Pi driver transport disconnected.', { cause: spawnError }) : spawnError);
      if (code !== 0) {
        const detail = redact(stderr.trim(), secrets);
        if (options.piHarness && (signal || code === 137 || code === 143)) {
          return reject(new PiRuntimeInterruptedError(detail || 'Pi driver process was terminated.'));
        }
        return reject(new Error(detail || `Sandbox command failed (${signal ?? code ?? 'unknown'}).`));
      }
      resolve(stdout);
    };
    const onAbort = () => { aborted = true; stop(new Error('Sandbox runtime aborted.')); };
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
    child.once(options.piHarness ? 'close' : 'exit', (code, signal) => void finish(code, signal));
    if (options.piHarness) {
      const onTransportError = (error: NodeJS.ErrnoException) => stop(
        ['EPIPE', 'ECONNRESET', 'ECONNABORTED'].includes(error.code ?? '')
          ? new PiRuntimeInterruptedError('Pi driver transport disconnected.', { cause: error }) : error,
      );
      child.stdin?.on('error', onTransportError);
      child.stdout?.on('error', onTransportError);
      child.stderr?.on('error', onTransportError);
    }
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
  runtimeKind: SandboxAgentRuntimeKind,
  skillRoot: string,
  skills: readonly SkillForPrompt[],
  signal?: AbortSignal,
): Promise<void> {
  const claudePlugin = runtimeKind === 'claude-code';
  const skillDirectory = claudePlugin ? `${skillRoot}/skills` : skillRoot;
  const bundles = buildSandboxSkillBundles(skills);
  const pluginManifest = claudePlugin ? buildClaudeSkillPluginManifest() : '';
  const digest = claudePlugin
    ? createHash('sha256').update(pluginManifest).update('\0').update(sandboxSkillBundleDigest(bundles)).digest('hex')
    : sandboxSkillBundleDigest(bundles);
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
    const directory = `${skillDirectory}/${bundle.directory}`;
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
  if (claudePlugin) {
    await writeSandboxFile(container, `${skillRoot}/.claude-plugin/plugin.json`, pluginManifest, signal);
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

async function assertAssignedDockerSandbox(options: Pick<RunSandboxAgentTurnOptions, 'workspaceId' | 'agentId' | 'sandboxId'>): Promise<string> {
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
  runtimeKind: keyof typeof SANDBOX_RUNTIME_PACKAGES | 'pi-harness' | 'pi-sdk',
  container: string,
  signal?: AbortSignal,
  piVersion = DEFAULT_PI_VERSION,
): Promise<string> {
  if (signal?.aborted) throw new Error('Sandbox runtime aborted.');
  const runtime = runtimeKind === 'pi-harness' ? PI_HARNESS_RUNTIME
    : runtimeKind === 'pi-sdk' ? PI_SDK_RUNTIME
    : runtimeKind === 'pi' ? piRuntimePackage(piVersion) : SANDBOX_RUNTIME_PACKAGES[runtimeKind];
  const binary = `${runtime.directory}/node_modules/.bin/${runtime.binary}`;
  const cacheKey = `${container}:${runtime.directory}`;
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
          'pnpm', 'add', '--save-prod', '--ignore-workspace',
          ...(runtimeKind === 'pi-harness' || runtimeKind === 'pi-sdk' ? ['--save-exact'] : []),
          ...(runtime.ignoreScripts ? ['--ignore-scripts'] : []),
          ...runtime.allowBuilds.map((name) => `--allow-build=${name}`),
          '--store-dir', `${NPM_CACHE}/pnpm-store`, ...runtime.specs,
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
    if (runtimeKind === 'pi-sdk') await runTrackedDockerExec({
      container, workdir: runtime.directory, executable: 'node',
      args: ['-e', "const fs=require('node:fs'); if(Number(process.versions.node.split('.')[0])!==24 || process.platform!=='linux') throw Error('package_platform_mismatch'); for(const name of ['@earendil-works/pi-coding-agent','@earendil-works/pi-ai']) if(JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version!=='0.87.1') throw Error('PI_SDK_VERSION_MISMATCH');"],
      timeoutMs: 30_000,
    });
    if (runtimeKind === 'pi-harness') {
      await runTrackedDockerExec({
        container, workdir: runtime.directory, executable: 'node',
        args: ['--input-type=module', '-e', `
          import { readFileSync } from 'node:fs';
          import { DatabaseSync } from 'node:sqlite';
          const [major, minor] = process.versions.node.split('.').map(Number);
          if (major < 22 || (major === 22 && minor < 19)) throw new Error('PI_NODE_UNSUPPORTED: Node >=22.19.0 required');
          if (!DatabaseSync) throw new Error('PI_SQLITE_UNAVAILABLE');
          for (const [name, version] of ${JSON.stringify(PI_HARNESS_RUNTIME.specs.map((spec) => [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]))}) {
            const info = JSON.parse(readFileSync(process.cwd() + '/node_modules/' + name + '/package.json', 'utf8'));
            if (info.version !== version) throw new Error('PI_HARNESS_VERSION_MISMATCH: ' + name);
          }
        `],
        timeoutMs: 30_000,
      });
      const proofSource = await readFile(`${process.cwd()}/scripts/pi-harness-recovery-check.mjs`, 'utf8');
      const digest = createHash('sha256').update(proofSource).update(JSON.stringify(runtime.specs)).digest('hex');
      const marker = `${runtime.directory}/.recovery-verified`;
      const verified = await runTrackedDockerExec({ container, workdir: runtime.directory, executable: 'sh',
        args: ['-c', 'test -r "$1" && [ "$(cat "$1")" = "$2" ]', 'toolplane-pi-proof', marker, digest], timeoutMs: 10_000,
      }).then(() => true, () => false);
      if (!verified) {
        const proofPath = `${runtime.directory}/pi-harness-recovery-check.mjs`;
        await writeSandboxFile(container, proofPath, proofSource);
        const proof = await runTrackedDockerExec({ container, workdir: runtime.directory, executable: 'node',
          args: [proofPath, '--self-test'], timeoutMs: 60_000 });
        if (proof.trim() !== 'PI_HARNESS_RECOVERY_VERIFIED') throw new Error('PI_RECOVERY_CHECK_FAILED');
        await writeSandboxFile(container, marker, digest);
      }
    }
    return binary;
  })();
  installs.set(cacheKey, install);
  const cleanup = () => {
    if (installs.get(cacheKey) === install) installs.delete(cacheKey);
  };
  void install.then(cleanup, cleanup);
  return waitForSandboxRuntimeInstall(install, signal);
}

function piRuntimePackage(version: string) {
  validatePiVersion(version);
  return { ...SANDBOX_RUNTIME_PACKAGES.pi,
    specs: [`@earendil-works/pi-coding-agent@${version}`, `@earendil-works/pi-ai@${version}`],
    directory: `/workspace/.toolplane/runtime-packages/pi-${version}` };
}

async function readPiVersion(container: string, agentId: string, signal?: AbortSignal): Promise<string> {
  const version = await runTrackedDockerExec({ container, workdir: '/workspace', executable: 'node',
    args: ['-e', "try { process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
      `${sandboxRuntimeStateRoot('pi', agentId)}/version`], signal, timeoutMs: 10_000, maxStdoutBytes: 100 });
  return version ? validatePiVersion(version.trim()) : DEFAULT_PI_VERSION;
}

async function piManagementSandbox(workspaceId: string, agentId: string) {
  const agent = await db.agent.findFirst({ where: { id: agentId, workspaceId, runtimeKind: 'pi', publicRuntimeAllocation: null },
    select: { sandboxes: { select: { sandboxId: true } } } });
  if (!agent || agent.sandboxes.length !== 1) throw new Error('Pi requires exactly one assigned Docker sandbox.');
  const sandboxId = agent.sandboxes[0].sandboxId;
  await assertAssignedDockerSandbox({ workspaceId, agentId, sandboxId });
  return sandboxId;
}

export async function getPiRuntimeVersion(workspaceId: string, agentId: string): Promise<PiRuntimeVersion> {
  assertRuntimeOwner();
  const sandboxId = await piManagementSandbox(workspaceId, agentId);
  return withSandboxExecutionLease(sandboxId, async () => {
    const container = sandboxContainerName(sandboxId);
    const version = await readPiVersion(container, agentId);
    const binary = `${piRuntimePackage(version).directory}/node_modules/.bin/pi`;
    const installed = await runTrackedDockerExec({ container, workdir: '/workspace', executable: 'node',
      args: ['-e', "const fs = require('node:fs'); try { fs.accessSync(process.argv[1], fs.constants.X_OK); process.stdout.write('yes'); } catch (error) { if (error.code !== 'ENOENT') throw error; }", binary],
      timeoutMs: 10_000 });
    return { version, installed: installed === 'yes' };
  });
}

export async function updatePiRuntimeVersion(workspaceId: string, agentId: string, version: string) {
  validatePiVersion(version);
  const release = beginWorkspaceOperation(workspaceId);
  if (!release) throw new Error('The workspace is being deleted.');
  try {
    const sandboxId = await piManagementSandbox(workspaceId, agentId);
    return await withSandboxExecutionLease(sandboxId, async () => {
      const container = sandboxContainerName(sandboxId);
      const binary = await ensureRuntimeInstalled('pi', container, runtimeAbortSignal(), version);
      const reported = await runTrackedDockerExec({ container, workdir: '/workspace', executable: binary,
        args: ['--version'], timeoutMs: 30_000, maxStdoutBytes: 1_024 });
      if (reported.trim() !== version) throw new Error('The installed Pi executable did not report the requested version.');
      // Commit only after validation; a failed install leaves the previous version and sessions intact.
      await piManagementSandbox(workspaceId, agentId).then((current) => {
        if (current !== sandboxId) throw new Error('The assigned sandbox changed during the update.');
      });
      const marker = `${sandboxRuntimeStateRoot('pi', agentId)}/version`;
      await runTrackedDockerExec({ container, workdir: '/workspace', executable: 'node',
        args: ['-e', "const fs = require('node:fs'); const path = require('node:path'); const [file, version] = process.argv.slice(1); fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.tmp'; fs.writeFileSync(temp, version, { mode: 0o600 }); fs.renameSync(temp, file);", marker, version],
        timeoutMs: 10_000 });
      return { version, installed: true };
    });
  } finally { release(); }
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

export function parseClaudeRuntimeMetadata(line: string): { commands?: RuntimeCommand[]; usage?: RuntimeUsage } {
  let event;
  try { event = JSON.parse(line); } catch { return {}; }
  if (event?.type === 'system' && (event.subtype === 'init' || event.subtype === 'commands_changed')) {
    const catalog = event.subtype === 'init' ? event.slash_commands : event.commands;
    const commands = RuntimeCommandsSchema.safeParse(Array.isArray(catalog) ? catalog.slice(0, 200).map((item) => event.subtype === 'init' ? { name: item } : { name: item?.name, ...(item?.description ? { description: item.description } : {}) }) : undefined);
    if (commands.success) return { commands: commands.data };
  }
  if (event?.type === 'result' && event.usage) {
    const usage = parseRuntimeUsage({ inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens,
      cacheReadTokens: event.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
      ...(typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0 ? { costUsd: event.total_cost_usd } : {}) });
    if (usage) return { usage };
  }
  return {};
}

function nativeCommandResult(line: string): { text: string; isError?: boolean } | null {
  try {
    const event = JSON.parse(line);
    return event.type === 'toolplane_command_result' && typeof event.text === 'string' ? event : null;
  } catch { return null; }
}

async function runNativeSessionExec(options: RunSandboxAgentTurnOptions, exec: DockerExecOptions, sdk?: { configPath: string; packageSetChecksum: string; mcpConfig: unknown }) {
  if (options.runtimeKind === 'hermes-rpc') throw new Error('Hermes RPC uses its own native protocol driver.');
  if (!options.runtimeSessionId) return runTrackedDockerExec(exec);
  const id = randomUUID();
  const driverPath = `${RUNTIME_TEMP_ROOT}/${id}-session.mjs`;
  const inputPath = `${RUNTIME_TEMP_ROOT}/${id}-session.json`;
  const history = options.command ? options.messages : options.messages.slice(0, -1);
  await writeSandboxFile(exec.container, driverPath, await readFile(`${process.cwd()}/scripts/native-runtime-session.mjs`, 'utf8'), options.signal);
  await writeSandboxFile(exec.container, inputPath, JSON.stringify({
    kind: options.runtimeKind, binary: exec.executable, args: exec.args,
    model: options.modelId, api: options.provider.format === 'anthropic' ? 'anthropic-messages' : options.provider.format === 'openai-responses' ? 'openai-responses' : 'openai-completions',
    packageRoot: sdk ? PI_SDK_RUNTIME.directory : posix.dirname(posix.dirname(posix.dirname(exec.executable))),
    statePath: `${sandboxRuntimeStateRoot(options.runtimeKind, options.agentId)}/sessions/${options.runtimeSessionId}.json`,
    signature: createHash('sha256').update(JSON.stringify({ binary: exec.executable, ...(sdk ? { sdkVersion: '0.87.1', packageSetChecksum: sdk.packageSetChecksum, nativeApproval: Boolean(options.nativeApprovalUrl) } : { credentialGeneration: createHash('sha256').update(options.runtimeAccessToken).digest('hex') }), args: exec.args, workdir: exec.workdir, model: options.modelId, provider: options.provider, system: options.systemPrompt, ...(!sdk ? { mcp: options.mcpServers } : {}), skills: options.skills })).digest('hex'),
    ...(sdk ? { sdkConfigPath: sdk.configPath, context: { runtimeToken: options.runtimeAccessToken, approvalUrl: options.nativeApprovalUrl, mcpConfig: sdk.mcpConfig } } : {}),
    command: options.command, prompt: buildSandboxTranscript(options.messages), message: buildSandboxTranscript(options.messages.slice(-1)),
    history: history.filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => ({ role: message.role, text: buildSandboxTranscript([message]) })),
  }), options.signal);
  if (exec.user) await runTrackedDockerExec({ container: exec.container, workdir: '/workspace', executable: 'chown', args: [exec.user, driverPath, inputPath], signal: options.signal, timeoutMs: 10_000 });
  try { return await runTrackedDockerExec({ ...exec, executable: 'node', args: [driverPath, inputPath], stdin: undefined }); }
  finally { await removeSandboxFiles(exec.container, [driverPath, inputPath]); }
}

async function runPiSdk(options: RunSandboxAgentTurnOptions, container: string, workdir: string, skillRoot: string, mcpServers: readonly SandboxRuntimeMcpServer[]): Promise<string> {
  const runtimeSessionId = options.runtimeSessionId ?? randomUUID();
  options = { ...options, runtimeSessionId };
  const stateRoot = sandboxRuntimeStateRoot('pi-sdk', options.agentId);
  const privateRoot = `${stateRoot}/host`;
  const hostPath = `${privateRoot}/pi-sdk-session.mjs`;
  const verifierPath = `${privateRoot}/pi-sdk-package-files.mjs`;
  const factoryPath = `${privateRoot}/pi-mcp.mjs`;
  const configPath = `${privateRoot}/${runtimeSessionId}.json`;
  const approvalHelperPath = `${privateRoot}/a2a-native-approval.mjs`;
  const approvalExtensionPath = `${privateRoot}/approval-pi.mjs`;
  const packages = [...(options.piPackages ?? [])].sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId)).map((item) => {
    const manifest = parsePiPackageReleaseManifest(item.manifest, item.checksum);
    return { marketInstallId: item.marketInstallId, releaseId: item.releaseId, checksum: item.checksum, manifest,
      ...(item.mcpBindingsChecksum ? { mcpBindingsChecksum: item.mcpBindingsChecksum } : {}),
      root: `${stateRoot}/packages/${item.checksum}/snapshot`, manifestPath: `${stateRoot}/packages/${item.checksum}/manifest.json` };
  });
  if (packages.length > 16 || new Set(packages.map((item) => item.marketInstallId)).size !== packages.length) throw new Error('PI_PACKAGE_UNAVAILABLE');
  const packageSetChecksum = createHash('sha256').update(JSON.stringify(packages.map(({ marketInstallId, releaseId, checksum, mcpBindingsChecksum }) => ({ marketInstallId, releaseId, checksum,
    ...(mcpBindingsChecksum ? { mcpBindingsChecksum } : {}) })))).digest('hex');
  for (const [path, source] of [[hostPath, 'pi-sdk-session.mjs'], [verifierPath, 'pi-sdk-package-files.mjs'], [approvalHelperPath, 'a2a-native-approval.mjs']]) {
    await writeSandboxFile(container, path, await readFile(`${process.cwd()}/scripts/${source}`, 'utf8'), options.signal);
  }
  await writeSandboxFile(container, factoryPath, piMcpExtensionSource({ eventFd: 3 }), options.signal);
  if (options.nativeApprovalUrl) {
    httpUrl(options.nativeApprovalUrl, 'native approval URL');
    await writeSandboxFile(container, approvalExtensionPath, nativeApprovalAdapter('pi', approvalHelperPath), options.signal);
  }
  await runTrackedDockerExec({ container, workdir, executable: 'node', args: [verifierPath, 'materialize'], stdin: JSON.stringify(packages), signal: options.signal, timeoutMs: 120_000 });
  const resources = { extensions: [] as string[], skills: [skillRoot], prompts: [] as string[], themes: [] as string[] };
  for (const item of packages) for (const kind of ['extensions', 'skills', 'prompts', 'themes'] as const) resources[kind].push(...item.manifest.package.resources[kind].map((path) => `${item.root}/${path}`));
  const models = JSON.parse(buildPiModelsConfig(options)).providers.toolplane;
  const excludeTools = normalizeDisabledBuiltinTools('pi-sdk', options.disabledBuiltinTools);
  await writeSandboxFile(container, configPath, JSON.stringify({ sdkVersion: '0.87.1', packageRoot: PI_SDK_RUNTIME.directory,
    cwd: workdir, agentDir: stateRoot, sessionsDir: `${stateRoot}/sessions/${runtimeSessionId}`, statePath: `${stateRoot}/sessions/${runtimeSessionId}.json`, packageSetChecksum,
    historyRequired: Boolean(options.piHarness?.historyRequired || options.piHarness?.sessionRequired || options.messages.some((message) => message.role === 'assistant')),
    model: { ...models.models[0], provider: 'toolplane', api: models.api, baseUrl: models.baseUrl, contextWindow: options.contextWindow },
    systemPrompt: options.systemPrompt?.trim() ?? '', excludeTools,
    defaultTools: agentRuntimeBuiltinToolGroups('pi-sdk').flatMap((group) => group.tools).filter((name) => !excludeTools.includes(name)), resources,
    packages: packages.map(({ manifest: _manifest, ...item }) => item), packageVerifierPath: verifierPath, mcpFactoryPath: factoryPath,
    ...(options.nativeApprovalUrl ? { approvalHelperPath, approvalExtensionPath } : {}), hostOnlyCommands: HOST_ONLY_COMMAND_NAMES,
  }), options.signal);
  let buffer = '', text = '', streamed = '', error = '', terminal = false;
  const consume = async (line: string) => {
    const event = JSON.parse(line);
    if (event.type === 'toolplane_sdk_response') {
      terminal = true;
      if (!event.success) { error = String(event.error?.code ?? 'PI_SDK_FAILED'); return; }
      text = redact(String(event.result?.text ?? ''), [options.runtimeAccessToken]);
      const commands = RuntimeCommandsSchema.safeParse(event.result?.commands);
      if (commands.success) await options.onCommands?.(commands.data);
      const usage = parseRuntimeUsage(event.result?.usage);
      if (usage) await options.onUsage?.(usage);
      const result = event.result?.commandResult;
      if (result && typeof result.command === 'string' && typeof result.text === 'string' && (result.status === 'completed' || result.status === 'failed')) {
        await options.onCommandResult?.({ command: result.command, text: redact(result.text, [options.runtimeAccessToken]), status: result.status });
        if (result.status === 'failed') error = 'PI_SDK_COMMAND_FAILED';
      }
      return;
    }
    const parsed = parsePiStreamLine(line);
    if (parsed?.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed?.activities) await reportActivities(options, parsed.activities, mcpServers);
    if (parsed?.contextTokens !== undefined) await reportContextUsage(options, parsed.contextTokens, false);
    if (parsed?.isError) error = 'PI_SDK_FAILED';
  };
  await runNativeSessionExec(options, { container, workdir, executable: 'node', args: [hostPath, configPath],
    signal: options.signal, timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS, secrets: [options.runtimeAccessToken],
    env: { PI_OFFLINE: '1', PI_TELEMETRY: '0', NO_COLOR: '1' },
    onStdout: async (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line) await consume(line);
      }
    },
  }, { configPath, packageSetChecksum, mcpConfig: JSON.parse(buildPiMcpConfig(mcpServers)) });
  if (buffer.trim()) await consume(buffer.trim());
  if (!terminal) throw new Error('PI_SDK_PROTOCOL_ERROR');
  if (error) throw new Error(error);
  if (text.startsWith(streamed) && text.length > streamed.length) await options.onTextDelta?.(text.slice(streamed.length));
  return text;
}

async function installNativeApproval(options: RunSandboxAgentTurnOptions, container: string, runtime: 'pi' | 'claude-code' | 'dsh', runId: string) {
  if (!options.nativeApprovalUrl) return null;
  httpUrl(options.nativeApprovalUrl, 'native approval URL');
  const helper = `${RUNTIME_TEMP_ROOT}/${runId}-approval.mjs`;
  const adapter = `${RUNTIME_TEMP_ROOT}/${runId}-approval-${runtime}.mjs`;
  await writeSandboxFile(container, helper, await readFile(`${process.cwd()}/scripts/a2a-native-approval.mjs`, 'utf8'), options.signal);
  const source = runtime === 'claude-code' ? claudeApprovalSettings(helper) : nativeApprovalAdapter(runtime, helper);
  if (runtime !== 'claude-code') await writeSandboxFile(container, adapter, source, options.signal);
  if (runtime === 'claude-code') await runTrackedDockerExec({ container, workdir: '/workspace', executable: 'chown',
    args: [CLAUDE_RUNTIME_USER, helper], signal: options.signal, timeoutMs: 10_000 });
  return { helper, adapter, source };
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
  disabledBuiltinTools: readonly string[],
): Promise<string> {
  const stateRoot = sandboxRuntimeStateRoot('pi', options.agentId);
  const runId = options.runtimeSessionId ?? randomUUID();
  const modelsPath = `${stateRoot}/models.json`;
  const extensionPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-mcp.js`;
  const mcpConfigPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-mcp.json`;
  const systemPromptPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-system.txt`;
  const tempPaths: string[] = [];
  const approval = await installNativeApproval(options, container, 'pi', runId);
  if (approval) tempPaths.push(approval.helper, approval.adapter);
  await writeSandboxFile(container, modelsPath, buildPiModelsConfig({
    provider: options.provider,
    modelId: options.modelId,
    modelProxyBase: options.modelProxyBase,
  }), options.signal);

  const args = [
    '--mode', options.runtimeSessionId ? 'rpc' : 'json', ...(options.runtimeSessionId ? [] : ['--no-session']), '--no-approve', '--offline',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--skill', skillRoot,
    '--provider', 'toolplane', '--model', options.modelId,
    ...(approval ? ['--extension', approval.adapter] : []),
    ...(disabledBuiltinTools.length ? ['--exclude-tools', disabledBuiltinTools.join(',')] : []),
  ];
  let lineBuffer = '';
  let streamed = '';
  let assistantFallback = '';
  let runtimeError = '';
  let exactUsage = false;
  const consumeLine = async (line: string) => {
    const command = nativeCommandResult(line);
    if (command?.isError) runtimeError = redact(command.text, [options.runtimeAccessToken]);
    else if (command) assistantFallback = redact(command.text, [options.runtimeAccessToken]);
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
    await runNativeSessionExec(options, {
      container,
      workdir,
      executable: binary,
      args,
      stdin: prompt,
      env: {
        TOOLPLANE_RUNTIME_TOKEN: options.runtimeAccessToken,
        ...(options.nativeApprovalUrl ? { TOOLPLANE_APPROVAL_URL: options.nativeApprovalUrl } : {}),
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
    if (!exactUsage && !options.command) await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    if (!options.runtimeSessionId) await removeSandboxFiles(container, tempPaths);
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
  disabledBuiltinTools: readonly string[],
): Promise<string> {
  const modelProxyBase = httpUrl(options.modelProxyBase, 'model proxy URL');
  const stateRoot = sandboxRuntimeStateRoot('claude-code', options.agentId);
  const tempPath = `${RUNTIME_TEMP_ROOT}/${options.runtimeSessionId ?? randomUUID()}-claude-mcp.json`;
  const approval = await installNativeApproval(options, container, 'claude-code', options.runtimeSessionId ?? randomUUID());
  const args = buildClaudeRuntimeArgs({
    ...(approval ? { approvalSettings: approval.source } : {}),
    modelId: options.modelId,
    runtimeSessionId: options.runtimeSessionId,
    systemPrompt,
    disabledBuiltinTools,
    ...(options.skills?.length ? { skillPluginRoot: sandboxRuntimeSkillRoot('claude-code', options.agentId) } : {}),
  });
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
    const command = nativeCommandResult(line);
    if (command?.isError) runtimeError = redact(command.text, [options.runtimeAccessToken]);
    else if (command) finalResult = redact(command.text, [options.runtimeAccessToken]);
    const metadata = parseClaudeRuntimeMetadata(line);
    if (metadata.commands) await options.onCommands?.(metadata.commands);
    if (metadata.usage) await options.onUsage?.(metadata.usage);
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
    await runNativeSessionExec(options, {
      container,
      workdir,
      executable: binary,
      user: CLAUDE_RUNTIME_USER,
      args,
      stdin: options.command ?? prompt,
      env: {
        ANTHROPIC_API_KEY: options.runtimeAccessToken,
        ...(options.nativeApprovalUrl ? { TOOLPLANE_APPROVAL_URL: options.nativeApprovalUrl, TOOLPLANE_RUNTIME_TOKEN: options.runtimeAccessToken } : {}),
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
    const text = streamed || finalResult || assistantFallback || (options.command ? 'Command completed.' : '');
    if (!text) throw new Error('Claude Code returned no assistant text.');
    if (!streamed && options.onTextDelta) await options.onTextDelta(text);
    if (!exactUsage && !options.command) await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    if (!options.runtimeSessionId) await removeSandboxFiles(container, [...(mcpServers.length ? [tempPath] : []), ...(approval ? [approval.helper] : [])]);
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
  disabledBuiltinTools: readonly string[],
): Promise<string> {
  const modelProxyBase = httpUrl(options.modelProxyBase, 'model proxy URL');
  const stateRoot = sandboxRuntimeStateRoot('dsh', options.agentId);
  const runId = randomUUID();
  const patchPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh.patch.yml`;
  const promptPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh.prompt.txt`;
  const eventPluginPath = `${RUNTIME_TEMP_ROOT}/${runId}-dsh-events.mjs`;
  const driverPluginPath = options.runtimeSessionId ? `${RUNTIME_TEMP_ROOT}/${runId}-dsh-driver.mjs` : undefined;
  const eventPrefix = `__TOOLPLANE_DSH_EVENT_${runId}__`;
  const approval = await installNativeApproval(options, container, 'dsh', runId);
  const patch = buildDshPatch({
    ...(approval ? { approvalPluginPath: approval.adapter } : {}),
    provider: options.provider,
    modelId: options.modelId,
    modelProxyBase,
    systemPrompt,
    skillRoot,
    mcpServers,
    disabledBuiltinTools,
    eventPluginPath,
    driverPluginPath,
  });
  await writeSandboxFile(container, eventPluginPath, dshEventTapSource(eventPrefix), options.signal);
  if (driverPluginPath) await writeSandboxFile(container, driverPluginPath, await readFile(`${process.cwd()}/scripts/dsh-runtime-driver.mjs`, 'utf8'), options.signal);
  await writeSandboxFile(container, patchPath, patch, options.signal);
  await writeSandboxFile(container, promptPath, driverPluginPath ? JSON.stringify({
    packageRoot: SANDBOX_RUNTIME_PACKAGES.dsh.directory, prefix: eventPrefix,
    sessionId: `toolplane-${safeSegment(options.runtimeSessionId!, 'session')}`,
    history: options.command ? prompt : buildSandboxTranscript(options.messages.slice(0, -1)),
    message: buildSandboxTranscript(options.messages.slice(-1)), command: options.command,
  }) : prompt, options.signal);
  const promptWrapper = 'set -eu; prompt_file=$1; shift; prompt=$(cat "$prompt_file"); exec "$@" "$prompt"';
  let lineBuffer = '';
  let streamed = '';
  let commandResult = '';
  let commandError = '';
  const consumeLine = async (line: string) => {
    try {
      const event = JSON.parse(line.slice(eventPrefix.length));
      if (event.type === 'commands') {
        const commands = RuntimeCommandsSchema.safeParse(event.commands);
        if (commands.success) await options.onCommands?.(commands.data);
      }
      if (event.type === 'command' && typeof event.text === 'string') {
        commandResult = redact(event.text, [options.runtimeAccessToken]);
        if (event.isError) commandError = commandResult;
      }
    } catch { /* Non-metadata event lines use the existing stream parser. */ }
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
        ...(options.nativeApprovalUrl ? { TOOLPLANE_APPROVAL_URL: options.nativeApprovalUrl } : {}),
        TOOLPLANE_MCP_AUTH: `Bearer ${options.runtimeAccessToken}`,
        DSH_HOME: stateRoot,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: 'native',
        ...(driverPluginPath ? { TOOLPLANE_DSH_INPUT: promptPath } : {}),
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
    if (commandError) throw new Error(commandError);
    const fallback = output.split(/\r?\n/).filter((line) => !line.startsWith(eventPrefix)).join('\n').trim();
    const text = [streamed || (commandResult ? '' : redact(fallback, [options.runtimeAccessToken])), commandResult].filter(Boolean).join('\n\n');
    if (!text) throw new Error('DeepSeek Harness returned no assistant text.');
    if (!streamed) await options.onTextDelta?.(text);
    else if (commandResult) await options.onTextDelta?.(`\n\n${commandResult}`);
    await reportContextUsage(options, estimateContextTokens([systemPrompt, prompt, text]), true);
    return text;
  } finally {
    await removeSandboxFiles(container, [patchPath, promptPath, eventPluginPath, ...(driverPluginPath ? [driverPluginPath] : []), ...(approval ? [approval.helper, approval.adapter] : [])]);
  }
}

export async function runSandboxAgentTurn(options: RunSandboxAgentTurnOptions): Promise<string> {
  return withSandboxExecutionLease(options.sandboxId, () => runExclusiveSandboxAgentTurn(options));
}

async function runExclusiveSandboxAgentTurn(options: RunSandboxAgentTurnOptions): Promise<string> {
  if (!options.runtimeAccessToken || options.runtimeAccessToken.length > 8_192 || /[\0\r\n]/.test(options.runtimeAccessToken)) {
    throw new Error('Invalid sandbox runtime access token.');
  }
  if (!options.modelId.trim() || options.modelId.length > 500 || options.modelId.includes('\0')) {
    throw new Error('Invalid sandbox runtime model.');
  }
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error('Invalid sandbox runtime context window.');
  }
  if (options.runtimeSessionId && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.runtimeSessionId)) throw new Error('Invalid runtime session.');
  const sandboxDeploymentId = await assertAssignedDockerSandbox(options);
  const container = sandboxContainerName(options.sandboxId);
  const workdir = normalizeSandboxWorkingDirectory(options.workingDirectory);
  const prompt = buildSandboxTranscript(options.messages);
  if (!prompt && !options.command) throw new Error('The sandbox runtime turn has no user-visible message.');
  const systemPrompt = options.systemPrompt?.trim() ?? '';
  const disabledBuiltinTools = normalizeDisabledBuiltinTools(
    options.runtimeKind,
    options.disabledBuiltinTools,
  );
  const mcpServers = (options.mcpServers ?? []).filter((server) => server.deploymentId !== sandboxDeploymentId);
  const skillRoot = sandboxRuntimeSkillRoot(options.runtimeKind, options.agentId);
  if (options.runtimeKind === 'hermes-rpc') {
    return runHermesRpcTurn(options, {
      container, workdir, skillRoot, stateRoot: sandboxRuntimeStateRoot('hermes-rpc', options.agentId), mcpServers,
      history: (options.command ? options.messages : options.messages.slice(0, -1))
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: buildSandboxTranscript([message]) })),
      message: buildSandboxTranscript(options.messages.slice(-1)),
    }, {
      exec: runTrackedDockerExec, write: writeSandboxFile, remove: removeSandboxFiles,
      prepareSkills: () => materializeSandboxSkills(container, 'hermes-rpc', skillRoot, options.skills ?? [], options.signal),
      activities: (activities) => reportActivities(options, activities, mcpServers),
    });
  }
  if (options.runtimeKind === 'pi-sdk') {
    await ensureRuntimeInstalled('pi-sdk', container, options.signal);
    await materializeSandboxSkills(container, 'pi-sdk', skillRoot, options.skills ?? [], options.signal);
    return runPiSdk(options, container, workdir, skillRoot, mcpServers);
  }
  const piVersion = options.runtimeKind === 'pi' ? await readPiVersion(container, options.agentId, options.signal) : DEFAULT_PI_VERSION;
  const binary = await ensureRuntimeInstalled(options.runtimeKind, container, options.signal, piVersion);
  await materializeSandboxSkills(container, options.runtimeKind, skillRoot, options.skills ?? [], options.signal);
  if (options.runtimeKind === 'pi') {
    return runPi(options, container, binary, workdir, systemPrompt, prompt, skillRoot, mcpServers, disabledBuiltinTools);
  }
  if (options.runtimeKind === 'claude-code') {
    return runClaudeCode(options, container, binary, workdir, systemPrompt, prompt, mcpServers, disabledBuiltinTools);
  }
  return runDsh(options, container, binary, workdir, systemPrompt, prompt, skillRoot, mcpServers, disabledBuiltinTools);
}

export type PiHarnessOperationResult = {
  status: 'completed' | 'declined' | 'aborted' | 'failed';
  text: string;
  operationId?: string;
};

type PiHarnessBinding = { taskId: string; contextId: string; operationId: string };

export async function preparePiHarnessOperation(options: RunSandboxAgentTurnOptions, contextId: string): Promise<string> {
  const result = await executePiHarnessOperation(options, 'prepare', { contextId });
  if (typeof result !== 'string') throw new Error('PI_PROTOCOL_ERROR: prepare did not return an operation ID.');
  return result;
}

export async function runPiHarnessOperation(options: RunSandboxAgentTurnOptions, binding: PiHarnessBinding): Promise<PiHarnessOperationResult> {
  const result = await executePiHarnessOperation(options, 'run', binding);
  if (typeof result === 'string') throw new Error('PI_PROTOCOL_ERROR: run did not return a terminal result.');
  return result;
}

export async function cancelPiHarnessOperation(options: RunSandboxAgentTurnOptions, binding: PiHarnessBinding): Promise<PiHarnessOperationResult> {
  // The caller awaits the stopped driver before handing off the same sandbox lease.
  const result = await executePiHarnessOperation({ ...options, signal: undefined }, 'cancel', binding);
  if (typeof result === 'string') throw new Error('PI_PROTOCOL_ERROR: cancel did not return a terminal result.');
  return result;
}

export async function compactPiHarnessSession(options: RunSandboxAgentTurnOptions, contextId: string, customInstructions: string): Promise<PiHarnessOperationResult> {
  const result = await executePiHarnessOperation({ ...options, piHarness: { ...options.piHarness, sessionRequired: true } }, 'compact', { contextId, customInstructions });
  if (typeof result === 'string') throw new Error('PI_PROTOCOL_ERROR: compact did not return a terminal result.');
  return result;
}

async function executePiHarnessOperation(
  options: RunSandboxAgentTurnOptions,
  action: 'prepare' | 'run' | 'cancel' | 'compact',
  binding: { contextId: string; operationId?: string; taskId?: string; customInstructions?: string },
): Promise<string | PiHarnessOperationResult> {
  const ownerSignal = runtimeAbortSignal();
  try {
    return await withSandboxExecutionLease(options.sandboxId, async () => {
      assertRuntimeOwner();
      if (options.runtimeKind !== 'pi') throw new Error('Pi Harness requires a Pi Agent.');
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(binding.contextId)) throw new Error('Invalid Pi context ID.');
      if (action !== 'prepare' && action !== 'compact' && (!binding.taskId || !binding.operationId || !/^[a-zA-Z0-9_-]{1,200}$/.test(binding.operationId))) {
        throw new Error('Invalid Pi task operation binding.');
      }
      if (!options.runtimeAccessToken || options.runtimeAccessToken.length > 8_192 || /[\0\r\n]/.test(options.runtimeAccessToken)) {
        throw new Error('Invalid sandbox runtime access token.');
      }
      if (!options.modelId.trim() || options.modelId.length > 500 || options.modelId.includes('\0')) throw new Error('Invalid sandbox runtime model.');
      if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) throw new Error('Invalid sandbox runtime context window.');
      if (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1)) throw new Error('Invalid Pi maxSteps.');
      if (options.nativeApprovalUrl) httpUrl(options.nativeApprovalUrl, 'native approval URL');
      const sandboxDeploymentId = await assertAssignedDockerSandbox(options);
      const container = sandboxContainerName(options.sandboxId);
      if (uncertainPiSandboxes.has(container)) throw new Error('PI_PROCESS_STOP_UNCONFIRMED: runtime owner recovery is required.');
      const workdir = normalizeSandboxWorkingDirectory(options.workingDirectory);
      const stateRoot = sandboxRuntimeStateRoot('pi', options.agentId);
      const skillRoot = sandboxRuntimeSkillRoot('pi', options.agentId);
      const mcpServers = (options.mcpServers ?? []).filter((server) => server.deploymentId !== sandboxDeploymentId);
      for (const server of mcpServers) httpUrl(server.url, 'MCP server URL');
      // Read the required host before touching persistent native Session storage.
      const host = await readFile(`${process.cwd()}/scripts/pi-harness-session.mjs`, 'utf8');
      const approval = await readFile(`${process.cwd()}/scripts/a2a-native-approval.mjs`, 'utf8');
      await ensureRuntimeInstalled('pi-harness', container, options.signal);
      const packageRoot = PI_HARNESS_RUNTIME.directory;
      const hostPath = `${packageRoot}/pi-harness-session.mjs`;
      await writeSandboxFile(container, hostPath, host, options.signal);
      await writeSandboxFile(container, `${packageRoot}/a2a-native-approval.mjs`, approval, options.signal);
      await materializeSandboxSkills(container, 'pi', skillRoot, options.skills ?? [], options.signal);
      const runId = randomUUID();
      const inputPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-harness.json`;
      const modelsPath = `${RUNTIME_TEMP_ROOT}/${runId}-pi-models.json`;
      const modelConfig = JSON.parse(buildPiModelsConfig(options));
      modelConfig.providers.toolplane.models[0].contextWindow = options.contextWindow;
      const skills = buildSandboxSkillBundles(options.skills ?? []).map((bundle, index) => ({
        name: bundle.directory,
        description: options.skills?.[index].description ?? options.skills?.[index].skill?.description ?? '',
        filePath: `${skillRoot}/${bundle.directory}/SKILL.md`,
        baseDir: `${skillRoot}/${bundle.directory}`,
        source: 'toolplane',
      }));
      let prepared: string | undefined;
      let result: PiHarnessOperationResult | undefined;
      let hostError: Error | undefined;
      let lineBuffer = '';
      const consumeLine = async (line: string) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(redact(line, [JSON.stringify(options.runtimeAccessToken).slice(1, -1)])); }
        catch { throw new Error('PI_PROTOCOL_ERROR: invalid host JSON.'); }
        if (!event || typeof event !== 'object') throw new Error('PI_PROTOCOL_ERROR: invalid host event.');
        switch (event.type) {
          case 'prepared':
            if (action !== 'prepare' || prepared || typeof event.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(event.operationId)) {
              throw new Error('PI_PROTOCOL_ERROR: invalid prepared operation.');
            }
            prepared = event.operationId;
            break;
          case 'result':
            if (action === 'prepare' || result || !['completed', 'declined', 'aborted', 'failed'].includes(event.status) || typeof event.text !== 'string') {
              throw new Error('PI_PROTOCOL_ERROR: invalid terminal result.');
            }
            result = { status: event.status, text: event.text, ...(typeof event.operationId === 'string' ? { operationId: event.operationId } : {}) };
            break;
          case 'error':
            if (typeof event.code !== 'string' || typeof event.message !== 'string') throw new Error('PI_PROTOCOL_ERROR: invalid host error.');
            hostError = Object.assign(new Error(`${event.code}: ${event.message}`), { code: event.code });
            break;
          case 'text_delta':
            if (typeof event.delta !== 'string') throw new Error('PI_PROTOCOL_ERROR: invalid text delta.');
            await options.onTextDelta?.(event.delta);
            break;
          case 'activity':
            if (!event.activity || !['reasoning', 'tool'].includes(event.activity.type) || !['running', 'completed', 'failed'].includes(event.activity.status)) {
              throw new Error('PI_PROTOCOL_ERROR: invalid activity.');
            }
            await reportActivities(options, [event.activity], mcpServers);
            break;
          case 'usage': {
            const usage = parseRuntimeUsage(event.usage);
            if (!usage) throw new Error('PI_PROTOCOL_ERROR: invalid usage.');
            await options.onUsage?.(usage);
            break;
          }
          case 'context_usage': {
            const usage = parseContextUsage(event.usage);
            if (!usage) throw new Error('PI_PROTOCOL_ERROR: invalid context usage.');
            await options.onContextUsage?.(usage);
            break;
          }
          default: throw new Error('PI_PROTOCOL_ERROR: unknown host event.');
        }
      };
      try {
        await writeSandboxFile(container, modelsPath, JSON.stringify(modelConfig), options.signal);
        await writeSandboxFile(container, inputPath, JSON.stringify({
          action, packageRoot, directory: `${stateRoot}/harness`, ...binding, modelsPath,
          providerId: 'toolplane', modelId: options.modelId, systemPrompt: options.systemPrompt?.trim() ?? '',
          messages: options.messages, skills, disabledBuiltinTools: normalizeDisabledBuiltinTools('pi', options.disabledBuiltinTools),
          maxSteps: options.maxSteps, workingDirectory: workdir, legacyStatePath: `${stateRoot}/sessions/${binding.contextId}.json`,
          historyRequired: options.piHarness?.historyRequired === true, communicationEnabled: options.piHarness?.communicationEnabled === true,
          sessionRequired: options.piHarness?.sessionRequired === true,
          thinkingLevel: options.piHarness?.thinkingLevel, mcpServers, nativeApprovalUrl: options.nativeApprovalUrl,
          runtimeAccessToken: options.runtimeAccessToken,
        }), options.signal);
        let execError: unknown;
        try {
          await runTrackedDockerExec({
            container, workdir, executable: 'node', args: [hostPath, inputPath], piHarness: true,
            signal: options.signal, timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS, secrets: [options.runtimeAccessToken],
            env: { TOOLPLANE_RUNTIME_TOKEN: options.runtimeAccessToken, PI_OFFLINE: '1', PI_TELEMETRY: '0', NO_COLOR: '1',
              ...(options.nativeApprovalUrl ? { TOOLPLANE_APPROVAL_URL: options.nativeApprovalUrl } : {}) },
            onStdout: async (chunk) => {
              lineBuffer += chunk;
              for (;;) {
                const newline = lineBuffer.indexOf('\n');
                if (newline < 0) break;
                const line = lineBuffer.slice(0, newline);
                lineBuffer = lineBuffer.slice(newline + 1);
                await consumeLine(line);
              }
            },
          });
        } catch (error) { execError = error; }
        if (lineBuffer.trim()) await consumeLine(lineBuffer);
        if (hostError) throw hostError;
        if (execError) throw execError;
        if (action === 'prepare' && prepared) return prepared;
        if (action !== 'prepare' && result) return result;
        throw new Error('PI_PROTOCOL_ERROR: host exited without an operation result.');
      } finally {
        await removeSandboxFiles(container, [inputPath, modelsPath]);
      }
    });
  } catch (error) {
    if (ownerSignal?.aborted && !(error instanceof PiRuntimeInterruptedError) && !(error instanceof Error && 'code' in error)) {
      throw new PiRuntimeInterruptedError('Pi runtime owner stopped.', { cause: error });
    }
    throw error;
  }
}
