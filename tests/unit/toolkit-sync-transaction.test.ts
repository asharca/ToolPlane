// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SYNC_CLIENT_SOURCE } from '@/lib/plugin/sync-client';
import { installationName } from '@/lib/plugin/installation-identity';

let home: string;
const config = { base: 'https://toolplane.test', workspaceSlug: 'ws', toolkitSlug: 'dev', client: 'codex' };
const installation = installationName(config);
const prefix = installation + '-';
const skill = (content = 'last-known-good', slug = 'alpha') => {
  const value = { content, files: [{ path: 'scripts/run.py', content: 'print(1)' }] };
  return { slug, ...value, version: createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12) };
};
const snapshot = (skills = [skill()]) => ({ data: { schemaVersion: 1, snapshotComplete: true, workspaceSlug: 'ws', toolkitSlug: 'dev', skills } });
const target = () => path.join(home, 'skills', prefix + 'alpha', 'SKILL.md');
function run(value: unknown, preload?: string) {
  writeFileSync(path.join(home, 'response.json'), JSON.stringify(value));
  return spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), path.join(home, 'sync.cjs'), path.join(home, 'config.json'), path.join(home, 'response.json'), path.join(home, 'skills'), prefix], { encoding: 'utf8', timeout: 5000 });
}
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'toolplane-sync-test-'));
  writeFileSync(path.join(home, 'sync.cjs'), SYNC_CLIENT_SOURCE);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, installation }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
describe('recoverable Skill snapshot transaction', () => {
  it('applies a full snapshot and skips unchanged file rewrites', () => {
    expect(run(snapshot()).status).toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
    const mtime = statSync(target()).mtimeMs;
    const result = run(snapshot());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
    expect(statSync(target()).mtimeMs).toBe(mtime);
  });
  it.each([{}, { data: {} }, { data: { skills: [] } }, { data: { ...snapshot().data, snapshotComplete: false } }])('rejects incomplete JSON instead of deleting the old snapshot', (bad) => {
    expect(run(snapshot()).status).toBe(0);
    expect(run(bad).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
  });
  it('accepts an explicit empty snapshot and only removes owned files', () => {
    expect(run(snapshot()).status).toBe(0);
    const other = path.join(home, 'skills', prefix + 'manually-added');
    mkdirSync(other); writeFileSync(path.join(other, 'SKILL.md'), 'user content');
    expect(run(snapshot([])).status).toBe(0);
    expect(existsSync(target())).toBe(false);
    expect(readFileSync(path.join(other, 'SKILL.md'), 'utf8')).toBe('user content');
  });
  it('rejects hash mismatch and duplicate names without touching old files', () => {
    expect(run(snapshot()).status).toBe(0);
    expect(run(snapshot([{ ...skill(), content: 'tampered' }])).status).not.toBe(0);
    expect(run(snapshot([skill(), skill()])).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
  });
  it('rejects unowned target directories instead of replacing them', () => {
    const dir = path.dirname(target()); mkdirSync(dir, { recursive: true }); writeFileSync(target(), 'manual');
    expect(run(snapshot()).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('manual');
  });
  it('blocks path traversal before a transaction starts', () => {
    expect(run(snapshot()).status).toBe(0);
    const s = skill(); s.files[0].path = '../outside.txt';
    s.version = createHash('sha256').update(JSON.stringify({ content: s.content, files: s.files })).digest('hex').slice(0, 12);
    expect(run(snapshot([s])).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
    expect(existsSync(path.join(home, 'outside.txt'))).toBe(false);
  });
  it('restores the previous snapshot after a killed commit, even if the next response is invalid', () => {
    expect(run(snapshot()).status).toBe(0);
    const hook = path.join(home, 'crash.cjs');
    writeFileSync(hook, `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(a.includes('/stage/'))process.exit(91);};`);
    expect(run(snapshot([skill('new-but-uncommitted')]), hook).status).toBe(91);
    expect(run({}).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
  });
  it('refuses another live sync owner', () => {
    expect(run(snapshot()).status).toBe(0);
    const lock = path.join(home, 'skills', '.toolplane-state', installation, 'lock');
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    expect(run(snapshot([skill('not-committed')])).status).not.toBe(0);
    expect(readFileSync(target(), 'utf8')).toBe('last-known-good');
    expect(existsSync(lock)).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('never follows a replaced owned directory symlink', () => {
    expect(run(snapshot()).status).toBe(0);
    const outside = path.join(home, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'SKILL.md'), 'private');
    rmSync(path.dirname(target()), { recursive: true }); symlinkSync(outside, path.dirname(target()), 'dir');
    expect(run(snapshot([skill('new')])).status).not.toBe(0);
    expect(readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe('private');
  });
});
describe('installation identity', () => {
  it('isolates instances, base paths, workspaces, Toolkit IDs and overlapping slugs', () => {
    const inputs = [config, { ...config, base: 'https://elsewhere.test' }, { ...config, base: 'https://toolplane.test/another' }, { ...config, workspaceSlug: 'ws2' }, { ...config, toolkitSlug: 'dev-tools' }];
    expect(new Set(inputs.map(installationName)).size).toBe(inputs.length);
    expect(installationName({ ...config, base: 'https://TOOLPLANE.test:443/' })).toBe(installation);
    expect(installationName({ ...config, workspaceId: 'w1', toolkitId: 't1' })).toBe(installationName({ ...config, workspaceId: 'w1', toolkitId: 't1', toolkitSlug: 'renamed' }));
  });
});
