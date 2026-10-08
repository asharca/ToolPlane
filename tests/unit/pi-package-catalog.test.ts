import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import { decryptSecretText } from '@/lib/security/secrets';
import type * as PiNetwork from '@/lib/market/pi-package-network';

const mocks = vi.hoisted(() => ({
  workspace: { findFirst: vi.fn() },
  piPackageSource: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  piPackageTracking: { findMany: vi.fn(), updateMany: vi.fn() }, marketRelease: { findFirst: vi.fn() },
  request: vi.fn(), owner: vi.fn(), canOperate: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { ...mocks, $transaction: async (callback: (tx: unknown) => unknown) => callback(mocks) } }));
vi.mock('@/lib/market/skills', () => ({ MarketError: class extends Error { constructor(readonly code: string, message: string) { super(message); } } }));
vi.mock('@/lib/runtime/ownership-state', () => ({ assertRuntimeOwner: mocks.owner, runtimeCanOperate: mocks.canOperate }));
vi.mock('@/lib/market/pi-package-network', async original => {
  const network = await original<typeof PiNetwork>();
  return { ...network, piSourceRequest: mocks.request };
});
import { createPiPackageSource, updatePiPackageSource, listPiPackageSources, resolvePiPackageCaptureSource, listPiPackageSourceEntries,
  listOfficialPiPackages, verifyOfficialPiPackage, checkPiPackageUpdates, maintainPiPackageSources, publishPiPackageToRegistry } from '@/lib/market/pi-package-catalog';

