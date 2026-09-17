// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildHermesRpcConfig, hermesRpcAlias, runHermesRpcTurn, HERMES_RPC_REVISION, type HermesRpcIO } from '@/lib/agents/hermes-rpc';
import { agentRuntimeCapabilities, isDedicatedSandboxRuntimeKind, AGENT_CONTROL_RUNTIME_KINDS } from '@/lib/agents/runtime-kind';
import { runtimeCommands } from '@/lib/agents/runtime-commands';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunSandboxAgentTurnOptions } from '@/lib/agents/sandbox-runtime';

const base = { provider: { id: 'provider-1', format: 'openai', name: 'test' }, modelId: 'fixture-model', modelProxyBase: 'https://plane.test/api/v1/agent-runtime/model/provider-1',
  token: 'synthetic-scoped-grant', skillRoot: '/workspace/.toolplane/runtimes/hermes-rpc/agents/agent-1/skills',
  systemPrompt: 'Platform instructions', maxSteps: 17,
  mcpServers: [{ deploymentId: 'deployment-1', url: 'https://plane.test/api/v1/agent-runtime/mcp/deployment-1/rpc' }],
};

describe('Hermes RPC platform projection', () => {
  it('is independent from managed Hermes and does not widen Control MCP or public endpoints', () => {
    expect(isDedicatedSandboxRuntimeKind('hermes-rpc')).toBe(true);
    expect(agentRuntimeCapabilities('hermes-rpc')).toMatchObject({ providerBinding: 'single', attachments: false, publicEndpoint: false });
    expect(agentRuntimeCapabilities('hermes')).toMatchObject({ providerBinding: 'multiple', attachments: true, publicEndpoint: true });
    expect(AGENT_CONTROL_RUNTIME_KINDS).toEqual(['pi', 'hermes']);
    expect(runtimeCommands('hermes-rpc', [{ name: 'cli.exec' }, { name: 'model' }])).toEqual([{ name: 'compact' }]);
  });
  it.each([['openai', 'chat_completions'], ['openai-responses', 'codex_responses'], ['anthropic', 'anthropic_messages']])('projects %s through the scoped platform proxy', (format, transport) => {
    const value = buildHermesRpcConfig({ ...base, provider: { format } });
    expect(value.config.providers['toolplane-rpc']).toMatchObject({ api: base.modelProxyBase + '/v1', api_key: base.token, transport, discover_models: false });
    expect(value.config.agent).toEqual({ max_turns: 17, system_prompt: 'Platform instructions' });
    expect(value.config.skills.external_dirs).toEqual([base.skillRoot]);
    expect(value.config.plugins.enabled).toEqual([]);
    expect(value.config.mcp_servers[hermesRpcAlias('deployment-1')]).toMatchObject({ headers: { Authorization: `Bearer ${base.token}` } });
    expect(value.toolsets).toContain(hermesRpcAlias('deployment-1'));
    expect(JSON.stringify(value)).not.toContain('/opt/data');
  });
  it('restricts toolsets without an empty-selection fallback to all tools', () => {
    const value = buildHermesRpcConfig({ ...base, mcpServers: [], disabledBuiltinTools: ['read_file', 'terminal', 'memory', 'session_search'] });
    expect(value.toolsets).toEqual(['skills']);
    expect(value.config.approvals.mode).toBe('smart');
    expect(Object.keys(value.config.mcp_servers)).toHaveLength(0);
  });
  it('rejects unsupported providers and credential-bearing proxy URLs', () => {
    expect(() => buildHermesRpcConfig({ ...base, provider: { format: 'unsupported' } })).toThrow(/Unsupported/);
    expect(() => buildHermesRpcConfig({ ...base, modelProxyBase: 'https://secret:secret@host.test' })).toThrow(/Invalid/);
    expect(() => buildHermesRpcConfig({ ...base, mcpServers: [{ deploymentId: 'x', url: 'file:///etc/passwd' }] })).toThrow(/Invalid/);
  });
  it('keeps the installer and adapter pinned to the same immutable source', async () => {
    const installer = await readFile('scripts/install-hermes-rpc.mjs', 'utf8');
    expect(installer).toContain(`HERMES_RPC_COMMIT = '${HERMES_RPC_REVISION}'`);
    expect(installer).toContain("'--frozen'");
    expect(installer).toContain("'--managed-python'");
    expect(installer).not.toContain('UV_PYTHON_PREFERENCE');
    expect(installer).toContain('integrity check failed');
  });
  it('executes in the selected container, maps MCP activity and only returns a successful result', async () => {
    const options: RunSandboxAgentTurnOptions = { runtimeKind: 'hermes-rpc', workspaceId: 'workspace-1', agentId: 'agent-1', sandboxId: 'sandbox-1',
      ...base, runtimeAccessToken: base.token, contextWindow: 64000, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      onTextDelta: vi.fn(), onUsage: vi.fn() };
    const io: HermesRpcIO = { exec: vi.fn(async (call) => {
      if (call.executable === 'node') await call.onStdout?.(JSON.stringify({ type: 'activity', activity: { type: 'tool', status: 'completed', toolName: `mcp__${hermesRpcAlias('deployment-1')}__echo` } }) + '\n'
        + JSON.stringify({ type: 'delta', text: 'answer' }) + '\n' + JSON.stringify({ type: 'result', text: 'answer', usage: { input: 1, output: 2 } }) + '\n');
      return '';
    }), write: vi.fn(async () => {}), remove: vi.fn(async () => {}), prepareSkills: vi.fn(async () => {}), activities: vi.fn(async () => {}) };
    const context = { container: 'chosen-container', workdir: '/workspace/repo', stateRoot: '/workspace/.toolplane/runtimes/hermes-rpc/agents/agent-1', skillRoot: base.skillRoot, mcpServers: base.mcpServers, history: [], message: 'hi' };
    await expect(runHermesRpcTurn(options, context, io)).resolves.toBe('answer');
    expect(io.prepareSkills).toHaveBeenCalledOnce();
    expect(io.exec).toHaveBeenCalledWith(expect.objectContaining({ container: 'chosen-container', workdir: '/workspace/repo', executable: 'node' }));
    expect(io.activities).toHaveBeenCalledWith([expect.objectContaining({ deploymentId: 'deployment-1', originalToolName: 'echo' })]);
    expect(io.remove).toHaveBeenCalledOnce();
    expect(options.onTextDelta).toHaveBeenCalledWith('answer');
  });
});

