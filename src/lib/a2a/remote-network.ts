import 'server-only';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { validateRemoteResponse } from './remote-wire';
import { runtimeEnv } from '@/lib/runtime-env';

export const REMOTE_RESPONSE_BYTES = 524_288;
export const REMOTE_REQUEST_BYTES = 262_144;
export class RemoteA2AError extends Error {
  constructor(message = 'The remote Agent request could not be verified or completed.') { super(message); }
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicRemoteAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
/** Deployment administrator approves exact origins; workspace administrators cannot override this policy. */
export function remoteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RemoteA2AError('Invalid remote HTTPS address.'); }
  if (value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new RemoteA2AError('Remote addresses require HTTPS without credentials, query or fragment.');
  }
  let allowed: unknown;
  try { allowed = JSON.parse(runtimeEnv('TOOLPLANE_A2A_REMOTE_ORIGINS') || '[]'); } catch { throw new RemoteA2AError('Configure the remote Agent origin allowlist.'); }
  if (!Array.isArray(allowed) || allowed.length > 100 || !allowed.every((origin) => typeof origin === 'string') || !allowed.includes(url.origin)) {
    throw new RemoteA2AError('The deployment administrator has not allowed this remote origin.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicRemoteAddress(host)) throw new RemoteA2AError('Private or reserved remote addresses are not allowed.');
  return url;
}
export function remotePair(cardUrl: string, rpcUrl: string) {
  const card = remoteUrl(cardUrl), rpc = remoteUrl(rpcUrl);
  if (card.origin !== rpc.origin || card.href === rpc.href) throw new RemoteA2AError('Card and RPC addresses must be distinct paths on the same approved origin.');
  return { cardUrl: card.href, rpcUrl: rpc.href };
}
async function addresses(host: string, signal: AbortSignal) {
  const pending = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true });
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new RemoteA2AError());
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([pending, aborted]);
    if (!result.length || result.length > 32 || result.some((item) => !publicRemoteAddress(item.address))) throw new RemoteA2AError('Remote DNS resolved to a prohibited address.');
    return result[0];
  } finally { signal.removeEventListener('abort', abort); }
}
/** Bounded JSON-only HTTPS fetch, with DNS pinned to the validated address for this exact connection. */
async function fetchPinnedRemoteJson(urlValue: string, method: 'GET' | 'POST', body: string | undefined, token: string | undefined, signal?: AbortSignal): Promise<Response> {
  const url = remoteUrl(urlValue);
  if (body && Buffer.byteLength(body) > REMOTE_REQUEST_BYTES) throw new RemoteA2AError('Remote request size limit exceeded.');
  if (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 8192)) throw new RemoteA2AError('Invalid remote credential.');
  const abortSignal = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pinned = await addresses(host, abortSignal); abortSignal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const fail = () => reject(new RemoteA2AError());
    const req = request(url, {
      method, agent: false, signal: abortSignal, maxHeaderSize: 16_384,
      // SNI and certificate validation remain tied to the original HTTPS hostname.
      family: pinned.family,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
      },
      headers: { accept: 'application/json', 'accept-encoding': 'identity', 'a2a-version': '1.0',
        ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      const code = res.statusCode ?? 0;
      if (code < 200 || code >= 300 || code === 204 || code === 205 || !/^application\/json(?:\s*;|$)/i.test(String(res.headers['content-type'] ?? ''))
        || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'
        || res.headers['a2a-version'] && res.headers['a2a-version'] !== '1.0'
        || Number(res.headers['content-length']) > REMOTE_RESPONSE_BYTES) {
        res.destroy(); req.destroy(); fail(); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > REMOTE_RESPONSE_BYTES) { res.destroy(); req.destroy(); fail(); }
        else chunks.push(chunk);
      });
      res.on('error', fail); res.on('aborted', fail);
      res.on('end', () => {
        if (!res.complete) { fail(); return; }
        resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
      });
    });
    req.on('error', fail); req.end(body);
  });
}
/** No header passthrough, URL switching, proxy environment, redirect following or automatic replay. */
export function remoteRpcFetch(rpcUrl: string, token: string | undefined): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== remoteUrl(rpcUrl).href || req.method !== 'POST') throw new RemoteA2AError('Remote transport target changed.');
    const body = await req.text();
    const response = await fetchRemoteJson(rpcUrl, 'POST', body, token, req.signal);
    try { validateRemoteResponse(JSON.parse(body), await response.clone().json()); }
    catch { throw new RemoteA2AError('Remote output is not a valid supported A2A response.'); }
    return response;
  };
}

let inflight = 0;
export async function fetchRemoteJson(...args: Parameters<typeof fetchPinnedRemoteJson>): Promise<Response> {
  if (inflight >= 16) throw new RemoteA2AError('Remote connection capacity reached.');
  inflight++;
  try { return await fetchPinnedRemoteJson(...args); }
  finally { inflight--; }
}