const access = { workspaceId: 'workspace-a', userId: 'owner-a' };
const source = { id: 'source-a', workspaceId: access.workspaceId, kind: 'npm', name: 'Private registry', url: 'https://registry.example/private/', credentialsEnc: null as string | null, createdAt: new Date(0), updatedAt: new Date(0) };
function releaseFixture() {
  const packageJson = JSON.stringify({ name: 'fixture', version: '1.0.0', pi: { extensions: ['index.js'] } });
  const manifest = { schemaVersion: 1, kind: 'pi-package', listing: { slug: 'fixture', name: 'Fixture', summary: null, iconUrl: null, tags: [], author: 'Fixture' }, package: {
    source: { kind: 'npm', requested: 'npm:fixture@latest', name: 'fixture', version: '1.0.0', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }, name: 'fixture', version: '1.0.0', root: 'package',
    runtime: { kind: 'pi-sdk', piVersion: '0.87.1', nodeMajor: 24, platform: 'linux', arch: 'arm64' }, resources: { extensions: ['package/index.js'], skills: [], prompts: [], themes: [] },
    entries: [{ type: 'directory', path: 'package' }, ...[['package/package.json', packageJson], ['package/index.js', 'export default function() {}']].map(([path, body]) => ({ type: 'file', path, contentEncoding: 'base64', content: Buffer.from(body).toString('base64'), executable: false, sha256: createHash('sha256').update(body).digest('hex') }))],
  } };
  return { id: 'release-a', manifest, checksum: marketReleaseChecksum(manifest) };
}
beforeEach(() => {
  vi.clearAllMocks(); source.credentialsEnc = null;
  mocks.owner.mockImplementation(() => undefined); mocks.canOperate.mockReturnValue(true);
  mocks.workspace.findFirst.mockResolvedValue({ id: access.workspaceId });
  mocks.piPackageSource.findFirst.mockResolvedValue(source);
  mocks.piPackageSource.create.mockImplementation(async ({ data }) => ({ ...source, ...data }));
  mocks.piPackageTracking.updateMany.mockResolvedValue({ count: 1 });
});
describe('Pi source authorization and publication', () => {
  it('encrypts credentials and never projects encrypted or plaintext secrets back', async () => {
    const created = await createPiPackageSource({ ...access, name: source.name, kind: 'npm', url: source.url, credentials: { type: 'bearer', token: 'registry-secret' } });
    const stored = mocks.piPackageSource.create.mock.calls[0][0].data.credentialsEnc;
    expect(stored).not.toContain('registry-secret');
    expect(JSON.parse(decryptSecretText(JSON.parse(stored)))).toEqual({ type: 'bearer', token: 'registry-secret' });
    expect(created.hasCredentials).toBe(true);
    source.credentialsEnc = stored; mocks.piPackageSource.findMany.mockResolvedValue([source]);
    const listed = await listPiPackageSources(access);
    expect(JSON.stringify(listed)).not.toContain(stored); expect(JSON.stringify(listed)).not.toContain('registry-secret');
  });
  it('denies non-admin capture credential resolution and publication before network or archive work', async () => {
    mocks.workspace.findFirst.mockResolvedValue(null);
    await expect(resolvePiPackageCaptureSource({ ...access, sourceId: source.id, source: 'npm:fixture' })).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(publishPiPackageToRegistry({ ...access, sourceId: source.id, releaseId: 'release-a', confirm: true })).rejects.toMatchObject({ code: 'not_authorized' });
    expect(mocks.piPackageSource.findFirst).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('cannot read or resolve a source belonging to another workspace', async () => {
    mocks.piPackageSource.findFirst.mockResolvedValue(null);
    await expect(resolvePiPackageCaptureSource({ ...access, sourceId: 'source-b', source: 'npm:fixture' })).rejects.toMatchObject({ code: 'source_not_found' });
    await expect(listPiPackageSourceEntries({ ...access, sourceId: 'source-b' })).rejects.toMatchObject({ code: 'source_not_found' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('requires deliberate credential replacement when changing source authority/path', async () => {
    source.credentialsEnc = 'encrypted-existing-credential';
    await expect(updatePiPackageSource({ ...access, sourceId: source.id, url: 'https://attacker.example/' })).rejects.toMatchObject({ code: 'source_credentials_required' });
    expect(mocks.piPackageSource.update).not.toHaveBeenCalled();
  });
  it('does not forward a catalog credential to discovered package sources', async () => {
    mocks.piPackageSource.findFirst.mockResolvedValue({ ...source, kind: 'catalog', credentialsEnc: 'intentionally-not-decryptable' });
    const options = await resolvePiPackageCaptureSource({ ...access, sourceId: source.id, source: 'npm:fixture' });
    expect(options.authentication).toBeUndefined(); expect(options.registry).toBeUndefined();
  });
  it('limits private Git credentials to the configured repository', async () => {
    mocks.piPackageSource.findFirst.mockResolvedValue({ ...source, kind: 'git', url: 'https://git.example/team/allowed.git' });
    await expect(resolvePiPackageCaptureSource({ ...access, sourceId: source.id, source: 'https://git.example/team/other.git#main' })).rejects.toMatchObject({ code: 'source_scope_mismatch' });
  });
  it('requires an explicit confirmation and never publishes a pending/unowned release', async () => {
    await expect(publishPiPackageToRegistry({ ...access, sourceId: source.id, releaseId: 'release-a', confirm: false as true })).rejects.toMatchObject({ code: 'registry_confirmation_required' });
    await createPiPackageSource({ ...access, name: source.name, kind: 'npm', url: source.url, credentials: { type: 'bearer', token: 'registry-secret' } });
    source.credentialsEnc = mocks.piPackageSource.create.mock.calls[0][0].data.credentialsEnc;
    mocks.marketRelease.findFirst.mockResolvedValue(null);
    await expect(publishPiPackageToRegistry({ ...access, sourceId: source.id, releaseId: 'pending', confirm: true })).rejects.toMatchObject({ code: 'release_not_found' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('uploads an npm-compatible immutable tarball only on the explicit publishing service', async () => {
    await createPiPackageSource({ ...access, name: source.name, kind: 'npm', url: source.url, credentials: { type: 'bearer', token: 'registry-secret' } });
    source.credentialsEnc = mocks.piPackageSource.create.mock.calls[0][0].data.credentialsEnc;
    mocks.marketRelease.findFirst.mockResolvedValue(releaseFixture());
    mocks.request.mockImplementation(async (_url, options) => options.method === 'PUT' ? Buffer.from('{"ok":true}') : Buffer.from('{"name":"fixture","versions":{},"dist-tags":{}}'));
    const result = await publishPiPackageToRegistry({ ...access, sourceId: source.id, releaseId: 'release-a', confirm: true });
    const put = mocks.request.mock.calls.find(([, options]) => options.method === 'PUT')!;
    const uploaded = JSON.parse(put[1].body.toString()); const attachment = uploaded._attachments['fixture-1.0.0.tgz'];
    const archive = Buffer.from(attachment.data, 'base64');
    expect(gunzipSync(archive).includes(Buffer.from('package/package.json'))).toBe(true);
    expect(uploaded.versions['1.0.0'].dist.integrity).toBe('sha512-' + createHash('sha512').update(archive).digest('base64'));
    expect(uploaded['dist-tags'].latest).toBe('1.0.0');
    expect(result.version).toBe('1.0.0'); expect(JSON.stringify(uploaded)).not.toContain('registry-secret');
  });
  it('parses actual official catalog cards without evaluating scripts or inventing entries', async () => {
    mocks.request.mockResolvedValue(Buffer.from('<span class="packages-count">51-51 / 51</span><article data-package-card="true" data-package-name="@scope/fixture"><p class="packages-desc">Tools &amp; skills</p><a href="https://github.com/report?package-version=1.2.3">report</a></article><script>throw Error("never execute")</script>'));
    expect(await listOfficialPiPackages({ page: 2 })).toEqual({ page: 2, hasMore: false, entries: [{ name: '@scope/fixture', source: 'npm:@scope/fixture', description: 'Tools & skills', version: '1.2.3' }] });
  });
  it('uses the canonical first-page URL so the strict transport does not reject an upstream normalization redirect', async () => {
    mocks.request.mockImplementation(async (url: URL) => {
      if (url.searchParams.has('name') || url.searchParams.has('page')) throw new Error('Upstream canonical redirect');
      return Buffer.from('<span class="packages-count">0 / 5467</span>');
    });
    expect(await listOfficialPiPackages()).toEqual({ entries: [], page: 1, hasMore: false });
  });
  it('returns an empty official filtered catalog instead of inventing results from recently published cards', async () => {
    mocks.request.mockResolvedValue(Buffer.from('<span class="packages-count">0 / 5467</span><a data-package-link="true">recent unrelated package</a>'));
    expect(await listOfficialPiPackages({ query: 'absent' })).toEqual({ entries: [], page: 1, hasMore: false });
  });
  it('verifies exact directory membership and selected registry identity, never a matching prefix or moving tag', async () => {
    const card = '<span class="packages-count">1-1 / 1</span><article data-package-card="true" data-package-name="@scope/fixture"><p class="packages-desc">Tools</p></article>';
    const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
    mocks.request.mockImplementation(async (url: URL) => url.hostname === 'pi.dev' ? Buffer.from(card)
      : Buffer.from(JSON.stringify({ name: '@scope/fixture', version: '1.2.3', dist: { integrity } })));
    expect(await verifyOfficialPiPackage('@scope/fixture', '1.2.3')).toMatchObject({ source: 'npm:@scope/fixture', version: '1.2.3', integrity });
    expect(await verifyOfficialPiPackage('@scope/fixture', '')).toMatchObject({ version: '1.2.3', integrity });
    await expect(verifyOfficialPiPackage('@scope/fixture-other', '1.2.3')).rejects.toMatchObject({ code: 'official_package_unavailable' });
    await expect(verifyOfficialPiPackage('@scope/fixture', 'latest')).rejects.toMatchObject({ code: 'official_package_unavailable' });
    await expect(verifyOfficialPiPackage('@scope/fixture', '2.0.0')).rejects.toMatchObject({ code: 'official_package_unavailable' });
  });
  it('stops scheduled checks when runtime ownership is lost and persists only sanitized failures', async () => {
    const row = { id: 'scheduled', workspaceId: access.workspaceId, listingId: 'listing-a', updatedAt: new Date(0), workspace: { ownerId: access.userId } };
    mocks.piPackageTracking.findMany.mockResolvedValue([row]);
    mocks.canOperate.mockReturnValue(false);
    expect(await maintainPiPackageSources()).toBe(0);
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.piPackageTracking.updateMany).not.toHaveBeenCalled();
    mocks.canOperate.mockReturnValue(true); mocks.workspace.findFirst.mockRejectedValue(new Error('private-secret database details'));
    await maintainPiPackageSources();
    expect(mocks.piPackageTracking.updateMany.mock.calls[0][0].data.errorCode).toBe('source_unavailable');
    expect(JSON.stringify(mocks.piPackageTracking.updateMany.mock.calls)).not.toContain('private-secret');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('detects updates and same-version replacement using metadata only, preserving fixed pins', async () => {
    const release = releaseFixture(); const integrity = release.manifest.package.source.integrity;
    const row = { id: 'tracking-a', workspaceId: access.workspaceId, listingId: 'listing-a', sourceId: null, source: null, requested: 'npm:fixture@latest', checkedAt: null, latestIdentity: null, latestVersion: null, ignoredIdentity: null, errorCode: null, updatedAt: new Date(0), listing: { releases: [release] } };
    mocks.piPackageTracking.findMany.mockResolvedValue([row]);
    mocks.piPackageTracking.updateMany.mockImplementation(async ({ data }) => { Object.assign(row, data); return { count: 1 }; });
    const metadata = { 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': { name: 'fixture', version: '1.0.0', dist: { integrity } }, '2.0.0': { name: 'fixture', version: '2.0.0', dist: { integrity: 'sha512-new' } } } };
    mocks.request.mockImplementation(async () => Buffer.from(JSON.stringify(metadata)));
    expect((await checkPiPackageUpdates(access))[0]).toMatchObject({ mode: 'subscribed', status: 'update_available', latestVersion: '2.0.0' });
    metadata.versions['2.0.0'].dist.integrity = 'sha512-replaced';
    expect((await checkPiPackageUpdates(access))[0].status).toBe('suspicious');
    expect((await checkPiPackageUpdates(access))[0].status).toBe('suspicious');
    row.requested = 'npm:fixture@1.0.0';
    expect((await checkPiPackageUpdates(access))[0]).toMatchObject({ mode: 'fixed', status: 'current', latestVersion: '1.0.0' });
    expect(mocks.request.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });
});
