// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('blocks bad staged commits and type-invalid pushes without modifying user content', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolplane-hooks-'));
  const remote = mkdtempSync(join(tmpdir(), 'toolplane-hooks-remote-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'hooks@example.invalid');
    git('config', 'user.name', 'Hook regression');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
    cpSync('.githooks', join(root, '.githooks'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    for (const name of ['check-staged.mjs', 'install-git-hooks.mjs']) cpSync(`scripts/${name}`, join(root, 'scripts', name));
    cpSync('eslint.config.mjs', join(root, 'eslint.config.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
      'check:staged': 'node scripts/check-staged.mjs',
      check: 'eslint . && tsc --noEmit --skipLibCheck --types node *.ts',
    } }));
    execFileSync(process.execPath, ['scripts/install-git-hooks.mjs'], { cwd: root, env });
    for (const [file, broken, fixed, message] of [
      ['syntax with spaces.ts', 'export const value = ;', 'export const value = 1;', 'Expression expected'],
      ['data.json', '{"broken":}', '{"valid":true}', 'data.json'],
      ['lint.ts', 'const module = 1; console.log(module);', 'const value = 1; console.log(value);', 'no-assign-module-variable'],
    ]) {
      writeFileSync(join(root, file), broken);
      git('add', '--', file);
      writeFileSync(join(root, file), fixed);
      const result = spawnSync('git', ['commit', '-m', 'must be rejected'], { cwd: root, env, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
      expect(git('show', `:${file}`)).toBe(broken);
      git('add', '--', file);
      git('commit', '-m', 'valid staged content');
    }
    git('mv', 'syntax with spaces.ts', 'renamed with spaces.ts');
    git('rm', 'data.json');
    git('commit', '-m', 'rename and delete');
    expect(git('show', 'HEAD:renamed with spaces.ts')).toBe('export const value = 1;');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    writeFileSync(join(root, 'renamed with spaces.ts'), "export const value: number = 'wrong';");
    git('add', '--', 'renamed with spaces.ts');
    git('commit', '-m', 'valid syntax but invalid type');
    const push = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: root, env, encoding: 'utf8' });
    expect(push.status).not.toBe(0);
    expect(push.stdout + push.stderr).toContain('TS2322');
    writeFileSync(join(root, 'renamed with spaces.ts'), 'export const value: number = 1;');
    const dirtyPush = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: root, env, encoding: 'utf8' });
    expect(dirtyPush.status).not.toBe(0);
    expect(dirtyPush.stderr).toContain('Commit or stash tracked changes');
    git('add', '--', 'renamed with spaces.ts');
    git('commit', '-m', 'fix type');
    git('push', 'origin', 'HEAD:refs/heads/main');
    expect(git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(git('rev-parse', 'HEAD').trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
}, 90_000);
