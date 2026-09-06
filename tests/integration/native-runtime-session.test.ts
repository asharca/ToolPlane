// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { buildDshPatch, buildPiModelsConfig, dshEventTapSource, SANDBOX_RUNTIME_PACKAGES } from '@/lib/agents/sandbox-runtime';

const container = process.env.TOOLPLANE_NATIVE_COMMAND_SANDBOX;
const kind = process.env.TOOLPLANE_NATIVE_COMMAND_KIND === 'dsh' ? 'dsh' : process.env.TOOLPLANE_NATIVE_COMMAND_KIND === 'pi' ? 'pi' : 'claude-code';
it.runIf(Boolean(container))(`executes ${kind} commands in its real persistent CLI with no external model calls`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toolplane-native-command-'));
  const docker = async (...args: string[]) => (await promisify(execFile)('docker', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const requests: string[] = [];
  let modelRequests = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    if (/\/(messages|chat\/completions)$/.test(req.url ?? '')) modelRequests++;
    if (req.url?.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ input_tokens: 123 })); return; }
    const content = body.includes('Summariz') || body.includes('summariz') ? 'Native summary: preserve plan.md and continue the release.' : 'Native reply from the test provider.';
    res.setHeader('Content-Type', 'text/event-stream');
    if (kind === 'claude-code') {
      for (const event of [
        { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 123, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 12, total_tokens: 135 } },
      ]) res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'test', ...chunk })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  try {
    const inspect = JSON.parse(await docker('inspect', container!))[0];
    const gateway = (Object.values(inspect.NetworkSettings.Networks)[0] as { Gateway: string }).Gateway;
    const base = `http://${gateway}:${(server.address() as { port: number }).port}`;
    const root = SANDBOX_RUNTIME_PACKAGES[kind].directory;
    const model = kind === 'pi' ? 'test' : 'claude-sonnet-4-6';
    await docker('exec', container!, 'mkdir', '-p', `${dir}/state/sessions`);
    await writeFile(join(dir, 'driver.mjs'), await readFile(`scripts/${kind === 'dsh' ? 'dsh-runtime-driver' : 'native-runtime-session'}.mjs`, 'utf8'));
    await writeFile(join(dir, 'models.json'), buildPiModelsConfig({ provider: { id: 'test', name: 'Test', format: 'openai' }, modelId: model, modelProxyBase: `${base}/v1` }));
    await docker('cp', `${dir}/driver.mjs`, `${container}:${dir}/driver.mjs`);
    await docker('cp', `${dir}/models.json`, `${container}:${dir}/state/models.json`);
    if (kind === 'dsh') {
      await writeFile(join(dir, 'events.mjs'), dshEventTapSource('__TOOLPLANE_DSH_EVENT__'));
      await writeFile(join(dir, 'patch.yml'), buildDshPatch({ provider: { id: 'test', name: 'Test', format: 'openai' }, modelId: model, modelProxyBase: `${base}/v1`, systemPrompt: 'Native command test', skillRoot: `${dir}/skills`, eventPluginPath: `${dir}/events.mjs`, driverPluginPath: `${dir}/driver.mjs` }));
      await docker('cp', `${dir}/events.mjs`, `${container}:${dir}/events.mjs`);
      await docker('cp', `${dir}/patch.yml`, `${container}:${dir}/patch.yml`);
    }
    const args = kind === 'pi' ? ['--mode', 'rpc', '--no-approve', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--provider', 'toolplane', '--model', model]
      : ['--bare', '--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions', '--model', model];
    let signature = 'test';
    const run = async (command?: string, message = 'Continue with the current plan.', history = [
      { role: 'user', text: 'Keep plan.md' }, { role: 'assistant', text: 'Previous native-imported plan.' },
      ...(kind !== 'claude-code' ? [{ role: 'user', text: 'Recent context detail. '.repeat(6000) }, { role: 'assistant', text: 'The current plan is ready.' }] : []),
    ], allowError = false) => {
      await writeFile(join(dir, 'input.json'), JSON.stringify(kind === 'dsh' ? { packageRoot: root, prefix: '__TOOLPLANE_DSH_EVENT__', sessionId: 'test-session', command, history: history.map((item) => `${item.role}: ${item.text}`).join('\n'), message }
        : { kind, args, model, api: 'openai-completions', packageRoot: root, binary: `${root}/node_modules/.bin/${SANDBOX_RUNTIME_PACKAGES[kind].binary}`, statePath: `${dir}/state/sessions/session.json`, signature, command, history, message, prompt: message }));
      await docker('cp', `${dir}/input.json`, `${container}:${dir}/input.json`);
      await docker('exec', container!, 'chown', '-R', '1000:1000', dir);
      const output = await docker('exec', '--user', kind === 'claude-code' ? '1000:1000' : '0:0', '-w', dir,
        '-e', `HOME=${dir}/state`, '-e', `CLAUDE_CONFIG_DIR=${dir}/state`, '-e', 'ANTHROPIC_API_KEY=test-only', '-e', 'ANTHROPIC_AUTH_TOKEN=test-only', '-e', `ANTHROPIC_BASE_URL=${base}`, '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        '-e', `PI_CODING_AGENT_DIR=${dir}/state`, '-e', 'TOOLPLANE_RUNTIME_TOKEN=test-only', '-e', 'PI_OFFLINE=1', '-e', 'PI_TELEMETRY=0',
        '-e', `DSH_HOME=${dir}/state`, '-e', `TOOLPLANE_DSH_INPUT=${dir}/input.json`, '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'DSH_TOOLS_MODE=native', container!,
        ...(kind === 'dsh' ? [`${root}/node_modules/.bin/dsh`, '--profile', 'headless', '--patch', `${dir}/patch.yml`, 'ignored'] : ['node', `${dir}/driver.mjs`, `${dir}/input.json`]));
      const events = output.split('\n').filter((line) => kind === 'dsh' ? line.startsWith('__TOOLPLANE_DSH_EVENT__') : Boolean(line)).map((line) => JSON.parse(kind === 'dsh' ? line.slice('__TOOLPLANE_DSH_EVENT__'.length) : line));
      if (!allowError) expect(events.filter((event) => event.type === 'toolplane_command_result' && event.isError)).toEqual([]);
      expect(events.filter((event) => event.type === 'command' && event.isError)).toEqual([]);
      if (!allowError) expect(events.find((event) => event.type === 'result')?.is_error).not.toBe(true);
      return events;
    };
    const first = await run();
    if (kind === 'dsh') expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', delta: expect.stringContaining('Native reply') })]));
    expect(requests.join('\n')).toContain('Keep plan.md');
    const turns = requests.length;
    if (kind === 'claude-code') {
      const usage = await run('/usage');
      expect(usage.find((event) => event.type === 'result')?.result).toContain('Total duration (API)');
      expect(usage.find((event) => event.type === 'result')?.result).toContain('123 input');
      expect(requests).toHaveLength(turns);
      const context = await run('/context');
      expect(context.find((event) => event.type === 'result')?.result).toContain('Context Usage');
      const compact = await run('/compact Preserve exact file paths');
      expect(compact.some((event) => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
      requests.length = 0;
      signature = 'reconnected';
      await run(undefined, 'Continue after native compaction and reconnect.');
      expect(requests.join('\n')).toContain('Native summary');
      await run('/clear');
      requests.length = 0;
      await run(undefined, 'Fresh request after clear.');
      expect(requests.join('\n')).not.toContain('Keep plan.md');
    } else if (kind === 'pi') {
      const compact = await run('/compact Keep exact paths');
      expect(compact).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'toolplane_command_result', isError: false, text: 'Conversation compacted.' })]));
      requests.length = 0;
      signature = 'reconnected';
      await run(undefined, 'Continue after compaction.');
      expect(requests.join('\n')).toContain('Native summary');
    } else {
      await run(undefined, 'Keep going.');
      const compact = await run('/compact');
      expect(compact.find((event) => event.type === 'command')?.text).toContain('Compacted');
      requests.length = 0;
      await run(undefined, 'Continue after compaction.');
      expect(requests.join('\n')).toContain('Native summary');
      expect(requests.join('\n')).not.toContain('Recent context detail.');
    }
    if (kind !== 'dsh') {
      const state = JSON.parse(await docker('exec', container!, 'cat', `${dir}/state/sessions/session.json`));
      const nativePath = kind === 'pi' ? `${dir}/state/sessions/session.json.jsonl` : `${dir}/state/projects/${dir.replace(/[^a-zA-Z0-9]/g, '-')}/${state.id}.jsonl`;
      await docker('exec', container!, 'rm', '--', nativePath);
      signature = 'missing-native-history';
      const requestsBefore = modelRequests;
      const missing = await run(undefined, 'Continue.', undefined, true);
      expect(missing.some((event) => event.isError || event.is_error)).toBe(true);
      expect(JSON.stringify(missing)).toMatch(/Native session history is missing|No conversation found/);
      expect(modelRequests).toBe(requestsBefore);
    }
  } finally {
    // Only this test's process group and temporary state, never the user's runtime sessions.
    await docker('exec', container!, 'pkill', '-f', `${dir}/driver.mjs`).catch(() => {});
    await docker('exec', container!, 'rm', '-rf', '--', dir);
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 180_000);
