import 'server-only';
import { spawn } from 'node:child_process';
import { createConnection, isIP, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { publicRemoteAddress } from '@/lib/a2a/remote-network';
import { sandboxFlags } from '@/lib/process/sandbox';
import { MarketError } from '@/lib/market/skills';
import { parsePiPackageReleaseManifest, scanPiPackageReleaseManifest, type PiPackageSnapshotV1 } from '@/lib/market/pi-package-manifest';
import type { PiSourceAuthentication } from '@/lib/market/pi-package-network';
import { piSourceUrl, sourceAuthorization } from '@/lib/market/pi-package-network';

export type PiPackageCaptureOptions = {
  registry?: string;
  authentication?: PiSourceAuthentication;
  sourceId?: string;
  sourceUpdatedAt?: Date;
};

const IMAGE = 'toolplane-pi-package-capture:0.87.1';
const TIMEOUT = 300_000;
const FRAME = 96 * 1024;
const BLOCK = 64 * 1024;
const CONNECTION_BYTES = 128 * 1024 * 1024;
const NETWORK_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_BYTES = 96 * 1024 * 1024;
// ponytail: one capture per runtime owner; add per-owner capacity only when throughput requires it.
let capturing = false;
const failed = () => new MarketError('package_capture_failed', 'The package could not be captured safely.');

export function validatePiPackageSource(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) throw failed();
  let source = value.trim();
  if (source.startsWith('npm:')) {
    const match = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@]+))?$/.exec(source);
    if (!match || match[1].length > 214 || (match[2] && (!/^[a-zA-Z0-9.*+~^<>=| -]+$/.test(match[2]) || !match[2].trim()))) throw failed();
    return source;
  }
  const prefixed = source.startsWith('git:');
  if (prefixed) source = source.slice(4);
  const scp = /^git@([^/:]+):(.+)$/.exec(source);
  if (scp) source = `https://${scp[1]}/${scp[2]}`;
  else if (prefixed && !source.includes('://') && /^[a-zA-Z0-9.-]+\/.+/.test(source)) source = `https://${source}`;
  let url: URL;
  try { url = new URL(source); } catch { throw failed(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || (url.port && url.port !== '443') || /\s/.test(source)) throw failed();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || (isIP(host) && !publicRemoteAddress(host))) throw failed();
  let path: string;
  let ref: string;
  try { path = decodeURIComponent(url.pathname); ref = decodeURIComponent(url.hash); } catch { throw failed(); }
  const repo = path.split('@')[0];
  if (repo.split('/').filter(Boolean).length < 2 || path.split('/').some((part) => part === '.' || part === '..') || /[\x00-\x20\x7f\\]/.test(path + ref) || path.endsWith('@') || ref === '#') throw failed();
  return value.trim();
}

async function pinnedAddress(host: string): Promise<{ address: string; family: number }> {
  if (host.length > 253 || (!isIP(host) && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(host))) throw failed();
  const result = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!result.length || result.length > 32 || result.some(({ address }) => !publicRemoteAddress(address))) throw failed();
  return result[0];
}

function bytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(BLOCK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failed();
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > BLOCK || decoded.toString('base64') !== value) throw failed();
  return decoded;
}

async function dockerCommand(args: string[], timeout: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn('docker', args, { stdio: 'ignore' });
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeout);
  child.once('error', () => { clearTimeout(timer); resolve(false); });
  child.once('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  return promise;
}

export async function capturePiPackage(source: string, options: PiPackageCaptureOptions = {}): Promise<PiPackageSnapshotV1> {
  assertRuntimeOwner();
  if (capturing) throw new MarketError('capture_busy', 'Another package capture is in progress.');
  capturing = true;
  const started = Date.now();
  try {
    const validated = validatePiPackageSource(source);
    if (options.registry) piSourceUrl(options.registry);
    if (options.authentication) sourceAuthorization(piSourceUrl(options.authentication.url), options.authentication);
    if (!await dockerCommand(['image', 'inspect', IMAGE], 15_000)) throw new MarketError('capture_image_missing', `Build the capture image: docker build --target pi-package-capture -t ${IMAGE} .`);
    return await runCapture(validated, TIMEOUT - (Date.now() - started), options);
  } finally { capturing = false; }
}

