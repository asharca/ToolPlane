import { describe, it, expect, vi } from 'vitest';
import {
  buildAgentToolSet,
  runAgentTurn,
  subAgentToolKey,
  type RunAgent,
  type RunDeps,
} from '@/lib/agents/run';
import { AGENT_MAX_DEPTH } from '@/lib/agents/constants';

function fakeAgent(over: Partial<RunAgent> = {}): RunAgent {
  return {
    name: 'Sub',
    runtimeKind: 'pi',
    systemPrompt: null,
    model: 'gpt-x',
    maxSteps: 4,
    provider: { id: 'provider-1', name: 'p', format: 'openai', baseUrl: 'http://x', apiKey: 'k' },
    servers: [],
    skills: [],
    toolkits: [],
    subAgents: [],
    ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    loadAgent: async () => fakeAgent(),
    runModel: async () => 'FAKE_REPLY',
    runSandboxModel: async () => 'FAKE_REPLY',
    ...over,
  };
}

type ToolExec = (args: { prompt: string }, opts: unknown) => Promise<{ text: string }>;

describe('buildAgentToolSet', () => {
  const SUBS = [{ id: 'b', name: 'Bee', slug: 'bee', description: null }];

  it('adds an agent_<slug> tool per sub-agent', async () => {
    const set = await buildAgentToolSet(
      { deploymentIds: [], subAgents: SUBS },
      { workspaceId: 'w', depth: 0, visited: new Set(['a']) },
      deps(),
    );
    expect(Object.keys(set)).toContain('agent_bee');
  });

  it('adds skill runtime tools when skills are attached', async () => {
    const set = await buildAgentToolSet(
      {
        deploymentIds: [],
        subAgents: [],
        skills: [
          {
            skillId: null,
            skill: null,
            name: 'PDF',
            slug: 'pdf',
            content: '# PDF',
            userInvocable: true,
            agentInvocable: true,
            status: 'published',
          },
        ],
      },
      { workspaceId: 'w', depth: 0, visited: new Set(['a']) },
      deps(),
    );
    expect(Object.keys(set).sort()).toEqual(['skill_list_attached', 'skill_read_file', 'skill_run_script']);
  });

  it.each(['pi', 'claude-code', 'dsh'])('delegates %s through the sandbox runner with the prompt', async (runtimeKind) => {
    const runModel = vi.fn<RunDeps['runModel']>(async () => 'FROM_SUB');
    const runSandboxModel = vi.fn<NonNullable<RunDeps['runSandboxModel']>>(async () => 'FROM_SUB');
    const set = await buildAgentToolSet(
      { deploymentIds: [], subAgents: SUBS },
      { workspaceId: 'w', depth: 0, visited: new Set(['a']) },
      deps({
        loadAgent: async () => fakeAgent({ runtimeKind }),
        runModel,
        runSandboxModel,
      }),
    );
    const exec = set[subAgentToolKey('bee')].execute as unknown as ToolExec;
    const out = await exec({ prompt: 'do it' }, {});
    expect(out).toEqual({ text: 'FROM_SUB' });
    expect(runModel).not.toHaveBeenCalled();
    expect(runSandboxModel).toHaveBeenCalledOnce();
    expect(runSandboxModel.mock.calls[0][0]).toMatchObject({
      agent: { runtimeKind, provider: { id: 'provider-1' } },
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'do it' }] }],
    });
  });
});

describe('runAgentTurn guards', () => {
  const base = { workspaceId: 'w', depth: 0, visited: new Set<string>() };

  it('refuses a cycle without invoking the model', async () => {
    const runModel = vi.fn(async () => 'X');
    const out = await runAgentTurn('a', 'p', { ...base, visited: new Set(['a']) }, deps({ runModel }));
    expect(out).toMatch(/cycle detected/);
    expect(runModel).not.toHaveBeenCalled();
  });

  it('refuses past max depth without invoking the model', async () => {
    const runModel = vi.fn(async () => 'X');
    const out = await runAgentTurn('a', 'p', { ...base, depth: AGENT_MAX_DEPTH }, deps({ runModel }));
    expect(out).toMatch(/max sub-agent depth/);
    expect(runModel).not.toHaveBeenCalled();
  });

  it('runs a normal one-level delegate and returns the model text', async () => {
    const out = await runAgentTurn('b', 'hello', base, deps());
    expect(out).toBe('FAKE_REPLY');
  });

  it('reports a sub-agent that has no model configured', async () => {
    const out = await runAgentTurn(
      'b',
      'hi',
      base,
      deps({ loadAgent: async () => fakeAgent({ model: null }) }),
    );
    expect(out).toMatch(/no model configured/);
  });

  it('reports a sub-agent missing from the workspace', async () => {
    const out = await runAgentTurn('gone', 'hi', base, deps({ loadAgent: async () => null }));
    expect(out).toMatch(/not found/);
  });

  it('refuses an unavailable runtime without invoking the model', async () => {
    const runModel = vi.fn(async () => 'X');
    const runSandboxModel = vi.fn(async () => 'X');
    const out = await runAgentTurn(
      'b',
      'hi',
      base,
      deps({
        loadAgent: async () => fakeAgent({ runtimeKind: 'future-runtime' }),
        runModel,
        runSandboxModel,
      }),
    );
    expect(out).toMatch(/runtime "future-runtime" is not available/);
    expect(runModel).not.toHaveBeenCalled();
    expect(runSandboxModel).not.toHaveBeenCalled();
  });
});