const python = process.env.HERMES_RPC_TEST_PYTHON || 'python3';
const hasPython = spawnSync(python, ['--version'], { timeout: 5000 }).status === 0;
async function protocol(scenario: string, extra: Record<string, unknown> = {}, seed = false, cancel = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hermes-protocol-'));
  try {
    const home = path.join(dir, 'home');
    if (seed) { await mkdir(path.join(home, 'toolplane-sessions'), { recursive: true }); await writeFile(path.join(home, 'toolplane-sessions/conversation-1.json'), JSON.stringify({ version: 1, storedSessionId: 'stored-session', binding: 'binding-1' })); }
    const request = { sessionId: 'conversation-1', home, cwd: dir, token: 'SYNTHETIC_RUNTIME_GRANT', source: 'fixture-source', binding: 'binding-1', python,
      bootstrap: path.join(process.cwd(), 'tests/fixtures/fake-hermes-gateway.py'), scenario, timeoutMs: 2000, message: 'hi', ...extra };
    const input = path.join(dir, 'input.json'); await writeFile(input, JSON.stringify(request));
    const result = await new Promise<{ code: number | null; output: string; stderr: string }>((resolve, reject) => {
      let output = '', stderr = '', cancelled = false;
      const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts/hermes-rpc-session.mjs'), input]);
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Protocol fixture timed out')); }, 8000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (cancel && !cancelled && output.includes('"commands"')) { cancelled = true; setTimeout(() => child.kill('SIGTERM'), 50); }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; }); child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, stderr }); });
    });
    const events = result.output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, events, mapping: await readFile(path.join(home, 'toolplane-sessions/conversation-1.json'), 'utf8').then(JSON.parse, () => null) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe.skipIf(!hasPython)('Hermes RPC bounded protocol driver', () => {
  it('filters foreign sessions and redacts grants split across individual delta frames', async () => {
    const result = await protocol('success');
    expect(result.code).toBe(0); expect(result.events.at(-1)).toMatchObject({ type: 'result', text: 'hello [redacted] world' });
    expect(result.output).not.toContain('SYNTHETIC_RUNTIME_GRANT'); expect(result.output).not.toContain('wrong-session-data');
    expect(result.mapping.storedSessionId).toBe('stored-session');
    expect(result.events.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe('hello [redacted] world');
  });
  it.each(['malformed', 'error', 'interactive', 'oversized', 'exit-early', 'hang'])('fails closed on %s without a success result', async (scenario) => {
    const result = await protocol(scenario);
    expect(result.code).not.toBe(0); expect(result.events.at(-1).type).toBe('error');
    expect(result.events.some((event) => event.type === 'result')).toBe(false);
  }, 12000);
  it('cancels a running native operation instead of returning a successful partial response', async () => {
    const result = await protocol('hang', {}, false, true);
    expect(result.code).not.toBe(0); expect(result.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cancelled') });
  });
  it('does not silently recreate missing or differently bound native state', async () => {
    expect((await protocol('missing-state', {}, true)).code).not.toBe(0);
    const changed = await protocol('success', { binding: 'different-provider' }, true);
    expect(changed.events.at(-1).message).toContain('binding changed');
  });
  it('compacts natively, saves the rotated identity, and rejects busy or unknown commands', async () => {
    const compacted = await protocol('success', { command: '/compact retain findings' }, true);
    expect(compacted.code).toBe(0); expect(compacted.mapping.storedSessionId).toBe('stored-compacted');
    expect((await protocol('compact-busy', { command: '/compact' }, true)).code).not.toBe(0);
    expect((await protocol('success', { command: '/model arbitrary' })).code).not.toBe(0);
  });
});
