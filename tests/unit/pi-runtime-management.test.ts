import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as ChildProcess from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ agent: vi.fn(), link: vi.fn(), spawn: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agent: { findFirst: mocks.agent }, agentSandbox: { findUnique: mocks.link } } }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: (_id: string, status: string) => status }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, default: { ...actual, spawn: mocks.spawn }, spawn: mocks.spawn };
});

import { DEFAULT_PI_VERSION, getPiRuntimeVersion, updatePiRuntimeVersion, runSandboxAgentTurn, validatePiVersion } from '@/lib/agents/sandbox-runtime';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';

let selected: string;
let reported: string | undefined;
let installFailed: boolean;
let installed: Set<string>;
let files: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  selected = ''; reported = undefined; installFailed = false;
  installed = new Set([DEFAULT_PI_VERSION]); files = new Map();
  mocks.agent.mockResolvedValue({ sandboxes: [{ sandboxId: 'sandbox-pi' }] });
  mocks.link.mockResolvedValue({ agent: { workspaceId: 'workspace-pi' }, sandbox: { workspaceId: 'workspace-pi', kind: 'docker', network: 'bridge', deploymentId: 'deployment-pi', deployment: { status: 'running' } } });
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    let input = '';
    child.stdin.on('data', (chunk) => { input += String(chunk); });
    queueMicrotask(() => {
      const command = args.slice(args.indexOf('toolplane-runtime') + 2);
      const binary = command[0];
      let text = ''; let code = 0;
      const version = command.join(' ').match(/runtime-packages\/pi-([\w.-]+)/)?.[1];
      if (binary === 'test') code = installed.has(version!) ? 0 : 1;
      else if (command.includes('toolplane-pnpm-install')) {
        if (installFailed) code = 1; else installed.add(version!);
      } else if (command.includes('toolplane-write')) files.set(command.at(-1)!, input);
      else if (binary === 'node' && command[1] === '-e') {
        const script = command[2];
        if (script.includes('readFileSync')) text = selected;
        else if (script.includes('accessSync')) text = installed.has(version!) ? 'yes' : '';
        else if (script.includes('renameSync')) selected = command.at(-1)!;
      } else if (command.includes('--version')) text = reported ?? version!;
      else if (binary === 'node' && command[1].endsWith('-session.mjs')) {
        const session = JSON.parse(files.get(command[2])!);
        const rootVersion = session.packageRoot.split('/pi-')[1];
        const binaryVersion = session.binary.match(/pi-([\w.-]+)\/node_modules/)[1];
        text = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${binaryVersion}:${rootVersion}` }], stopReason: 'stop' } });
      }
      if (code) child.stderr.emit('data', Buffer.from('installation failed'));
      const prefix = args[args.indexOf('toolplane-runtime') - 1].match(/__TOOLPLANE_RUNTIME_PID_[A-Za-z0-9-]+__/)![0];
      child.stdout.emit('data', Buffer.from(`${prefix}123\n${text}`));
      child.emit('exit', code, null);
    });
    return child;
  });
});

it('switches the persisted pin and both CLI and session SDK to the verified version', async () => {
  expect(await getPiRuntimeVersion('workspace-pi', 'agent-pi')).toEqual({ version: DEFAULT_PI_VERSION, installed: true });
  await updatePiRuntimeVersion('workspace-pi', 'agent-pi', '0.87.1');
  expect(await getPiRuntimeVersion('workspace-pi', 'agent-pi')).toEqual({ version: '0.87.1', installed: true });
  const result = await runSandboxAgentTurn({ runtimeKind: 'pi', workspaceId: 'workspace-pi', agentId: 'agent-pi', sandboxId: 'sandbox-pi',
    provider: { id: 'provider-pi', name: 'Provider', format: 'openai' }, modelId: 'model', contextWindow: 128000,
    modelProxyBase: 'http://proxy.test/v1', runtimeAccessToken: 'token', runtimeSessionId: 'session-pi',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });
  expect(result).toBe('0.87.1:0.87.1');
});

it('preserves the old selection after installation or CLI verification fails', async () => {
  selected = DEFAULT_PI_VERSION;
  installFailed = true;
  await expect(updatePiRuntimeVersion('workspace-pi', 'agent-pi', '0.87.1')).rejects.toThrow();
  expect(selected).toBe(DEFAULT_PI_VERSION);
  installFailed = false; reported = 'wrong-version';
  await expect(updatePiRuntimeVersion('workspace-pi', 'agent-pi', '0.87.1')).rejects.toThrow(/requested version/);
  expect((await getPiRuntimeVersion('workspace-pi', 'agent-pi')).version).toBe(DEFAULT_PI_VERSION);
});

it('blocks updates while another turn owns the sandbox and rejects foreign workspace assignments', async () => {
  let release!: () => void;
  const turn = withSandboxExecutionLease('sandbox-pi', () => new Promise<void>((resolve) => { release = resolve; }));
  try { await expect(updatePiRuntimeVersion('workspace-pi', 'agent-pi', '0.87.1')).rejects.toThrow(/executing another turn/); }
  finally { release(); await turn; }
  await expect(updatePiRuntimeVersion('foreign-workspace', 'agent-pi', '0.87.1')).rejects.toThrow(/not assigned/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('rejects non-Pi or unassigned agents and unsafe version specifiers before Docker access', async () => {
  mocks.agent.mockResolvedValue(null);
  await expect(updatePiRuntimeVersion('workspace-pi', 'agent-pi', '0.87.1')).rejects.toThrow(/assigned Docker sandbox/);
  for (const version of ['latest', '../0.87.1', 'file:/tmp/package', '0.87.1;id', '--help', '01.2.3', '1.2']) {
    expect(() => validatePiVersion(version)).toThrow();
  }
  expect(validatePiVersion('0.87.1-rc.2')).toBe('0.87.1-rc.2');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
