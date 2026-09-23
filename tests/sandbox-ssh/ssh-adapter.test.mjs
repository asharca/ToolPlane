import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSshTarget, sshArguments, sshTerminalSpec } from '../../scripts/ssh-sandbox-adapter.mjs';
const target = { host: '192.0.2.10', port: 2222, username: 'sandbox', root: '/srv/agent workspace', identityFile: '/run/keys/id_ed25519', knownHostsFile: '/run/keys/known_hosts' };
test('SSH target only returns permitted configuration fields', () => {
  assert.equal(validateSshTarget({ ...target, password: 'never-used' }).password, undefined);
});
test('rejects host or username option injection', () => {
  for (const host of ['-oProxyCommand=evil', 'host;echo', 'host name', 'host\nline']) assert.throws(() => validateSshTarget({ ...target, host }));
  assert.throws(() => validateSshTarget({ ...target, username: '-root' }));
});
test('rejects invalid ports', () => {
  for (const port of [0, 65536, '22', 2.5]) assert.throws(() => validateSshTarget({ ...target, port }));
});
test('rejects credential path traversal and whitespace', () => {
  for (const identityFile of ['relative', '/run/../keys/id', '/run/key file', '/run/key\0']) assert.throws(() => validateSshTarget({ ...target, identityFile }));
});
test('uses pinned keys, isolated config, no forwarding or agent', () => {
  const args = sshArguments(target, 'remote-command');
  for (const value of ['StrictHostKeyChecking=yes','IdentitiesOnly=yes','IdentityAgent=none','ForwardAgent=no','ClearAllForwardings=yes','ProxyCommand=none','PasswordAuthentication=no']) assert.ok(args.includes(value));
  assert.deepEqual(args.slice(0,2),['-F','/dev/null']);
  assert.deepEqual(args.slice(-3),['--',target.host,'remote-command']);
  assert.ok(args.includes('-T')); assert.ok(args.includes('UserKnownHostsFile=/run/keys/known_hosts'));
});
test('PTY uses fixed binary, no shell option concatenation', () => {
  const result = sshTerminalSpec(target,'sub');
  assert.equal(result.command,'/usr/bin/ssh');assert.ok(result.args.includes('-tt'));
  assert.equal(result.args.at(-1),"cd '/srv/agent workspace/sub' && exec /bin/sh -l");
});
test('PTY rejects escaping cwd', () => {
  for (const cwd of ['../', '/etc', 'a/../b', 'a\\b']) assert.throws(() => sshTerminalSpec(target,cwd));
});
test('PTY safely quotes apostrophes and metacharacters', () => {
  const result=sshTerminalSpec(target,"quote'; echo not-executed; '");
  assert.equal(result.args.at(-1),"cd '/srv/agent workspace/quote'\\''; echo not-executed; '\\''' && exec /bin/sh -l");
});