type Connection = { socket?: Socket; ready: boolean; bytes: number; timer: NodeJS.Timeout };
async function runCapture(source: string, remaining: number, options: PiPackageCaptureOptions): Promise<PiPackageSnapshotV1> {
  const name = `toolplane-pi-capture-${randomUUID()}`;
  const flags = sandboxFlags('none');
  for (const [flag, value] of [['--tmpfs', '/tmp:rw,exec,size=768m,uid=1000,gid=1000,mode=0700'], ['--pids-limit', '128'], ['--memory', '1g']] as const) flags[flags.indexOf(flag) + 1] = value;
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128', ALL_PROXY: 'http://127.0.0.1:3128', npm_config_https_proxy: 'http://127.0.0.1:3128', npm_config_proxy: 'http://127.0.0.1:3128', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', COREPACK_ENABLE_PROJECT_SPEC: '0' };
  const child = spawn('docker', ['run', '--name', name, ...flags, '--user', '1000:1000', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), IMAGE, source], { stdio: ['pipe', 'pipe', 'pipe'] });
  const connections = new Map<string, Connection>();
  const closed = new Map<string, Connection>();
  function closeConnection(id: string, conn: Connection) {
    clearTimeout(conn.timer); conn.socket?.destroy(); conn.socket = undefined;
    connections.delete(id); closed.set(id, conn);
  }
  let stopped = false;
  const { promise: failure, reject: rejectFailure } = Promise.withResolvers<never>();
  // Register rejection immediately; all paths below await the same failure promise.
  void failure.catch(() => undefined);
  function abort() {
    if (stopped) return;
    stopped = true;
    for (const conn of connections.values()) { clearTimeout(conn.timer); conn.socket?.destroy(); }
    connections.clear(); child.stdout.destroy(); child.stdin.destroy(); child.kill('SIGKILL'); rejectFailure(failed());
  }
  const timer = setTimeout(abort, Math.max(1, remaining));
  child.once('error', abort); child.stdin.on('error', abort);
  child.stderr.resume(); // Never expose package output, URLs, or credentials.
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
  child.once('close', resolveExit);
  let writing = Promise.resolve();
  function send(frame: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > FRAME) throw failed();
    const write = writing.then(() => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      if (stopped) reject(failed());
      else child.stdin.write(line, (error) => error ? reject(failed()) : resolve());
      return promise;
    });
    writing = write;
    return write;
  }
  let network = 0;
  function account(conn: Connection, count: number) {
    conn.bytes += count; network += count;
    if (conn.bytes > CONNECTION_BYTES || network > NETWORK_BYTES) { abort(); throw failed(); }
  }
  async function open(id: string, host: string, conn: Connection) {
    try {
      const address = await pinnedAddress(host);
      if (stopped || connections.get(id) !== conn) return;
      const socket = conn.socket = createConnection({ host: address.address, family: address.family, port: 443 });
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      if (stopped || connections.get(id) !== conn) return;
      clearTimeout(conn.timer); conn.ready = true;
      await send({ type: 'connected', id });
      for await (const raw of socket) {
        if (stopped || connections.get(id) !== conn) return;
        const chunk = Buffer.from(raw);
        account(conn, chunk.length);
        for (let offset = 0; offset < chunk.length; offset += BLOCK) await send({ type: 'data', id, data: chunk.subarray(offset, offset + BLOCK).toString('base64') });
      }
      if (!stopped && connections.get(id) === conn) { closeConnection(id, conn); await send({ type: 'close', id }); }
    } catch {
      if (stopped || connections.get(id) !== conn) return;
      clearTimeout(conn.timer); conn.socket?.destroy(); connections.delete(id);
      await send({ type: 'error', id, code: 'connection_failed' }).catch(() => undefined);
      abort();
    }
  }
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let snapshotBytes = 0;
  let snapshotStarted = false;
  let snapshot: PiPackageSnapshotV1 | undefined;
  async function frame(line: Buffer) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { throw failed(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || snapshot) throw failed();
    const item = parsed as Record<string, unknown>;
    const fields: Record<string, string[]> = { connect: ['type', 'id', 'host', 'port'], data: ['type', 'id', 'data'], close: ['type', 'id'], error: ['type', 'code'], snapshot_chunk: ['type', 'data'], snapshot_end: ['type', 'sha256'] };
    const keys = typeof item.type === 'string' ? fields[item.type] : undefined;
    if (!keys || Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) throw failed();
    if (item.type === 'error') {
      if (item.code === 'pi_extensions_missing') throw new MarketError('pi_extensions_missing', 'The package contains no loadable Pi extension.');
      throw failed();
    }
    if (item.type === 'snapshot_chunk') {
      if (connections.size) throw failed();
      snapshotStarted = true;
      const chunk = bytes(item.data); snapshotBytes += chunk.length;
      if (snapshotBytes > SNAPSHOT_BYTES) throw failed();
      chunks.push(chunk); hash.update(chunk); return;
    }
    if (item.type === 'snapshot_end') {
      if (!snapshotStarted || connections.size || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || hash.digest('hex') !== item.sha256) throw failed();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, snapshotBytes))); } catch { throw failed(); }
      const manifest = parsePiPackageReleaseManifest({ schemaVersion: 1, kind: 'pi-package', listing: { slug: 'capture', name: 'Capture', summary: null, iconUrl: null, tags: [], author: 'Capture' }, package: value });
      if (manifest.package.source.requested !== source) throw failed();
      if (manifest.package.source.kind === 'npm' && (manifest.package.source.registry ?? 'https://registry.npmjs.org/') !== new URL(options.registry ?? 'https://registry.npmjs.org/').href.replace(/\/?$/, '/')) throw failed();
      if (scanPiPackageReleaseManifest(manifest).status === 'blocked') throw failed();
      snapshot = manifest.package; return;
    }
    if (snapshotStarted || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) throw failed();
    const id = item.id;
    if (item.type === 'connect') {
      if (connections.has(id) || closed.has(id) || connections.size >= 16 || connections.size + closed.size >= 20_000 || typeof item.host !== 'string' || item.port !== 443) throw failed();
      const conn: Connection = { ready: false, bytes: 0, timer: setTimeout(abort, 15_000) };
      connections.set(id, conn); void open(id, item.host, conn).catch(abort); return;
    }
    const conn = connections.get(id);
    if (!conn) {
      const previous = closed.get(id);
      if (!previous) throw failed();
      if (item.type === 'data') account(previous, bytes(item.data).length);
      return;
    }
    if (item.type === 'close') { closeConnection(id, conn); return; }
    if (!conn.ready || !conn.socket) throw failed();
    const data = bytes(item.data); account(conn, data.length);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    conn.socket.write(data, (error) => error ? reject(failed()) : resolve());
    await promise;
  }
  async function consume() {
    let pending = Buffer.alloc(0);
    for await (const raw of child.stdout) {
      const chunk = Buffer.from(raw);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        if (pending.length + i - start > FRAME) throw failed();
        await frame(Buffer.concat([pending, chunk.subarray(start, i)])); pending = Buffer.alloc(0); start = i + 1;
      }
      if (pending.length + chunk.length - start > FRAME) throw failed();
      pending = Buffer.concat([pending, chunk.subarray(start)]);
    }
    if (pending.length || !snapshot || await exited !== 0) throw failed();
    return snapshot;
  }
  try {
    await send({ type: 'configuration', registry: options.registry ?? 'https://registry.npmjs.org/', authentication: options.authentication ?? null });
    return await Promise.race([consume(), failure]);
  }
  catch (error) {
    if (error instanceof MarketError && error.code === 'pi_extensions_missing') throw error;
    if (error instanceof Error && error.message === 'pi_package_extensions_missing') throw new MarketError('pi_extensions_missing', 'The package contains no loadable Pi extension.');
    throw failed();
  }
  finally {
    abort(); clearTimeout(timer);
    await dockerCommand(['rm', '--force', name], 10_000);
  }
}
