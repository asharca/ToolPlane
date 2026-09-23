// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeApprovalAdapter, claudeApprovalSettings } from '@/lib/agents/native-tool-approval';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function hook(response: (req: IncomingMessage, res: ServerResponse) => void, event: unknown = {
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf approved' }, tool_use_id: 'native-call',
}) {
  const server = createServer(response); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  return new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/a2a-native-approval.mjs'), '--claude'], {
      env: { ...process.env, TOOLPLANE_APPROVAL_URL: `http://127.0.0.1:${address.port}/api/v1/agent-runtime/a2a/test/approvals`,
        TOOLPLANE_RUNTIME_TOKEN: 'test-only-runtime-credential' }, stdio: ['pipe','pipe','pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', v => { out += v; }); child.stderr.on('data', v => { err += v; });
    child.on('error', reject); child.on('exit', code => done({ code, out, err }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}
describe('native pre-tool approval process', () => {
  it('uses a real subprocess and HTTP boundary to allow an exact approved invocation', async () => {
    let raw = '', authorization: string | undefined;
    const result = await hook((req,res) => { authorization = req.headers.authorization; req.on('data', value => { raw += value; });
      req.on('end', () => { res.writeHead(200, {'content-type':'application/json'}); res.end('{"status":"allow"}'); }); });
    expect(result.code).toBe(0); expect(JSON.parse(raw)).toEqual({ action: 'check', callId: 'native-call', toolName: 'Bash', input: { command: 'printf approved' } });
    expect(authorization).toBe('Bearer test-only-runtime-credential');
    expect(JSON.parse(result.out).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(result.out + result.err).not.toContain('test-only-runtime-credential');
  });
  it.each(['deny','unexpected','expired'])('fails closed for %s rather than asking the CLI to execute', async status => {
    const result = await hook((_req,res) => { res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify({status})); });
    expect(result.code).toBe(2); expect(JSON.parse(result.out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('fails closed on an uncertain approval delivery without retrying the business operation', async () => {
    let calls=0;const result=await hook(req=>{calls++;req.socket.destroy();});
    expect(result.code).toBe(2);expect(calls).toBe(1);
  });
  it('rejects redirects without forwarding the runtime credential', async () => {
    const result=await hook((_req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:1/credential-leak'});res.end();});
    expect(result.code).toBe(2);
  });
  it('rejects malformed hook input', async () => { const result=await hook((_req,res)=>res.end(),'{invalid');expect(result.code).toBe(2); });
  it('places interception before execution and preserves other DSH denials', () => {
    const pi=nativeApprovalAdapter('pi','/tmp/approval.mjs'),dsh=nativeApprovalAdapter('dsh','/tmp/approval.mjs');
    expect(pi).toContain("pi.on('tool_call'");expect(pi).toContain('event.toolCallId');expect(pi).toContain('block: true');
    expect(dsh).toContain("ctx.on('tools/pre-execute'");expect(dsh).toContain('execution.arguments');expect(dsh).toContain('return await next()');
    expect(dsh).not.toContain("kind: 'allow'");
  });
  it('pins Claude hooks with a deny fallback and no blanket permission grant', () => {
    const settings=JSON.parse(claudeApprovalSettings('/tmp/approval.mjs'));
    expect(settings.permissions).toEqual({defaultMode:'dontAsk',allow:[]});
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('|| exit 2');
    expect(()=>claudeApprovalSettings('/tmp/injected;touch file.mjs')).toThrow();
  });
});
