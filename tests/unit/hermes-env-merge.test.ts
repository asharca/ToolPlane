import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { HERMES_ENV_MERGE_SCRIPT } from '@/lib/agents/hermes/env-merge-script';

describe('Hermes managed environment merge', () => {
  let directory = '';

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function merge(managed: Record<string, string>) {
    const envPath = path.join(directory, '.env');
    const managedPath = path.join(directory, 'managed.json');
    const scriptPath = path.join(directory, 'merge.py');
    writeFileSync(managedPath, JSON.stringify(managed));
    writeFileSync(scriptPath, HERMES_ENV_MERGE_SCRIPT);
    const result = spawnSync('python3', [scriptPath, envPath, managedPath], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return envPath;
  }

  it('updates ToolPlane-owned keys while preserving Hermes-owned variables', () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'toolplane-hermes-env-'));
    const envPath = path.join(directory, '.env');
    writeFileSync(envPath, [
      '# Hermes managed',
      'HERMES_TOKEN=keep',
      'OLD=value',
      'SHARED=old',
      'export CHANNEL_TOKEN=keep-too',
      '',
    ].join('\n'));
    writeFileSync(path.join(directory, '.toolplane-env-keys.json'), '["OLD","SHARED"]');

    merge({ SHARED: 'new value', NEW_KEY: '$literal' });

    const merged = readFileSync(envPath, 'utf8');
    expect(merged).toContain('# Hermes managed\n');
    expect(merged).toContain('HERMES_TOKEN=keep\n');
    expect(merged).toContain('export CHANNEL_TOKEN=keep-too\n');
    expect(merged).not.toContain('OLD=value');
    expect(merged).toContain('NEW_KEY="$literal"\n');
    expect(merged).toContain('SHARED="new value"\n');
    expect(readFileSync(path.join(directory, '.toolplane-env-keys.json'), 'utf8')).toBe(
      '["NEW_KEY", "SHARED"]',
    );
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    merge({});
    const cleared = readFileSync(envPath, 'utf8');
    expect(cleared).toContain('HERMES_TOKEN=keep');
    expect(cleared).not.toContain('NEW_KEY=');
    expect(cleared).not.toContain('SHARED=');
  });
});
