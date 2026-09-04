import { describe, expect, it } from 'vitest';
import {
  CLAUDE_RUNTIME_USER,
  SANDBOX_RUNTIME_PACKAGES,
  buildSandboxSkillBundles,
  buildClaudeMcpConfig,
  buildDshPatch,
  buildPiMcpConfig,
  buildPiModelsConfig,
  buildSandboxTranscript,
  dshProviderProtocol,
  dshEventTapSource,
  normalizeSandboxWorkingDirectory,
  parseClaudeStreamLine,
  parseDshEventLine,
  parsePiStreamLine,
  piMcpExtensionSource,
  resolveSandboxMcpToolOrigin,
  sandboxRuntimeCanReachProxy,
  sandboxRuntimeExecWrapper,
  sandboxRuntimeSkillRoot,
  sandboxRuntimeStateRoot,
} from '@/lib/agents/sandbox-runtime';
import type { SkillForPrompt } from '@/lib/agents/resolve';
import { agentRuntimeSupportsProviderFormat } from '@/lib/agents/runtime-kind';

describe('sandbox Agent runtime helpers', () => {
  it('routes all dedicated runtimes through the three generic provider protocols', () => {
    expect(CLAUDE_RUNTIME_USER).toBe('1000:1000');
    for (const runtime of ['pi', 'claude-code', 'dsh']) {
      expect(['openai', 'openai-responses', 'anthropic'].every((format) => (
        agentRuntimeSupportsProviderFormat(runtime, format)
      ))).toBe(true);
      expect(agentRuntimeSupportsProviderFormat(runtime, 'pi:openai')).toBe(false);
    }
  });

  it('keeps work paths inside /workspace and never copies attachment bytes into the transcript', () => {
    expect(normalizeSandboxWorkingDirectory('/workspace/project/../src')).toBe('/workspace/src');
    expect(() => normalizeSandboxWorkingDirectory('../../etc')).toThrow(/under \/workspace/);
    const transcript = buildSandboxTranscript([{
      role: 'user',
      parts: [{
        type: 'file',
        filename: 'notes.txt',
        data: 'secret-base64',
        providerMetadata: { toolplane: { runtimePath: '/workspace/uploads/notes.txt' } },
      }],
    }]);
    expect(transcript).toContain('/workspace/uploads/notes.txt');
    expect(transcript).not.toContain('secret-base64');
  });

  it('parses Claude stream-json text and final results', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    }))).toEqual({ delta: 'hello' });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 80, output_tokens: 10, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
    }))).toEqual({ result: 'done', contextTokens: 100 });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    }))).toEqual({ activities: [{ type: 'reasoning', status: 'running' }] });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'README.md' } }] },
    }))).toEqual({ activities: [{
      type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'Read', input: { path: 'README.md' },
    }] });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'contents', is_error: false }] },
    }))).toEqual({ activities: [{
      type: 'tool', status: 'completed', toolCallId: 'call-1', output: 'contents', isError: false,
    }] });
    expect(parseClaudeStreamLine('not json')).toBeNull();
  });

  it('pins Pi and parses its JSONL text and failures', () => {
    expect(SANDBOX_RUNTIME_PACKAGES.pi.specs).toEqual([
      '@earendil-works/pi-coding-agent@0.80.3',
      '@earendil-works/pi-ai@0.80.3',
    ]);
    expect(parsePiStreamLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }))).toEqual({ delta: 'hello' });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'checking files' },
    }))).toEqual({ activities: [{ type: 'reasoning', status: 'running', delta: 'checking files' }] });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read_file', args: { path: 'README.md' },
    }))).toEqual({ activities: [{
      type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'README.md' },
    }] });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'toolplane_mcp_origin', toolCallId: 'call-1', deploymentId: 'dep-1', originalToolName: 'read/file',
    }))).toEqual({ activities: [{
      type: 'tool', status: 'running', toolCallId: 'call-1', deploymentId: 'dep-1', originalToolName: 'read/file',
    }] });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read_file', result: 'contents', isError: false,
    }))).toEqual({ activities: [{
      type: 'tool', status: 'completed', toolCallId: 'call-1', toolName: 'read_file', output: 'contents', isError: false,
    }] });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: { input: 80, output: 20, totalTokens: 100 },
      },
    }))).toEqual({ assistantText: 'done', contextTokens: 100 });
    expect(parsePiStreamLine(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'bad request' },
    }))).toEqual({ error: 'bad request', isError: true });
  });

  it('configures Pi with env-only model auth and a real dynamic MCP extension', async () => {
    const models = buildPiModelsConfig({
      provider: { id: 'provider-1', name: 'Gateway', format: 'openai' },
      modelId: 'model-1',
      modelProxyBase: 'http://host.docker.internal:3000/api/v1/agent-runtime/model/provider-1',
    });
    expect(models).toContain('"apiKey": "$TOOLPLANE_RUNTIME_TOKEN"');
    expect(models).toContain('"api": "openai-completions"');
    expect(models).not.toContain('runtime-secret');

    const mcp = buildPiMcpConfig([
      { deploymentId: 'dep-1', url: 'http://host.docker.internal:3000/api/v1/agent-runtime/mcp/dep-1/rpc' },
    ]);
    expect(mcp).toContain('dep-1/rpc');
    expect(mcp).toContain('"deploymentId":"dep-1"');
    expect(mcp).not.toContain('runtime-secret');
    const extension = piMcpExtensionSource();
    expect(extension).toContain("rpc(server, 'tools/list')");
    expect(extension).toContain("rpc(server, 'tools/call'");
    expect(extension).toContain('pi.registerTool');
    expect(extension).toContain('process.env.TOOLPLANE_RUNTIME_TOKEN');
    expect(extension).toContain("redirect: 'error'");
    expect(extension).toContain('MAX_SCHEMA_BYTES = 64 * 1024');
    expect(extension).toContain('MAX_REGISTERED_TOOLS = 256');
    expect(extension).toContain("type: 'toolplane_mcp_origin'");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(extension).toString('base64')}`;
    const loaded = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    expect(loaded.default).toBeTypeOf('function');
  });

  it('recovers MCP origin only from stable runtime aliases', () => {
    const servers = [
      { deploymentId: 'dep-one', url: 'https://runtime.example/one' },
      { deploymentId: 'dep-two', url: 'https://runtime.example/two' },
    ];
    expect(resolveSandboxMcpToolOrigin('mcp__s2_t4__search_files', servers)).toEqual({ deploymentId: 'dep-two' });
    expect(resolveSandboxMcpToolOrigin('mcp__tp_1_dep-one__read/file', servers)).toEqual({
      deploymentId: 'dep-one', originalToolName: 'read/file',
    });
    expect(resolveSandboxMcpToolOrigin('tp_2_dep-two__write_file', servers)).toEqual({
      deploymentId: 'dep-two', originalToolName: 'write_file',
    });
    expect(resolveSandboxMcpToolOrigin('bash', servers)).toBeNull();
  });

  it('generates a DSH proxy profile and env-backed MCP auth without embedding a token', async () => {
    const patch = buildDshPatch({
      provider: { id: 'provider-1', name: 'Gateway "One"', format: 'openai-responses' },
      modelId: 'model\nname',
      modelProxyBase: 'http://host.docker.internal:3000/api/v1/agent-runtime/model/provider-1',
      systemPrompt: 'line one\nline two',
      skillRoot: '/workspace/.toolplane/runtimes/dsh/agents/agent-1/skills',
      mcpServers: [{ deploymentId: 'dep-1', url: 'http://host.docker.internal:3000/api/v1/agent-runtime/mcp/dep-1/rpc' }],
      eventPluginPath: '/workspace/.toolplane/runtime-tmp/events.mjs',
    });
    expect(dshProviderProtocol('openai-responses')).toBe('openai-responses');
    expect(patch).toContain('apiKeyEnv: TOOLPLANE_RUNTIME_TOKEN');
    expect(patch).toContain('Authorization: !!js process.env.TOOLPLANE_MCP_AUTH');
    expect(patch).toContain('model\\nname');
    expect(patch).not.toContain('Bearer runtime-secret');
    expect(patch.match(/^- insert:$/gm)).toHaveLength(1);
    expect(patch).toContain('file:///workspace/.toolplane/runtime-tmp/events.mjs');
    expect(patch).toContain('includeDefaultRoots: false');
    expect(patch).toContain('customSkillDirs:');
    expect(patch).toContain('/workspace/.toolplane/runtimes/dsh/agents/agent-1/skills');
    const eventTap = dshEventTapSource('__EVENT__');
    expect(eventTap).toContain("ctx.on('session/event'");
    expect(eventTap).toContain('process.stdout.write');
    const eventTapModule = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(eventTap).toString('base64')}`) as { apply?: unknown };
    expect(eventTapModule.apply).toBeTypeOf('function');
    expect(parseDshEventLine('__EVENT__{"type":"text","delta":"hello"}', '__EVENT__')).toEqual({ delta: 'hello' });
    expect(parseDshEventLine('__EVENT__{"type":"reasoning","status":"running","delta":"checking"}', '__EVENT__')).toEqual({
      activities: [{ type: 'reasoning', status: 'running', delta: 'checking' }],
    });
    expect(parseDshEventLine('__EVENT__{"type":"tool","status":"running","toolCallId":"call-1","toolName":"bash","input":"{\\"command\\":\\"ls\\"}"}', '__EVENT__')).toEqual({
      activities: [{
        type: 'tool', status: 'running', toolCallId: 'call-1', toolName: 'bash', input: { command: 'ls' }, isError: false,
      }],
    });
    expect(sandboxRuntimeCanReachProxy('none')).toBe(false);
    expect(sandboxRuntimeCanReachProxy('isolated')).toBe(true);
    expect(sandboxRuntimeStateRoot('claude-code', 'agent/a')).toBe('/workspace/.toolplane/runtimes/claude-code/agents/agent_a');
    expect(sandboxRuntimeStateRoot('dsh', 'agent/a')).toBe('/workspace/.toolplane/runtimes/dsh/agents/agent_a');
    expect(sandboxRuntimeStateRoot('pi', 'agent/a')).toBe('/workspace/.toolplane/runtimes/pi/agents/agent_a');
    expect(sandboxRuntimeStateRoot('pi', '..')).toBe('/workspace/.toolplane/runtimes/pi/agents/agent');
    expect(sandboxRuntimeSkillRoot('pi', 'agent/a')).toBe('/workspace/.toolplane/runtimes/pi/agents/agent_a/skills');
    expect(sandboxRuntimeSkillRoot('claude-code', 'agent/a'))
      .toBe(`${sandboxRuntimeStateRoot('claude-code', 'agent/a')}/skills`);
    const wrapper = sandboxRuntimeExecWrapper('__CONTROL__');
    expect(wrapper).toContain('> "$pid_file"');
    expect(wrapper).toContain("trap 'rm -f -- \"$pid_file\"' EXIT");
  });

  it('projects complete skill directories and scopes Claude MCP credentials to the generated config', () => {
    const bundles = buildSandboxSkillBundles([{
      skillId: null,
      slug: 'Deploy Tool',
      name: 'Deploy',
      content: 'Always run the smoke check.',
      files: [
        { path: 'references/checklist.md', content: '# Checklist' },
        { path: 'scripts/deploy.sh', content: 'ZWNobyBkZXBsb3k=', encoding: 'base64' },
      ],
      skill: null,
    }, {
      skillId: null,
      slug: 'Deploy Tool',
      name: 'Deploy again',
      content: 'Second.',
      skill: null,
    }] satisfies SkillForPrompt[]);
    expect(bundles.map((bundle) => bundle.directory)).toEqual(['deploy-tool', 'deploy-tool-2']);
    expect(bundles[0]?.markdown).toContain('Always run the smoke check.');
    expect(bundles[0]?.files).toEqual([
      { path: 'references/checklist.md', content: '# Checklist' },
      { path: 'scripts/deploy.sh', content: 'ZWNobyBkZXBsb3k=', encoding: 'base64' },
    ]);
    const config = JSON.parse(buildClaudeMcpConfig([
      { deploymentId: 'dep-1', url: 'https://runtime.example/mcp/dep-1/rpc' },
    ], 'runtime-secret')) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
    expect(Object.values(config.mcpServers)[0]?.headers.Authorization).toBe('Bearer runtime-secret');
  });
});
