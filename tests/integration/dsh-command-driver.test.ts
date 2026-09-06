// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildDshPatch, SANDBOX_RUNTIME_PACKAGES } from '@/lib/agents/sandbox-runtime';

const container = process.env.TOOLPLANE_COMMAND_SANDBOX_TEST;
it.runIf(Boolean(container))('uses the installed DSH command registry and persists goals across processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'toolplane-command-test-'));
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024 });
  const root = SANDBOX_RUNTIME_PACKAGES.dsh.directory;
  const prefix = '__TOOLPLANE_TEST__';
  try {
    docker('exec', container!, 'mkdir', '-p', dir);
    await writeFile(join(dir, 'driver.mjs'), await readFile('scripts/dsh-runtime-driver.mjs', 'utf8'));
    const patch = buildDshPatch({ provider: { id: 'test', name: 'Test', format: 'openai' }, modelId: 'test', modelProxyBase: 'http://127.0.0.1:9/v1', systemPrompt: 'Offline command test', skillRoot: `${dir}/skills`, driverPluginPath: `${dir}/driver.mjs` })
      + '- id: goal-round-driver\n  disabled: true\n';
    await writeFile(join(dir, 'patch.yml'), patch);
    docker('cp', `${dir}/driver.mjs`, `${container}:${dir}/driver.mjs`);
    docker('cp', `${dir}/patch.yml`, `${container}:${dir}/patch.yml`);
    const command = async (line: string, sessionId = 'isolated-command-test') => {
      await writeFile(join(dir, 'input.json'), JSON.stringify({ packageRoot: root, prefix, sessionId, history: 'Previous context: retain plan.md.', command: line }));
      docker('cp', `${dir}/input.json`, `${container}:${dir}/input.json`);
      const output = docker('exec', '-w', dir, '-e', `DSH_HOME=${dir}/state`, '-e', `TOOLPLANE_DSH_INPUT=${dir}/input.json`, '-e', 'TOOLPLANE_RUNTIME_TOKEN=test', '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'DSH_TOOLS_MODE=native', container!, 'timeout', '30s', `${root}/node_modules/.bin/dsh`, '--profile', 'headless', '--patch', `${dir}/patch.yml`, 'ignored');
      const events = output.split('\n').filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
      expect(events.find((event) => event.type === 'commands')?.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'goal' })]));
      return events.find((event) => event.type === 'command');
    };
    expect((await command('/goal')).text).toContain('No goal');
    expect(await command('/compact extra')).toMatchObject({ isError: true, text: expect.stringContaining('arguments') });
    expect((await command('/goal Finish the release checklist')).text).toContain('Goal created');
    expect((await command('/goal')).text).toContain('Finish the release checklist');
    expect((await command('/goal pause')).text).toContain('paused');
    expect((await command('/goal edit Keep exact paths')).text).toContain('Keep exact paths');
    expect((await command('/goal resume')).text).toContain('resumed');
    expect((await command('/goal', 'other-conversation')).text).toContain('No goal');
    expect((await command('/goal clear')).text).toContain('cleared');
    expect((await command('/goal')).text).toContain('No goal');
  } finally {
    docker('exec', container!, 'rm', '-rf', '--', dir);
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);
