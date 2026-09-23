import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RunSandboxAgentTurnOptions, SandboxRuntimeActivity, SandboxRuntimeMcpServer } from './sandbox-runtime';
import type { RuntimeUsage } from './runtime-commands';

export const HERMES_RPC_REVISION = '3c27eb6234bf91b8ceee9e9071591b31e9b148cb';
export const HERMES_RPC_PACKAGE_ROOT = `/workspace/.toolplane/runtime-packages/hermes-rpc-${HERMES_RPC_REVISION}`;
const TURN_TIMEOUT = 25 * 60_000;
const active = new Set<string>();

export type HermesRpcIO = {
  exec: (options: { container: string; workdir: string; executable: string; args?: string[]; env?: Record<string, string>; stdin?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; maxStdoutBytes?: number; onStdout?: (chunk: string) => void | Promise<void>; secrets?: readonly string[] }) => Promise<string>;
  write: (container: string, path: string, content: string | Buffer, signal?: AbortSignal) => Promise<void>;
  remove: (container: string, paths: string[]) => Promise<void>;
  prepareSkills: () => Promise<void>;
  activities: (activities: SandboxRuntimeActivity[]) => Promise<void>;
};

export function hermesRpcAlias(deploymentId: string) {
  return `tp_${createHash('sha256').update(deploymentId).digest('hex').slice(0, 24)}`;
}

