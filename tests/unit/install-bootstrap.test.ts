// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildInstallBootstrap } from '@/lib/plugin/install-bootstrap';
import { installationName } from '@/lib/plugin/installation-identity';

const options = { base: 'https://toolplane.test', workspaceId: 'ws-id', toolkitId: 'tk-id', workspaceSlug: 'acme', toolkitSlug: 'dev', client: 'codex', linkId: 'opaque-link' };
const name = installationName(options);
let home: string;
const root = () => path.join(home, '.codex', 'toolplane', name);
function run(uninstall = false, extra: Record<string, string> = {}) {
  return spawnSync('bash', [], { input: buildInstallBootstrap({ ...options, uninstall }), encoding: 'utf8', timeout: 10_000,
    env: { NODE_ENV: 'test', PATH: path.join(home, 'bin') + ':' + process.env.PATH, HOME: home, TEST_HOME: home, TEST_INSTALLATION: name, ...extra },
  });
}
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'toolplane-bootstrap-'));
  mkdirSync(path.join(home, 'bin'));
  const fake = `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2), dir=process.env.TEST_HOME, name=process.env.TEST_INSTALLATION;
const input=args[args.indexOf('--data-binary')+1];
const body=JSON.parse(fs.readFileSync(input.slice(1),'utf8'));
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({body,args})+'\\n');
if(process.env.TRANSPORT_FAIL==='1')process.exit(22);
const dest=path.join(dir,'.codex','toolplane',name);
const writes=JSON.stringify({mcpServers:{[name]:{headers:{Authorization:'Bearer fixture-new-key'}}}});
const script=body.operation==='revoke' ? 'echo removed > '+JSON.stringify(path.join(dir,'removed')) :
  'printf %s '+JSON.stringify(writes)+' > '+JSON.stringify(path.join(dest,'.mcp.json'))+'\\n'+
  (process.env.FAIL_APPLY==='1' ? 'exit 19' : 'echo applied > '+JSON.stringify(path.join(dir,'applied')));
process.stdout.write(JSON.stringify({installationId:'registration-id',script}));
`;
  writeFileSync(path.join(home, 'bin', 'curl'), fake, { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const calls = () => readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
describe.skipIf(process.platform === 'win32')('executed per-device bootstrap in an isolated HOME', () => {
  it('registers once and proves the same local registration on reinstall', () => {
    const initial = run(); expect(initial.status, initial.stderr).toBe(0);
    expect(calls()[0].body.installationId).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(root(), 'installation.json'), 'utf8'))).toMatchObject({ id: 'registration-id', name, client: 'codex' });
    const second = run(); expect(second.status, second.stderr).toBe(0);
    expect(calls()[1].body.installationId).toBe('registration-id');
    expect(calls()[1].args).toContain('Authorization: Bearer fixture-new-key');
  });
  it('keeps the old registration on transport failure and releases its installer lock', () => {
    expect(run().status).toBe(0);
    const before = readFileSync(path.join(root(), 'installation.json'), 'utf8');
    expect(run(false, { TRANSPORT_FAIL: '1' }).status).not.toBe(0);
    expect(readFileSync(path.join(root(), 'installation.json'), 'utf8')).toBe(before);
    expect(existsSync(path.join(home, '.codex', 'toolplane', '.toolplane-install-lock'))).toBe(false);
  });
  it('retains a private pending update after local application failure and resumes it before registering', () => {
    expect(run(false, { FAIL_APPLY: '1' }).status).not.toBe(0);
    expect(existsSync(path.join(root(), 'pending-install.sh'))).toBe(true);
    // Represents resolving the local error before retry; the durable script still carries its valid fixture key.
    const pending = path.join(root(), 'pending-install.sh');
    writeFileSync(pending, readFileSync(pending, 'utf8').replace('exit 19', 'exit 0'), { mode: 0o600 });
    const retry = run(); expect(retry.status, retry.stderr).toBe(0);
    expect(calls()[1].body.installationId).toBe('registration-id');
    expect(existsSync(pending)).toBe(false);
  });
  it('uninstalls only the local registration and refuses to guess a legacy registration', () => {
    expect(run(true).status).not.toBe(0);
    expect(existsSync(path.join(home, 'calls.jsonl'))).toBe(false);
    expect(run().status).toBe(0);
    expect(run(true).status).toBe(0);
    expect(calls()[1].body).toMatchObject({ operation: 'revoke', installationId: 'registration-id', client: 'codex' });
  });
});
