// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicRemoteAddress, remotePair, remoteUrl, fetchRemoteJson, remoteRpcFetch, REMOTE_RESPONSE_BYTES } from '@/lib/a2a/remote-network';
import { REMOTE_CARD, REMOTE_RPC, remoteTask } from '../fixtures/a2a-remote';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
let status: number, headers: Record<string, string>, body: string;
let options: Record<string, unknown>;
beforeEach(() => {
  vi.stubEnv('TOOLPLANE_A2A_REMOTE_ORIGINS', JSON.stringify(['https://agent.example']));
  vi.clearAllMocks(); status = 200; headers = { 'content-type': 'application/json' }; body = '{}';
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockImplementation((_url, opts, receive) => {
    options = opts;
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: status, headers, complete: true, destroy: vi.fn() });
      receive(res); queueMicrotask(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
    }) });
    return req;
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('remote HTTPS egress boundary', () => {
  it.each(['127.0.0.1', '10.0.0.2', '172.16.1.1', '192.168.1.2', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.1.1.1',
    '198.18.0.1', '192.0.2.1', '::1', '::ffff:93.184.216.34', 'fc00::1', 'fe80::1', '2001:db8::1', '2002::1', '3fff::1'])('blocks non-public %s', (address) => expect(publicRemoteAddress(address)).toBe(false));
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('accepts globally routable %s', (address) => expect(publicRemoteAddress(address)).toBe(true));
  it('is default deny and requires exact origin approval', () => {
    vi.stubEnv('TOOLPLANE_A2A_REMOTE_ORIGINS', '[]'); expect(() => remoteUrl(REMOTE_RPC)).toThrow();
    vi.stubEnv('TOOLPLANE_A2A_REMOTE_ORIGINS', '["https://agent.example/path"]'); expect(() => remoteUrl(REMOTE_RPC)).toThrow();
  });
  it.each(['http://agent.example/a2a', 'https://user:pass@agent.example/a2a', 'https://agent.example/a2a?x=1', 'https://agent.example/a2a#x',
    'https://other.example/a2a', 'https://agent.example:444/a2a', ' https://agent.example/a2a', 'https://agent.example\\bad'])('rejects unapproved address %s', (url) => expect(() => remoteUrl(url)).toThrow());
  it('binds Card and RPC to distinct paths on the same origin', () => {
    expect(remotePair(REMOTE_CARD, REMOTE_RPC)).toEqual({ cardUrl: REMOTE_CARD, rpcUrl: REMOTE_RPC });
    expect(() => remotePair(REMOTE_RPC, REMOTE_RPC)).toThrow();
  });
  it('rejects mixed public/private DNS before making any connection', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, 'secret')).rejects.toThrow(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the actual lookup and leaves TLS/hostname verification enabled', async () => {
    await fetchRemoteJson(REMOTE_CARD, 'GET', undefined, 'secret');
    const callback = vi.fn();
    (options.lookup as (host: string, opts: { all: boolean }, cb: typeof callback) => void)('agent.example', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.agent).toBe(false); expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.checkServerIdentity).toBeUndefined();
    expect(options.headers).toMatchObject({ authorization: 'Bearer secret', 'accept-encoding': 'identity' });
  });
  it.each([204, 205, 301, 302, 307, 401, 500])('does not follow redirects or retry HTTP %s', async (code) => {
    status = code; headers.location = 'http://169.254.169.254';
    await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, 'secret')).rejects.toThrow(); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('rejects compressed, non-JSON and oversized bodies', async () => {
    headers['content-encoding'] = 'gzip'; await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, undefined)).rejects.toThrow();
    headers = { 'content-type': 'text/html' }; await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, undefined)).rejects.toThrow();
    headers = { 'content-type': 'application/json' }; body = 'x'.repeat(REMOTE_RESPONSE_BYTES + 1);
    await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, undefined)).rejects.toThrow();
  });
  it('honors an already-aborted signal even before DNS completes', async () => {
    mocks.lookup.mockReturnValue(new Promise(() => undefined));
    await expect(fetchRemoteJson(REMOTE_CARD, 'GET', undefined, undefined, AbortSignal.abort())).rejects.toThrow(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('uses only the stored credential, validates wire output and refuses SDK target changes', async () => {
    body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: remoteTask() });
    const fetcher = remoteRpcFetch(REMOTE_RPC, 'stored-key');
    await fetcher(REMOTE_RPC, { method: 'POST', headers: { authorization: 'Bearer injected', cookie: 'private' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'peer-task' } }) });
    expect(options.headers).toMatchObject({ authorization: 'Bearer stored-key' }); expect(options.headers).not.toHaveProperty('cookie');
    await expect(fetcher(REMOTE_CARD, { method: 'POST' })).rejects.toThrow();
    body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ...remoteTask(), artifacts: [{ artifactId: 'x', parts: [{ text: 'x', url: 'https://private' }] }] } });
    await expect(fetcher(REMOTE_RPC, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask' }) })).rejects.toThrow();
  });
});