export function buildHermesRpcConfig(input: {
  provider: { format: string }; modelId: string; modelProxyBase: string; token: string;
  skillRoot: string; systemPrompt?: string | null; maxSteps?: number;
  mcpServers: readonly SandboxRuntimeMcpServer[]; disabledBuiltinTools?: readonly string[];
}) {
  const transport = ({ openai: 'chat_completions', 'openai-responses': 'codex_responses', anthropic: 'anthropic_messages' } as Record<string, string>)[input.provider.format];
  if (!transport) throw new Error('Unsupported Hermes RPC provider format.');
  const base = new URL(input.modelProxyBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid Hermes RPC model proxy URL.');
  // The platform proxy joins /v1 safely against the configured upstream base.
  const modelBase = base.toString().replace(/\/$/, '') + '/v1';
  const mcpServers = Object.fromEntries(input.mcpServers.map((server) => {
    const url = new URL(server.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid Hermes RPC MCP URL.');
    return [hermesRpcAlias(server.deploymentId), { url: url.toString(), enabled: true, headers: { Authorization: `Bearer ${input.token}` } }];
  }));
  const disabled = new Set(input.disabledBuiltinTools ?? []);
  // Tool selection is toolset-grained, not a claim of per-tool sandbox isolation.
  // Skills is always present so the explicit nonempty toolset inventory never
  // falls back to Hermes' auto-discovered default/all toolsets.
  const groups: Array<[string, string[]]> = [
    ['file', ['read_file', 'write_file', 'patch', 'search_files']],
    ['terminal', ['terminal', 'process']], ['memory', ['memory']], ['session_search', ['session_search']],
  ];
  const toolsets = ['skills', ...groups.filter(([, names]) => !names.some((name) => disabled.has(name))).map(([name]) => name), ...Object.keys(mcpServers)];
  return { modelBase, toolsets, config: {
    model: { provider: 'custom:toolplane-rpc', default: input.modelId },
    providers: { 'toolplane-rpc': { name: 'ToolPlane runtime proxy', api: modelBase,
      api_key: input.token, transport, models: { [input.modelId]: {} }, default_model: input.modelId, discover_models: false } },
    agent: { max_turns: Number.isFinite(input.maxSteps) ? Math.min(1000, Math.max(1, Math.trunc(input.maxSteps!))) : 100, system_prompt: input.systemPrompt?.trim() ?? '' },
    skills: { external_dirs: [input.skillRoot] }, plugins: { enabled: [] },
    approvals: { mode: 'smart' }, mcp_servers: mcpServers,
    // No gateway/cron/dashboard process is started by the protocol adapter.
  } };
}

export async function runHermesRpcTurn(options: RunSandboxAgentTurnOptions, context: {
  container: string; workdir: string; stateRoot: string; skillRoot: string;
  mcpServers: readonly SandboxRuntimeMcpServer[];
  history: Array<{ role: string; content: string }>; message: string;
}, io: HermesRpcIO): Promise<string> {
  const key = `${context.container}:${options.agentId}`;
  if (active.has(key)) throw new Error('This Hermes RPC Agent is busy. Retry after its current operation finishes.');
  active.add(key);
  const id = randomUUID();
  const temporary = `/workspace/.toolplane/runtime-tmp/${id}-hermes-rpc`;
  const paths = [`${temporary}.json`, `${temporary}.mjs`, `${temporary}.py`, `${temporary}-install.mjs`, `${temporary}-approval.py`];
  try {
    options.signal?.throwIfAborted();
    await io.write(context.container, paths[3]!, await readFile(`${process.cwd()}/scripts/install-hermes-rpc.mjs`, 'utf8'), options.signal);
    await io.exec({ container: context.container, workdir: context.workdir, executable: 'sh', args: ['-c',
      'set -eu; mkdir -p "$1"; exec flock -n "$1/.install.lock" node "$2" "$1"', 'toolplane-hermes-install', HERMES_RPC_PACKAGE_ROOT, paths[3]!],
      signal: options.signal, timeoutMs: 15 * 60_000 });
    await io.prepareSkills();
    const { config, modelBase, toolsets } = buildHermesRpcConfig({ ...options, token: options.runtimeAccessToken, skillRoot: context.skillRoot, mcpServers: context.mcpServers });
    const timeoutMs = Math.min(options.timeoutMs ?? TURN_TIMEOUT, TURN_TIMEOUT);
    const input = {
      home: `${context.stateRoot}/home`, cwd: context.workdir, source: `${HERMES_RPC_PACKAGE_ROOT}/source`,
      python: `${HERMES_RPC_PACKAGE_ROOT}/source/.venv/bin/python`, bootstrap: paths[2],
      config, modelBase, toolsets, token: options.runtimeAccessToken,
      ...(options.nativeApprovalUrl ? { approvalUrl: options.nativeApprovalUrl, approvalScript: paths[4] } : {}),
      sessionId: options.runtimeSessionId ?? `ephemeral-${id}`, provider: 'custom:toolplane-rpc', model: options.modelId,
      binding: createHash('sha256').update(JSON.stringify({ sandboxId: options.sandboxId, agentId: options.agentId, providerId: options.provider.id, model: options.modelId, format: options.provider.format, cwd: context.workdir })).digest('hex'),
      history: context.history, message: context.message, command: options.command, timeoutMs,
    };
    await io.write(context.container, paths[0]!, JSON.stringify(input), options.signal);
    await io.write(context.container, paths[1]!, await readFile(`${process.cwd()}/scripts/hermes-rpc-session.mjs`, 'utf8'), options.signal);
    await io.write(context.container, paths[2]!, await readFile(`${process.cwd()}/scripts/hermes-rpc-bootstrap.py`, 'utf8'), options.signal);
    if (options.nativeApprovalUrl) await io.write(context.container, paths[4]!, await readFile(`${process.cwd()}/scripts/a2a-hermes-approval.py`, 'utf8'), options.signal);
    let buffer = '', result: string | undefined, failure: string | undefined;
    const consume = async (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'delta' && typeof event.text === 'string') await options.onTextDelta?.(event.text);
      if (event.type === 'activity' && event.activity?.type === 'tool') {
        const activity = event.activity as SandboxRuntimeActivity;
        const delegated = activity.toolName === 'tool_call' && activity.input && typeof activity.input === 'object'
          ? (activity.input as { name?: unknown }).name : undefined;
        const name = typeof delegated === 'string' ? delegated : activity.toolName;
        for (const server of context.mcpServers) {
          const prefix = `mcp__${hermesRpcAlias(server.deploymentId)}__`;
          if (name?.startsWith(prefix)) { activity.deploymentId = server.deploymentId; activity.originalToolName = name.slice(prefix.length); }
        }
        await io.activities([activity]);
      }
      if (event.type === 'commands') await options.onCommands?.([{ name: 'compact', description: 'Compress the native Hermes session.' }]);
      if (event.type === 'error') failure = String(event.message || 'Hermes RPC failed.');
      if (event.type === 'result' && typeof event.text === 'string') {
        result = event.text;
        const usage = event.usage;
        if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
          const value: RuntimeUsage = { inputTokens: Math.max(0, usage.input), outputTokens: Math.max(0, usage.output), cacheReadTokens: 0, cacheWriteTokens: 0 };
          await options.onUsage?.(value);
        }
        if (usage && Number.isFinite(usage.context_used) && usage.context_used > 0) await options.onContextUsage?.({ usedTokens: usage.context_used,
          maxTokens: options.contextWindow, modelName: options.modelId, estimated: options.contextWindowEstimated === true });
      }
    };
    try {
      await io.exec({ container: context.container, workdir: context.workdir, executable: 'node', args: [paths[1]!, paths[0]!], signal: options.signal,
        timeoutMs: timeoutMs + 300_000, secrets: [options.runtimeAccessToken], onStdout: async (chunk) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); await consume(line); }
          if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new Error('Hermes RPC frame limit exceeded.');
        },
      });
    } catch (error) { if (failure) throw new Error(failure); throw error; }
    if (buffer.trim()) await consume(buffer);
    if (failure) throw new Error(failure);
    if (result === undefined) throw new Error('Hermes RPC exited without a successful result.');
    return result;
  } finally {
    try { await io.remove(context.container, paths); } finally { active.delete(key); }
  }
}
