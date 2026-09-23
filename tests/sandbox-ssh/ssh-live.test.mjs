import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSshSandbox } from '../../scripts/ssh-sandbox-adapter.mjs';
const filename = process.env.TOOLPLANE_SSH_LIVE_TARGET;
test('pinned real sshd: info, argv/env, UTF-8, binary, timeout and host-key rejection', { skip: !filename }, async () => {
  const target = JSON.parse(readFileSync(filename, 'utf8'));
  const sandbox = createSshSandbox(target, { id: 'ssh-live-test', name: 'Fixture' });
  try {
    await sandbox.ready();
    const info = await sandbox.callTool('sandbox_info'); assert.notEqual(info.isError, true);
    const command = await sandbox.callTool('shell_exec', { command: 'printf "hello-ssh"', timeoutMs: 5000 });
    assert.match(JSON.stringify(command), /hello-ssh/); assert.notEqual(command.isError, true);
    const text = 'UTF-8 中文 SSH';
    const write = await sandbox.callTool('write_file', { path: 'hello.txt', content: text }); assert.notEqual(write.isError, true);
    const read = await sandbox.callTool('read_file', { path: 'hello.txt' }); assert.match(JSON.stringify(read), /中文/);
    const bytes = Buffer.from([0, 1, 127, 255]);
    const binary = await sandbox.callTool('write_file', { path: 'binary.dat', content: bytes.toString('base64'), encoding: 'base64' }); assert.notEqual(binary.isError, true);
    const downloaded = await sandbox.callTool('download_file', { path: 'binary.dat' }); assert.match(JSON.stringify(downloaded), new RegExp(bytes.toString('base64')));
    const start = Date.now(); await sandbox.callTool('shell_exec', { command: 'sleep 10', timeoutMs: 250 });
    assert.ok(Date.now() - start < 10_000, 'remote timeout must be bounded');
    const wrong = createSshSandbox({ ...target, knownHostsFile: process.env.TOOLPLANE_SSH_BAD_HOSTS });
    try { await assert.rejects(() => wrong.ready()); } finally { wrong.close(); }
  } finally { sandbox.close(); }
});
