// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { db } from '@/lib/db';
import { approveResourceMarketRelease, installMarketRelease, publishPiPackageRelease, updateMarketInstall } from '@/lib/market/resources';
import { createAgent, updateAgent } from '@/lib/agents/mutations';
import { resolveAgentPiPackages } from '@/lib/agents/resolve';
import { AGENT_PI_PACKAGES_INCLUDE } from '@/lib/agents/queries';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type * as ChildProcess from 'node:child_process';
import type * as DnsPromises from 'node:dns/promises';
import type * as Https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { checkPiPackageUpdates, createPiPackageSource, listPiPackageSourceEntries, publishPiPackageToRegistry } from '@/lib/market/pi-package-catalog';
import type * as Net from 'node:net';

const routing = vi.hoisted(() => ({ port: 0, ca: '', image: '', active: false, stage: 'unknown', dnsHosts: [] as string[] }));
vi.mock('node:dns/promises', async (original) => {
  const actual = await original<typeof DnsPromises>();
  const lookup = (...args: Parameters<typeof actual.lookup>) => {
    if (!routing.active) return actual.lookup(...args);
    const host = String(args[0]);
    routing.dnsHosts.push(host);
    const addresses = host === 'localhost' ? ['127.0.0.1']
      : host === 'private.fixture' ? ['10.1.2.3']
        : host === 'metadata.fixture' ? ['169.254.169.254']
          : host === 'mixed.fixture' ? ['93.184.216.34', '192.168.0.1'] : ['93.184.216.34'];
    return Promise.resolve(addresses.map((address) => ({ address, family: 4 })));
  };
  return { ...actual, lookup, default: { ...actual, lookup } };
});
vi.mock('node:net', async (original) => {
  const actual = await original<typeof Net>();
  const createConnection = (options: Net.NetConnectOpts) => routing.active && 'port' in options && options.port === 443
    ? actual.createConnection({ host: '127.0.0.1', port: routing.port }) : actual.createConnection(options);
  return { ...actual, createConnection, default: { ...actual, createConnection } };
});
vi.mock('node:https', async original => {
  const actual = await original<typeof Https>();
  const request = (url: URL, options: Https.RequestOptions, callback: (response: IncomingMessage) => void) => actual.request(url, routing.active ? {
    ...options, hostname: '127.0.0.1', port: routing.port, servername: url.hostname, ca: routing.ca,
    headers: { ...options.headers, host: url.host },
  } : options, callback);
  // Only the test transport routes validated public destinations to the local TLS fixture.
  return { ...actual, request, default: { ...actual, request } };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  const spawn = (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
    const rewritten = [...args];
    if (routing.active && command === 'docker') {
      const index = rewritten.indexOf('toolplane-pi-package-capture:0.87.1');
      if (index >= 0) rewritten.splice(index, 1, ...(args[0] === 'run' ? ['-e', 'NODE_EXTRA_CA_CERTS=/fixture-ca.pem', '-e', 'GIT_SSL_CAINFO=/fixture-ca.pem'] : []), routing.image);
    }
    const child = actual.spawn(command, rewritten, options);
    child.stderr?.on('data', (chunk: Buffer) => {
      const stage = /Package capture failed at ([a-z]+)\./.exec(chunk.toString());
      if (stage) routing.stage = stage[1];
    });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});
import { execFile, spawn } from 'node:child_process';
import { capturePiPackage } from '@/lib/market/pi-package-source';

const exec = promisify(execFile);
let directory = '';
let server: Server;
const fixtureName = '@toolplane-fixture/root';
const dependencyName = '@toolplane-fixture/runtime';
const files: Record<string, Buffer> = {};
const metadata: Record<string, unknown> = {};
const redirects: Record<string, string> = {};
const credentialRequests: Array<{ host: string; path: string; authorization?: string }> = [];
const publications: Array<{ path: string; document: Record<string, unknown> }> = [];
async function tar(name: string, packageJson: object, extra: Record<string, string>) {
  const result = await exec('python3', ['-c', 'import io,json,sys,tarfile,base64\nf=json.loads(sys.argv[1]); b=io.BytesIO()\nwith tarfile.open(fileobj=b,mode="w:gz") as t:\n for p,s in f.items():\n  d=s.encode(); i=tarfile.TarInfo("package/"+p); i.size=len(d); t.addfile(i,io.BytesIO(d))\nprint(base64.b64encode(b.getvalue()).decode())', JSON.stringify({ 'package.json': JSON.stringify(packageJson), ...extra })]);
  const bytes = Buffer.from(result.stdout.trim(), 'base64');
  const tarballPath = `/${name.split('/').at(-1)}.tgz`;
  files[tarballPath] = bytes;
  const value = { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...packageJson, dist: { tarball: `https://registry.npmjs.org${tarballPath}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } } };
  metadata[name] = value;
  return value;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'toolplane-capture-ca-'));
  routing.image = `toolplane-capture-fixture:${randomUUID()}`;
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.pem'), '-days', '1', '-subj', '/CN=ToolPlane capture fixture CA']);
  await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr'), '-subj', '/CN=registry.npmjs.org']);
  await writeFile(join(directory, 'extensions.cnf'), 'subjectAltName=DNS:registry.npmjs.org,DNS:downloads.fixture\nextendedKeyUsage=serverAuth\n');
  await exec('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.pem'), '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-out', join(directory, 'server.pem'), '-days', '1', '-extfile', join(directory, 'extensions.cnf')]);
  await writeFile(join(directory, 'Dockerfile'), 'FROM toolplane-pi-package-capture:0.87.1\nCOPY ca.pem /fixture-ca.pem\n');
  await exec('docker', ['build', '-t', routing.image, directory], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  routing.ca = await readFile(join(directory, 'ca.pem'), 'utf8');
  const marker = `node -e "require('node:fs').writeFileSync('UNREVIEWED_SCRIPT_RAN','bad')"`;
  await tar(dependencyName, { name: dependencyName, version: '1.0.0', main: 'index.js', scripts: { postinstall: marker } }, { 'index.js': 'exports.value = "V1 dependency";\n' });
  await tar(fixtureName, { name: fixtureName, version: '1.0.0', pi: { extensions: ['index.ts'] }, dependencies: { [dependencyName]: '1.0.0' }, scripts: { prepare: marker, install: marker, postinstall: marker } }, {
    'index.ts': 'import {value} from "@toolplane-fixture/runtime"; import {writeFileSync} from "node:fs"; export default function(pi) {writeFileSync("UNREVIEWED_FACTORY_RAN",value);}\n',
    '.pnpmfile.cjs': 'require("node:fs").writeFileSync("UNREVIEWED_PNPMFILE_RAN","bad"); module.exports={};\n',
    '.npmrc': 'registry=http://127.0.0.1:1\n',
  });
  server = createServer({ key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.pem')) }, async (request, response) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0]);
    credentialRequests.push({ host: request.headers.host ?? '', path, authorization: request.headers.authorization });
    if ((path.startsWith('/private/') || path.startsWith('/publishing/')) && request.headers.authorization !== 'Bearer fixture-private-token') { response.writeHead(401); response.end(); return; }
    if (request.method === 'PUT' && path.startsWith('/publishing/')) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        publications.push({ path, document }); metadata[path.slice(1)] = document;
        response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true }));
      } catch { response.writeHead(400); response.end(); }
      return;
    }
    if (redirects[path]) { response.writeHead(302, { location: redirects[path] }); response.end(); return; }
    if (path === '/private/git.git/info/refs' || path === '/private/git.git/git-upload-pack') {
      const advertise = path.endsWith('/info/refs');
      response.setHeader('content-type', advertise ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result');
      if (advertise) response.write('001e# service=git-upload-pack\n0000');
      const child = spawn('git', ['upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), join(directory, 'git-source')], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); child.once('error', () => response.destroy());
      child.stdout.pipe(response);
      if (advertise) child.stdin.end(); else request.pipe(child.stdin);
      child.stdin.on('error', () => response.destroy());
      response.once('close', () => child.kill('SIGKILL'));
      return;
    }
    if (files[path]) { response.end(files[path]); return; }
    const value = metadata[path.slice(1)];
    if (!value) { response.writeHead(404); response.end('{}'); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture TLS server failed');
  routing.port = address.port; routing.active = true;
}, 150_000);
afterAll(async () => {
  routing.active = false;
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (routing.image) await exec('docker', ['image', 'rm', routing.image]).catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('captures private resource-only packages without sending credentials to an unrelated dependency host', async () => {
  const name = '@toolplane-fixture/private-root';
  const dep = '@toolplane-fixture/private-runtime';
  const rootMetadata = await tar(name, { name, version: '1.0.0', pi: { prompts: ['prompts/review.md'] }, dependencies: { [dep]: '1.0.0' } }, { 'prompts/review.md': 'Review the frozen source carefully.\n' });
  const dependencyMetadata = await tar(dep, { name: dep, version: '1.0.0', main: 'index.js' }, { 'index.js': 'exports.value="private dependency";' });
  dependencyMetadata.versions['1.0.0'].dist.tarball = 'https://downloads.fixture/private-runtime.tgz';
  metadata[`private/${name}`] = rootMetadata;
  metadata[`private/${dep}`] = dependencyMetadata;
  files['/private/root.tgz'] = files['/private-root.tgz'];
  rootMetadata.versions['1.0.0'].dist.tarball = 'https://registry.npmjs.org/private/root.tgz';
  credentialRequests.length = 0;
  const snapshot = await capturePiPackage(`npm:${name}@1.0.0`, { registry: 'https://registry.npmjs.org/private/', authentication: { url: 'https://registry.npmjs.org/private/', authorization: 'Bearer fixture-private-token' } });
  expect(snapshot.source).toMatchObject({ kind: 'npm', registry: 'https://registry.npmjs.org/private/' });
  expect(snapshot.resources.extensions).toEqual([]);
  expect(snapshot.resources.prompts).toEqual(['package/prompts/review.md']);
  const dependency = snapshot.entries.find(entry => entry.path === `package/node_modules/${dep}/index.js`);
  expect(dependency?.type === 'file' && Buffer.from(dependency.content, 'base64').toString()).toBe('exports.value="private dependency";');
  expect(credentialRequests.filter(item => item.path.startsWith('/private/')).every(item => item.authorization === 'Bearer fixture-private-token')).toBe(true);
  expect(credentialRequests.find(item => item.path === '/private-runtime.tgz')).toEqual({ host: 'downloads.fixture', path: '/private-runtime.tgz', authorization: undefined });
  expect(JSON.stringify(snapshot)).not.toContain('fixture-private-token');
}, 310_000);

it('captures authenticated Git by exact repository scope without embedding its secret', async () => {
  const repo = join(directory, 'git-source');
  await exec('git', ['init', '--initial-branch=main', repo]);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'private-git-fixture', version: '1.0.0', pi: { extensions: ['index.ts'] } }));
  await writeFile(join(repo, 'index.ts'), 'export default function() {}');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const commit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  credentialRequests.length = 0;
  const url = 'https://registry.npmjs.org/private/git.git';
  const snapshot = await capturePiPackage(url + '#main', { authentication: { url, authorization: 'Bearer fixture-private-token' } });
  expect(snapshot.source).toMatchObject({ kind: 'git', url, commit });
  expect(credentialRequests.find(item => item.path === '/private/git.git/info/refs')).toEqual({ host: 'registry.npmjs.org', path: '/private/git.git/info/refs', authorization: 'Bearer fixture-private-token' });
  expect(credentialRequests.filter(item => !item.path.startsWith('/private/git.git/')).every(item => item.authorization === undefined)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('fixture-private-token');
}, 310_000);


it('rejects an authenticated redirect before contacting its credential sink', async () => {
  const name = '@toolplane-fixture/private-redirect';
  redirects[`/private/${name}`] = 'https://downloads.fixture/credential-sink';
  credentialRequests.length = 0;
  await expect(capturePiPackage(`npm:${name}@1.0.0`, { registry: 'https://registry.npmjs.org/private/', authentication: { url: 'https://registry.npmjs.org/private/', authorization: 'Bearer fixture-private-token' } })).rejects.toMatchObject({ code: 'package_capture_failed' });
  expect(credentialRequests.some(item => item.path === '/credential-sink')).toBe(false);
}, 310_000);

it('discovers private catalogs, explicitly publishes an approved npm artifact, and only notifies about upstream changes', async () => {
  const database = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/acceptance|test|disposable/.test(database.pathname)) throw new Error('Disposable database required');
  const stamp = randomUUID();
  const user = await db.user.create({ data: { email: `${stamp}@source.invalid`, passwordHash: 'fixture', role: 'admin' } });
  const outsider = await db.user.create({ data: { email: `${stamp}@outsider.invalid`, passwordHash: 'fixture' } });
  const workspace = await db.workspace.create({ data: { ownerId: user.id, slug: stamp, name: 'Private source fixture', members: { create: { userId: user.id, role: 'owner' } } } });
  const category = await db.category.create({ data: { slug: stamp, name: 'Source fixture' } });
  const access = { workspaceId: workspace.id, userId: user.id };
  const name = '@toolplane-fixture/private-prompt';
  const token = 'fixture-private-token';
  publications.length = 0;
  try {
    const original = await tar(name, { name, version: '1.0.0', pi: { prompts: ['prompts/review.md'] } }, { 'prompts/review.md': 'Frozen approved prompt V1.\n' });
    metadata[`private/${name}`] = original;
    files['/private/prompt.tgz'] = files['/private-prompt.tgz'];
    original.versions['1.0.0'].dist.tarball = 'https://registry.npmjs.org/private/prompt.tgz';
    metadata['private/catalog'] = { schemaVersion: 1, entries: [{ name: 'Private prompt', source: `npm:${name}@latest`, description: 'Reviewed prompts', version: '1.0.0' }], hasMore: false };
    metadata['private/-/v1/search'] = { objects: [{ package: { name, version: '1.0.0', description: 'Reviewed prompts' } }], total: 1 };
    const registry = await createPiPackageSource({ ...access, name: 'Private registry', kind: 'npm', url: 'https://registry.npmjs.org/private/', credentials: { type: 'bearer', token } });
    const catalog = await createPiPackageSource({ ...access, name: 'Private catalog', kind: 'catalog', url: 'https://registry.npmjs.org/private/catalog', credentials: { type: 'bearer', token } });
    const destination = await createPiPackageSource({ ...access, name: 'Publish destination', kind: 'npm', url: 'https://registry.npmjs.org/publishing/', credentials: { type: 'bearer', token } });
    expect(JSON.stringify([registry, catalog, destination])).not.toContain(token);
    const stored = await db.piPackageSource.findUniqueOrThrow({ where: { id: registry.id } });
    expect(stored.credentialsEnc).not.toContain(token);
    expect(await listPiPackageSourceEntries({ ...access, sourceId: catalog.id })).toEqual({ page: 1, hasMore: false, entries: [{ name: 'Private prompt', source: `npm:${name}@latest`, description: 'Reviewed prompts', version: '1.0.0' }] });
    expect((await listPiPackageSourceEntries({ ...access, sourceId: registry.id })).entries).toEqual([{ name, source: `npm:${name}`, description: 'Reviewed prompts', version: '1.0.0' }]);
    await expect(listPiPackageSourceEntries({ ...access, userId: outsider.id, sourceId: catalog.id })).rejects.toMatchObject({ code: 'not_authorized' });
    const wrongCredentials = await createPiPackageSource({ ...access, name: 'Rejected credentials', kind: 'catalog', url: 'https://registry.npmjs.org/private/catalog', credentials: { type: 'bearer', token: 'incorrect-token' } });
    await expect(listPiPackageSourceEntries({ ...access, sourceId: wrongCredentials.id })).rejects.toMatchObject({ code: 'source_auth_failed' });

    const published = await publishPiPackageRelease({ workspaceId: workspace.id, publishedById: user.id, sourceId: registry.id, source: `npm:${name}@latest`, categoryIds: [category.id], listing: { slug: 'private-prompt', name: 'Private prompt' } });
    await expect(publishPiPackageToRegistry({ ...access, sourceId: destination.id, releaseId: published.release.id, confirm: true })).rejects.toMatchObject({ code: 'release_not_found' });
    await approveResourceMarketRelease({ listingId: published.listing.id, releaseId: published.release.id, reviewedById: user.id });
    const installed = await installMarketRelease({ releaseId: published.release.id, targetWorkspaceId: workspace.id, installedById: user.id, idempotencyKey: stamp });
    expect(publications).toEqual([]);
    await expect(publishPiPackageToRegistry({ ...access, userId: outsider.id, sourceId: destination.id, releaseId: published.release.id, confirm: true })).rejects.toMatchObject({ code: 'not_authorized' });
    expect(publications).toEqual([]);
    const result = await publishPiPackageToRegistry({ ...access, sourceId: destination.id, releaseId: published.release.id, confirm: true });
    expect(result).toMatchObject({ name, version: '1.0.0', registry: destination.url });
    expect(publications).toHaveLength(1);
    expect(publications[0].path).toBe(`/publishing/${name}`);
    const document = publications[0].document;
    const attachments = document._attachments as Record<string, { data: string }>;
    const archive = Buffer.from(attachments['private-prompt-1.0.0.tgz'].data, 'base64');
    expect(gunzipSync(archive).includes(Buffer.from('Frozen approved prompt V1.\n'))).toBe(true);
    expect(result.integrity).toBe(`sha512-${createHash('sha512').update(archive).digest('base64')}`);
    const unpacked = JSON.parse((await exec('python3', ['-c', 'import base64,io,json,sys,tarfile\nwith tarfile.open(fileobj=io.BytesIO(base64.b64decode(sys.argv[1])),mode="r:gz") as t:\n print(json.dumps({"manifest":json.load(t.extractfile("package/package.json")),"prompt":t.extractfile("package/prompts/review.md").read().decode()}))', archive.toString('base64')])).stdout);
    expect(unpacked).toEqual({ manifest: { name, version: '1.0.0', pi: { prompts: ['prompts/review.md'] } }, prompt: 'Frozen approved prompt V1.\n' });
    expect(JSON.stringify(document)).not.toContain(token);
    await expect(publishPiPackageToRegistry({ ...access, sourceId: destination.id, releaseId: published.release.id, confirm: true })).rejects.toMatchObject({ code: 'registry_version_conflict' });
    expect(publications).toHaveLength(1);

    const next = await tar(`${name}-next`, { name, version: '2.0.0', pi: { prompts: ['prompts/review.md'] } }, { 'prompts/review.md': 'Unapplied upstream V2.\n' });
    metadata[`private/${name}`] = { name, 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': original.versions['1.0.0'], '2.0.0': next.versions['1.0.0'] } };
    credentialRequests.length = 0;
    const updates = await checkPiPackageUpdates({ ...access, listingId: published.listing.id });
    expect(updates).toMatchObject([{ listingId: published.listing.id, mode: 'subscribed', status: 'update_available', latestVersion: '2.0.0' }]);
    expect(credentialRequests.map(item => item.path)).toEqual([`/private/${name}`]);
    expect(await db.marketInstall.findUniqueOrThrow({ where: { id: installed.install.id } })).toMatchObject({ currentReleaseId: published.release.id, requestedReleaseId: published.release.id });
    expect(await db.marketRelease.count({ where: { listingId: published.listing.id } })).toBe(1);
    expect(publications).toHaveLength(1);
  } finally {
    await db.marketInstall.deleteMany({ where: { targetWorkspaceId: workspace.id } });
    await db.marketListing.updateMany({ where: { publisherWorkspaceId: workspace.id }, data: { latestReleaseId: null, pendingReleaseId: null } });
    await db.marketRelease.deleteMany({ where: { listing: { publisherWorkspaceId: workspace.id } } });
    await db.marketListing.deleteMany({ where: { publisherWorkspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.category.delete({ where: { id: category.id } });
    await db.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
  }
}, 310_000);

it('uses real pnpm and frozen dependency bytes without executing source factories, lifecycle scripts or pnpmfile', async () => {
  const snapshot = await capturePiPackage(`npm:${fixtureName}@1.0.0`).catch(() => { throw new Error(`Fixture capture failed at ${routing.stage}`); });
  expect(snapshot.source).toMatchObject({ kind: 'npm', name: fixtureName, version: '1.0.0' });
  expect(snapshot.resources.extensions).toEqual(['package/index.ts']);
  expect(snapshot.entries.some((entry) => /UNREVIEWED_.*_RAN/.test(entry.path))).toBe(false);
  const dependency = snapshot.entries.find((entry) => entry.path === `package/node_modules/${dependencyName}/index.js`);
  if (!dependency || dependency.type !== 'file') throw new Error('Missing actual runtime dependency');
  expect(Buffer.from(dependency.content, 'base64').toString()).toBe('exports.value = "V1 dependency";\n');
  const sourceManifest = snapshot.entries.find((entry) => entry.path === 'package/package.json');
  if (!sourceManifest || sourceManifest.type !== 'file') throw new Error('Missing original source manifest');
  expect(JSON.parse(Buffer.from(sourceManifest.content, 'base64').toString()).scripts.postinstall).toContain('UNREVIEWED_SCRIPT_RAN');
}, 310_000);
it.each(['localhost', 'private.fixture', 'metadata.fixture', 'mixed.fixture'])('blocks malicious root redirects and transitive dependency downloads to %s', async (host) => {
  const sourceName = `${fixtureName}-${host.replaceAll('.', '-')}`;
  const value = await tar(sourceName, { name: sourceName, version: '1.0.0', pi: { extensions: ['index.ts'] } }, { 'index.ts': 'export default function() {}\n' });
  const validTarball = value.versions['1.0.0'].dist.tarball;
  const redirect = `/redirect-${host}`;
  redirects[redirect] = `https://${host}/runtime.tgz`;
  value.versions['1.0.0'].dist.tarball = `https://registry.npmjs.org${redirect}`;
  routing.dnsHosts.length = 0;
  await expect(capturePiPackage(`npm:${sourceName}@1.0.0`)).rejects.toMatchObject({ code: 'package_capture_failed' });
  expect(routing.dnsHosts).toContain(host);
  value.versions['1.0.0'].dist.tarball = validTarball;
  await tar(sourceName, { name: sourceName, version: '1.0.0', pi: { extensions: ['index.ts'] }, dependencies: { [dependencyName]: `https://${host}/runtime.tgz` } }, { 'index.ts': 'export default function() {}\n' });
  routing.dnsHosts.length = 0;
  await expect(capturePiPackage(`npm:${sourceName}@1.0.0`)).rejects.toMatchObject({ code: 'package_capture_failed' });
  expect(routing.dnsHosts).toContain(host);
}, 310_000);

it('rejects registry integrity tampering before producing a snapshot', async () => {
  const name = `${fixtureName}-integrity`;
  const value = await tar(name, { name, version: '1.0.0', pi: { extensions: ['index.ts'] } }, { 'index.ts': 'export default function() {}\n' });
  value.versions['1.0.0'].dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await expect(capturePiPackage(`npm:${name}@1.0.0`)).rejects.toMatchObject({ code: 'package_capture_failed' });
}, 310_000);

it('preserves bundled dependency bytes rather than resolving them from the registry', async () => {
  const name = `${fixtureName}-bundled`;
  await tar(name, { name, version: '1.0.0', pi: { extensions: ['index.ts'] }, dependencies: { [dependencyName]: '1.0.0' }, bundledDependencies: [dependencyName] }, {
    'index.ts': 'export default function() {}\n',
    [`node_modules/${dependencyName}/package.json`]: JSON.stringify({ name: dependencyName, version: '1.0.0', main: 'index.js' }),
    [`node_modules/${dependencyName}/index.js`]: 'exports.value = "bundled original";\n',
  });
  routing.dnsHosts.length = 0;
  const snapshot = await capturePiPackage(`npm:${name}@1.0.0`);
  const entry = snapshot.entries.find((entry) => entry.path === `package/node_modules/${dependencyName}/index.js`);
  if (!entry || entry.type !== 'file') throw new Error('Missing original bundled dependency');
  expect(Buffer.from(entry.content, 'base64').toString()).toBe('exports.value = "bundled original";\n');
}, 310_000);

it('rejects different installed bytes conflicting with a bundled dependency', async () => {
  const transitive = `${dependencyName}-transitive`;
  await tar(transitive, { name: transitive, version: '1.0.0', dependencies: { [dependencyName]: '1.0.0' } }, { 'index.js': 'module.exports = require("@toolplane-fixture/runtime");\n' });
  const name = `${fixtureName}-bundle-conflict`;
  await tar(name, { name, version: '1.0.0', pi: { extensions: ['index.ts'] }, dependencies: { [transitive]: '1.0.0', [dependencyName]: '1.0.0' }, bundledDependencies: [dependencyName] }, {
    'index.ts': 'export default function() {}\n',
    [`node_modules/${dependencyName}/package.json`]: JSON.stringify({ name: dependencyName, version: '1.0.0' }),
    [`node_modules/${dependencyName}/index.js`]: 'exports.value = "bundled original";\n',
  });
  await expect(capturePiPackage(`npm:${name}@1.0.0`)).rejects.toMatchObject({ code: 'package_capture_failed' });
}, 310_000);

it.each(['index.ts', 'worker.ts', 'example/index.ts', 'extensions/example/index.ts'])('freezes official convention entry %s without evaluating its factory', async (entryPath) => {
  const name = `${fixtureName}-convention-${entryPath.replace(/[^a-z0-9-]/g, '-')}`;
  await tar(name, { name, version: '1.0.0' }, {
    [entryPath]: 'import {writeFileSync} from "node:fs"; export default function() {writeFileSync("UNREVIEWED_FACTORY_RAN","bad");}\n',
  });
  const snapshot = await capturePiPackage(`npm:${name}@1.0.0`);
  expect(snapshot.resources.extensions).toEqual([`package/${entryPath}`]);
  expect(snapshot.entries.some((entry) => entry.path.endsWith('UNREVIEWED_FACTORY_RAN'))).toBe(false);
}, 310_000);

it('runs approved immutable V1 in Linux SDK, reconnects, and requires explicit Agent application of V2', async () => {
  const database = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/acceptance|test|disposable/.test(database.pathname)) throw new Error('Disposable database required');
  const { spawn } = await vi.importActual<typeof ChildProcess>('node:child_process');
  const stamp = randomUUID(), container = `pi-sdk-market-smoke-${stamp}`;
  const name = `${fixtureName}-runtime`;
  const user = await db.user.create({ data: { email: `${stamp}@smoke.invalid`, passwordHash: 'fixture', role: 'admin' } });
  const workspace = await db.workspace.create({ data: { ownerId: user.id, slug: stamp, name: 'Frozen SDK smoke', members: { create: { userId: user.id, role: 'owner' } } } });
  const category = await db.category.create({ data: { slug: stamp, name: 'SDK smoke' } });
  let host: ChildProcess.ChildProcess | undefined;
  const model = createHttpServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the actual SDK request. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [{ delta: { role: 'assistant', content: 'PERSISTED' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'controlled', choices: [{ index: 0, ...part }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done => model.listen(0, '0.0.0.0', done));
  const listener = model.address(); if (!listener || typeof listener === 'string') throw new Error('Missing fixture listener');
  const address = { port: listener.port };
  try {
    await tar(dependencyName, { name: dependencyName, version: '1.0.0', main: 'index.js' }, { 'index.js': "exports.value='DEPENDENCY_V1';" });
    const extension = `import {value} from '${dependencyName}';import {readFileSync,writeFileSync,existsSync} from 'node:fs';export default pi=>pi.registerCommand('Count',{handler:async(_,ctx)=>{const p=ctx.cwd+'/count';const n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(n));pi.sendMessage({customType:'fixture',content:'dependency='+value+' count='+n,display:true});}});`;
    await tar(name, { name, version: '1.0.0', pi: { extensions: ['./index.ts'] }, dependencies: { [dependencyName]: '1.0.0' } }, { 'index.ts': extension });
    const published = await publishPiPackageRelease({ workspaceId: workspace.id, publishedById: user.id, source: `npm:${name}@1.0.0`, categoryIds: [category.id], listing: { slug: 'runtime', name: 'Frozen runtime' } });
    await approveResourceMarketRelease({ listingId: published.listing.id, releaseId: published.release.id, reviewedById: user.id });
    const installed = await installMarketRelease({ releaseId: published.release.id, targetWorkspaceId: workspace.id, installedById: user.id, idempotencyKey: stamp });
    const agent = await createAgent(workspace.id, 'Frozen SDK', { runtime: 'pi-sdk', piPackages: [{ marketInstallId: installed.install.id, releaseId: published.release.id }] });
    async function packages() {
      return resolveAgentPiPackages(await db.agent.findUniqueOrThrow({ where: { id: agent.id }, include: { piPackages: AGENT_PI_PACKAGES_INCLUDE } }));
    }
    await exec('docker', ['run', '-d', '--name', container, '--add-host=host.docker.internal:host-gateway', '--entrypoint', 'sleep', 'toolplane-pi-package-capture:0.87.1', 'infinity']);
    for (const file of ['pi-sdk-session.mjs', 'pi-sdk-package-files.mjs']) await exec('docker', ['cp', `scripts/${file}`, `${container}:/tmp/${file}`]);
    const write = async (path: string, content: string) => {
      const child = spawn('docker', ['exec', '-i', container, 'node', '-e', 'require("fs").writeFileSync(process.argv[1],require("fs").readFileSync(0))', path], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin!.end(content); const [code] = await once(child, 'close'); expect(code).toBe(0);
    };
    await exec('docker', ['exec', container, 'mkdir', '-p', '/tmp/workspace', '/tmp/private', '/tmp/sessions']);
    await write('/tmp/private/mcp.mjs', 'export async function createPiMcpTools(){return []}');
    async function configure(session: string) {
      const selected = await packages();
      const descriptors = selected.map(item => ({ ...item, root: `/tmp/private/packages/${item.checksum}`, manifestPath: `/tmp/private/${item.checksum}.json` }));
      await write('/tmp/private/packages.json', JSON.stringify(descriptors));
      await exec('docker', ['exec', container, 'sh', '-c', 'node /tmp/pi-sdk-package-files.mjs materialize < /tmp/private/packages.json']);
      const paths = descriptors.flatMap(item => item.manifest.package.resources.extensions.map(path => `${item.root}/${path}`));
      await write('/tmp/private/config.json', JSON.stringify({ sdkVersion: '0.87.1', packageRoot: '/opt/pi-sdk', cwd: '/tmp/workspace', agentDir: '/tmp/private', sessionsDir: `/tmp/sessions/${session}`, statePath: `/tmp/private/${session}.json`, packageSetChecksum: createHash('sha256').update(JSON.stringify(selected.map(({ marketInstallId, releaseId, checksum }) => ({ marketInstallId, releaseId, checksum })))).digest('hex'), model: { id: 'controlled', name: 'Controlled', provider: 'toolplane', api: 'openai-completions', baseUrl: `http://host.docker.internal:${address.port}/v1`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, systemPrompt: 'Fixture', defaultTools: [], resources: { extensions: paths, skills: [], prompts: [], themes: [] }, packages: descriptors.map(({ manifest: _manifest, ...item }) => item), packageVerifierPath: '/tmp/pi-sdk-package-files.mjs', mcpFactoryPath: '/tmp/private/mcp.mjs', hostOnlyCommands: [] }));
      await exec('docker', ['exec', container, 'mkdir', '-p', `/tmp/sessions/${session}`]);
    }
    type Response = { success: boolean; result?: { text: string; state: { sessionFile: string; sessionPersisted: boolean } }; error?: { code: string } };
    const pending = new Map<string, (response: Response) => void>();
    function launch() {
      host = spawn('docker', ['exec', '-i', container, 'node', '-e', `const c=require('child_process').spawn('node',['/tmp/pi-sdk-session.mjs','/tmp/private/config.json'],{stdio:['pipe','ignore','inherit','pipe']});process.stdin.pipe(c.stdin);c.stdio[3].pipe(process.stdout);process.stdin.on('end',()=>c.kill());process.on('SIGTERM',()=>c.kill());`], { stdio: ['pipe', 'pipe', 'pipe'] });
      createInterface({ input: host.stdout! }).on('line', line => { const event = JSON.parse(line); if (event.type === 'toolplane_sdk_response') pending.get(event.id)?.(event); });
    }
    async function prompt(message: string) {
      const id = randomUUID(), result = new Promise<Response>(done => pending.set(id, done));
      host!.stdin!.write(JSON.stringify({ id, type: 'prompt', message, context: { runtimeToken: 'fixture-only', mcpConfig: { servers: [] } } }) + '\n');
      return result;
    }
    async function stop() { if (host && host.exitCode === null) { const ended = once(host, 'close'); host.stdin!.end(); await ended; } }
    await configure('original'); launch();
    expect(await prompt('/Count')).toMatchObject({ success: true, result: { text: 'Pi 扩展 · fixture\ndependency=DEPENDENCY_V1 count=1' } });
    const persisted = await prompt('Persist this session.');
    expect(persisted).toMatchObject({ success: true, result: { state: { sessionPersisted: true } } });
    await stop(); launch();
    expect(await prompt('/Count')).toMatchObject({ success: true, result: { text: 'Pi 扩展 · fixture\ndependency=DEPENDENCY_V1 count=2', state: { sessionFile: persisted.result!.state.sessionFile } } });
    await tar(dependencyName, { name: dependencyName, version: '1.0.0', main: 'index.js' }, { 'index.js': "exports.value='DEPENDENCY_V2';" });
    const v2 = await publishPiPackageRelease({ workspaceId: workspace.id, publishedById: user.id, source: `npm:${name}@1.0.0`, listingId: published.listing.id, categoryIds: [category.id], listing: { slug: 'runtime', name: 'Frozen runtime' } });
    await approveResourceMarketRelease({ listingId: v2.listing.id, releaseId: v2.release.id, reviewedById: user.id });
    await updateMarketInstall({ installId: installed.install.id, targetWorkspaceId: workspace.id, actorId: user.id, targetReleaseId: v2.release.id, currentReleaseId: published.release.id });
    expect((await packages())[0].releaseId).toBe(published.release.id);
    expect(await prompt('/Count')).toMatchObject({ success: true, result: { text: 'Pi 扩展 · fixture\ndependency=DEPENDENCY_V1 count=3' } });
    await stop();
    await updateAgent(workspace.id, agent.id, { name: agent.name, systemPrompt: null, providerId: null, model: null, maxSteps: 100, piPackages: [{ marketInstallId: installed.install.id, releaseId: v2.release.id }] });
    await configure('original'); launch();
    expect(await prompt('/Count')).toMatchObject({ success: false, error: { code: 'PI_SDK_PACKAGE_SET_CHANGED' } });
    await stop(); await configure('updated'); launch();
    expect(await prompt('/Count')).toMatchObject({ success: true, result: { text: 'Pi 扩展 · fixture\ndependency=DEPENDENCY_V2 count=4' } });
    console.log(JSON.stringify({ smoke: 'real-capture-review-install-bind-linux-sdk-reconnect-explicit-upgrade', v1: published.release.checksum, v2: v2.release.checksum, count: 4, persisted: persisted.result!.state.sessionPersisted }));
  } finally {
    await exec('docker', ['rm', '-f', container]).catch(() => {});
    model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
    await db.agent.deleteMany({ where: { workspaceId: workspace.id } });
    await db.marketInstall.deleteMany({ where: { targetWorkspaceId: workspace.id } });
    await db.marketListing.updateMany({ where: { publisherWorkspaceId: workspace.id }, data: { latestReleaseId: null, pendingReleaseId: null } });
    await db.marketRelease.deleteMany({ where: { listing: { publisherWorkspaceId: workspace.id } } });
    await db.marketListing.deleteMany({ where: { publisherWorkspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.category.delete({ where: { id: category.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}, 310_000);
