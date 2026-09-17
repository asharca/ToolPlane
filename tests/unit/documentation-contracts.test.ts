// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { AGENT_RUNTIME_KINDS, AGENT_CONTROL_RUNTIME_KINDS, AGENT_RUNTIME_CAPABILITIES, agentRuntimeCapabilities } from '@/lib/agents/runtime-kind';
import { installationName } from '@/lib/plugin/installation-identity';
import { SYNC_CLIENT_SOURCE } from '@/lib/plugin/sync-client';

const control = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: 'example-agent' })) }));
vi.mock('@/lib/agents/control-service', () => ({
  AgentControlError: class extends Error { constructor(public code: string, message: string) { super(message); } },
  createAgentFromControl: control.create,
  getAgentControlAgent: vi.fn(), inspectAgentControlDeployment: vi.fn(), listAgentControlAgents: vi.fn(),
  listAgentControlResources: vi.fn(), sendAgentControlMessage: vi.fn(),
}));
import { AGENT_CONTROL_MCP_TOOLS, executeAgentControlTool } from '@/lib/agents/control-mcp';

const docs = path.join(process.cwd(), 'docs');
const read = (file: string) => readFileSync(path.join(docs, file), 'utf8');

describe('production capabilities and bilingual documentation contracts', () => {
  it.each(['AGENT_CONTROL_MCP.md', 'AGENT_CONTROL_MCP.zh-CN.md'])('validates the actual JSON-RPC example in %s through the production parser', async (file) => {
    const match = /-d '(\{[\s\S]*?\})'/.exec(read(file));
    expect(match).not.toBeNull();
    const request = JSON.parse(match![1]);
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_agent', arguments: { runtime: 'pi' } } });
    await expect(executeAgentControlTool({ workspaceId: 'ws', workspaceSlug: 'acme' }, request.params.name, request.params.arguments)).resolves.toEqual({ id: 'example-agent' });
    expect(control.create).toHaveBeenLastCalledWith('ws', 'acme', expect.objectContaining({ runtime: 'pi', maxSteps: 100 }));
  });
  it.each(['native', 'claude-code', 'dsh', 'hermes-rpc'])('keeps unsupported Control MCP creation runtime %s rejected', async (runtime) => {
    control.create.mockClear();
    await expect(executeAgentControlTool({ workspaceId: 'ws', workspaceSlug: 'acme' }, 'create_agent', { name: 'No side effect', runtime })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(control.create).not.toHaveBeenCalled();
  });
  it('keeps runtime capabilities complete without widening the Control MCP subset', () => {
    expect(Object.keys(AGENT_RUNTIME_CAPABILITIES)).toEqual([...AGENT_RUNTIME_KINDS]);
    const create = AGENT_CONTROL_MCP_TOOLS.find((tool) => tool.name === 'create_agent')!;
    expect(create.inputSchema.properties.runtime.enum).toEqual(AGENT_CONTROL_RUNTIME_KINDS);
    expect(agentRuntimeCapabilities('native')).toBeNull();
    expect(agentRuntimeCapabilities('hermes')).toMatchObject({ attachments: true, providerBinding: 'multiple' });
    for (const kind of ['pi', 'claude-code', 'dsh', 'hermes-rpc']) expect(agentRuntimeCapabilities(kind)).toMatchObject({ attachments: false, providerBinding: 'single' });
  });
  it.each(['TOOLKIT_SYNC.md', 'TOOLKIT_SYNC.en.md'])('applies the documented full snapshot in %s using the actual sync client', (file) => {
    const examples = [...read(file).matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
    const value = examples.find((v) => v.data?.snapshotComplete === true);
    expect(value).toBeDefined();
    const config = { base: 'https://example.test', workspaceId: 'workspace-id', toolkitId: 'toolkit-id', workspaceSlug: 'acme', toolkitSlug: 'devtools', client: 'codex' };
    const name = installationName(config);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'toolplane-doc-contract-'));
    try {
      writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(value));
      writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...config, installation: name }));
      writeFileSync(path.join(dir, 'sync.cjs'), SYNC_CLIENT_SOURCE);
      const result = spawnSync(process.execPath, [path.join(dir, 'sync.cjs'), path.join(dir, 'config.json'), path.join(dir, 'snapshot.json'), path.join(dir, 'skills'), name + '-'], { encoding: 'utf8', timeout: 5000 });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(dir, 'skills', name + '-pdf', 'SKILL.md'), 'utf8')).toContain('name: pdf');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps every topic bilingual, top-linked and registered in both indexes', () => {
    const names = readdirSync(docs).filter((name) => /^[A-Z_]+\.md$/.test(name) && name !== 'README.md');
    for (const name of names) {
      const stem = name.slice(0, -3);
      const counterpart = existsSync(path.join(docs, stem + '.en.md')) ? stem + '.en.md' : stem + '.zh-CN.md';
      expect(existsSync(path.join(docs, counterpart)), counterpart).toBe(true);
      expect(read(name).split('\n').slice(0, 8).join('\n')).toContain(`](./${counterpart})`);
      expect(read(counterpart).split('\n').slice(0, 8).join('\n')).toContain(`](./${name})`);
      for (const index of ['README.md', 'README.zh-CN.md']) {
        expect(read(index), index).toContain(`](./${name})`);
        expect(read(index), index).toContain(`](./${counterpart})`);
      }
    }
  });
  it('resolves relative links and linked source entry points in maintained topic docs', () => {
    for (const file of readdirSync(docs).filter((file) => file.endsWith('.md'))) {
      for (const [, target] of read(file).matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
        const pathname = target.split('#')[0];
        expect(existsSync(path.resolve(docs, decodeURIComponent(pathname))), `${file}: ${target}`).toBe(true);
      }
    }
  });
  it('documents sandbox-only execution instead of restoring a removed host fallback', () => {
    expect(read('SANDBOXES.md')).toContain('never falls back');
    expect(read('SANDBOXES.zh-CN.md')).toContain('不回退宿主机执行');
    expect(read('TOOLKIT_SYNC.en.md')).toContain('including `draft`');
    expect(read('TOOLKIT_SYNC.md')).toContain('包含 `draft`');
  });
});
