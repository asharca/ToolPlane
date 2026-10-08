// @vitest-environment node
import type { PiPackageClient } from '@/lib/pi-packages/installations';
import type { PiPackageManifestV1 } from '@/lib/market/pi-package-manifest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/db';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import { piPackageMcpAdapterSource } from '@/lib/pi-packages/adapter';
import { createPiPackageClientInstallation, updatePiPackageClientInstallation, revokePiPackageClientInstallation, listPiPackageClientInstallations, authenticatePiPackageInstallation } from '@/lib/pi-packages/installations';
import { piPackageToolName } from '@/lib/pi-packages/gateway';
import { verifyApiTokenContext } from '@/lib/auth/tokens';
import { GET as manifestRoute } from '@/app/api/v1/pi-packages/installations/[id]/manifest/route';
import { GET as artifactRoute } from '@/app/api/v1/pi-packages/installations/[id]/artifact/route';
import { POST as gatewayRoute } from '@/app/api/v1/pi-packages/installations/[id]/mcp/route';
import { DELETE as revokeRoute } from '@/app/api/v1/pi-packages/installations/[id]/revoke/route';

// Only supervisor process discovery is substituted. Database auth, MCP transport,
// tool persistence, device endpoints, installer, and official Pi loader are real.
const runtime = vi.hoisted(() => ({ port: 0 }));
vi.mock('@/lib/process/supervisor', () => ({
  livePort: () => runtime.port, liveStatus: () => 'running',
  liveRedactionValues: () => [],
  liveMcpRuntimeSnapshot: () => ({ port: runtime.port, generation: 'fixture', redactionValues: [] }),
}));
const stamp = `${process.pid}-${Date.now()}`;
let userId = '', memberId = '', outsiderId = '', workspaceId = '', foreignWorkspaceId = '', deploymentId = '', listingId = '', releaseId = '', marketInstallId = '', origin = '';
let calls = 0, sequence = 0;
const homes: string[] = [];
const upstream = createServer((request, response) => {
  void (async () => {
    let text = ''; for await (const chunk of request) text += String(chunk);
    const rpc = JSON.parse(text);
    const result = rpc.method === 'tools/list' ? { tools: ['echo', 'write', 'unselected'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })) }
      : { content: [{ type: 'text', text: `${++calls}:${rpc.params.arguments.text}` }] };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  })().catch(() => { response.statusCode = 500; response.end(); });
});
const service = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url!, origin);
    const match = /^\/api\/v1\/pi-packages\/installations\/([^/]+)\/(manifest|artifact|mcp|revoke)$/.exec(url.pathname);
    if (!match) { response.statusCode = 404; response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const req = new Request(url, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const context = { params: Promise.resolve({ id: match[1] }) };
    const result = match[2] === 'manifest' ? await manifestRoute(req, context) : match[2] === 'artifact' ? await artifactRoute(req, context) : match[2] === 'revoke' ? await revokeRoute(req, context) : await gatewayRoute(req, context);
    response.statusCode = result.status; result.headers.forEach((value, key) => response.setHeader(key, value)); response.end(Buffer.from(await result.arrayBuffer()));
  })().catch(() => { response.statusCode = 500; response.end(); });
});
function manifest(version = '1.0.0'): PiPackageManifestV1 {
  const file = (path: string, text: string) => ({ type: 'file' as const, path, contentEncoding: 'base64' as const, content: Buffer.from(text).toString('base64'), executable: false, sha256: createHash('sha256').update(text).digest('hex') });
  return { schemaVersion: 1, kind: 'pi-package', listing: { slug: 'device-fixture', name: 'Device fixture', summary: null, iconUrl: null, tags: [], author: 'fixture' }, package: {
    source: { kind: 'toolplane', requested: `toolplane:device-fixture@${version}`, name: 'device-fixture', version }, name: 'device-fixture', version,
    runtime: { kind: 'pi-sdk', piVersion: '0.87.1', nodeMajor: 24, platform: 'any', arch: 'any' }, root: 'package',
    resources: { extensions: ['package/extensions/toolplane-mcp.mjs'], skills: ['package/skills/example'], prompts: [], themes: [] },
    toolplane: { schemaVersion: 1, mcp: [{ key: 'fixture', name: 'Fixture', tools: ['echo', 'write'] }] },
    entries: [{ type: 'directory', path: 'package' }, { type: 'directory', path: 'package/extensions' }, { type: 'directory', path: 'package/skills' }, { type: 'directory', path: 'package/skills/example' },
      file('package/package.json', JSON.stringify({ name: 'device-fixture', version, type: 'module', pi: { extensions: ['extensions/toolplane-mcp.mjs'], skills: ['skills'] } })),
      file('package/extensions/toolplane-mcp.mjs', piPackageMcpAdapterSource()), file('package/skills/example/SKILL.md', `---\nname: example\ndescription: Device fixture skill\n---\nReviewed version ${version}.\n`)],
  } };
}
async function device(client: PiPackageClient = 'pi', owner = userId) {
  return createPiPackageClientInstallation({ workspaceId, userId: owner, marketInstallId, client, label: `device-${++sequence}`, bindings: { fixture: { deploymentId, tools: ['echo'] } } });
}
async function rpc(id: string, token: string, method: string, params?: unknown) {
  const response = await fetch(`${origin}/api/v1/pi-packages/installations/${id}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  for (const server of [upstream, service]) await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  runtime.port = (upstream.address() as AddressInfo).port; origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const users = await Promise.all(['owner', 'member', 'outsider'].map(name => db.user.create({ data: { email: `pi-device-${name}-${stamp}@test.dev`, passwordHash: 'x' } })));
  [userId, memberId, outsiderId] = users.map(user => user.id);
  const workspace = await db.workspace.create({ data: { ownerId: userId, slug: `pi-device-${stamp}`, name: 'Pi device tests', members: { create: [{ userId, role: 'owner' }, { userId: memberId, role: 'member' }] } } });
  workspaceId = workspace.id;
  foreignWorkspaceId = (await db.workspace.create({ data: { ownerId: outsiderId, slug: `pi-device-foreign-${stamp}`, name: 'Foreign' } })).id;
  deploymentId = (await db.deployment.create({ data: { workspaceId, name: 'Real MCP fixture', source: 'config', status: 'running', mcpToolExposure: 'allowlist', mcpAllowedTools: ['echo', 'write'] } })).id;
  listingId = (await db.marketListing.create({ data: { kind: 'pi-package', namespace: `pi-device-${stamp}`, slug: 'fixture', name: 'Fixture', status: 'published', visibility: 'private', publisherWorkspaceId: workspaceId, publishedById: userId, metadata: {} } })).id;
  const value = manifest();
  releaseId = (await db.marketRelease.create({ data: { listingId, version: 1, manifest: value, releaseSummary: {}, checksum: marketReleaseChecksum(value), reviewStatus: 'approved' } })).id;
  marketInstallId = (await db.marketInstall.create({ data: { listingId, targetWorkspaceId: workspaceId, installedById: userId, currentReleaseId: releaseId, requestedReleaseId: releaseId, idempotencyKey: 'fixture', status: 'ready' } })).id;
});
afterAll(async () => {
  for (const server of [upstream, service]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const home of homes) await rm(home, { recursive: true, force: true });
  await db.piPackageClientInstallation.deleteMany({ where: { workspaceId } });
  await db.marketInstall.deleteMany({ where: { targetWorkspaceId: workspaceId } });
  await db.marketRelease.deleteMany({ where: { listingId } });
  await db.marketListing.deleteMany({ where: { id: listingId } });
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
  await db.user.deleteMany({ where: { id: { in: [userId, memberId, outsiderId] } } });
});

describe.sequential('Pi package external device boundary', () => {
  it('scopes distinct hashed tokens to one device, workspace and current membership', async () => {
    const first = await device(), second = await device();
    expect(first.token).not.toBe(second.token);
    expect(await verifyApiTokenContext(`Bearer ${first.token}`)).toBeNull();
    expect((await listPiPackageClientInstallations({ workspaceId, userId })).find(row => row.id === first.installation.id)).not.toHaveProperty('tokenHash');
    await expect(authenticatePiPackageInstallation(second.installation.id, `Bearer ${first.token}`)).rejects.toMatchObject({ status: 401 });
    await expect(createPiPackageClientInstallation({ workspaceId: foreignWorkspaceId, userId: outsiderId, marketInstallId, client: 'pi', label: 'foreign', bindings: {} })).rejects.toMatchObject({ status: 404 });
    const member = await device('pi', memberId);
    await db.membership.deleteMany({ where: { workspaceId, userId: memberId } });
    await expect(authenticatePiPackageInstallation(member.installation.id, `Bearer ${member.token}`)).rejects.toMatchObject({ status: 403 });
    const revokedMember = await fetch(`${origin}/api/v1/pi-packages/installations/${member.installation.id}/revoke`, { method: 'DELETE', headers: { authorization: `Bearer ${member.token}` } });
    expect(revokedMember.status).toBe(200);
    await db.membership.create({ data: { workspaceId, userId: memberId, role: 'member' } });
    await expect(authenticatePiPackageInstallation(member.installation.id, `Bearer ${member.token}`)).rejects.toMatchObject({ status: 401 });
    await revokePiPackageClientInstallation({ workspaceId, userId, installationId: first.installation.id });
    expect((await rpc(first.installation.id, first.token, 'tools/list')).status).toBe(401);
  });
  it('denies downloads and execution after workspace disablement or listing withdrawal', async () => {
    const current = await device();
    await db.workspace.update({ where: { id: workspaceId }, data: { status: 'disabled' } });
    try {
      expect((await rpc(current.installation.id, current.token, 'tools/list')).status).toBe(403);
      expect((await fetch(`${origin}/api/v1/pi-packages/installations/${current.installation.id}/manifest`, { headers: { authorization: `Bearer ${current.token}` } })).status).toBe(403);
    } finally { await db.workspace.update({ where: { id: workspaceId }, data: { status: 'active' } }); }
    await db.marketListing.update({ where: { id: listingId }, data: { status: 'withdrawn' } });
    try { expect((await rpc(current.installation.id, current.token, 'tools/list')).status).toBe(404); }
    finally { await db.marketListing.update({ where: { id: listingId }, data: { status: 'published' } }); }
  });
  it('uses actual live catalogs, exact permission intersections and original deployment tool origins', async () => {
    const current = await device();
    const listed = await rpc(current.installation.id, current.token, 'tools/list');
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([piPackageToolName(current.installation.id, 'fixture', 'echo')]);
    const count = calls;
    const called = await rpc(current.installation.id, current.token, 'tools/call', { name: piPackageToolName(current.installation.id, 'fixture', 'echo'), arguments: { text: 'real-call' } });
    expect(called.body.result.content).toEqual([{ type: 'text', text: `${count + 1}:real-call` }]);
    expect(called.body.result._meta.toolplaneOrigin).toMatchObject({ deploymentId, originalToolName: 'echo', key: 'fixture' });
    await rpc(current.installation.id, current.token, 'tools/call', { name: piPackageToolName(current.installation.id, 'fixture', 'write'), arguments: {} });
    expect(calls).toBe(count + 1);
    await db.deployment.update({ where: { id: deploymentId }, data: { mcpAllowedTools: ['write'] } });
    expect((await rpc(current.installation.id, current.token, 'tools/list')).body.result.tools).toEqual([]);
    await rpc(current.installation.id, current.token, 'tools/call', { name: piPackageToolName(current.installation.id, 'fixture', 'echo'), arguments: {} });
    expect(calls).toBe(count + 1);
    await db.deployment.update({ where: { id: deploymentId }, data: { mcpAllowedTools: ['echo', 'write'] } });
  });
  it('keeps device pins through workspace updates and requires confirmation before widening permissions', async () => {
    const current = await device();
    const value = manifest('2.0.0');
    const next = await db.marketRelease.create({ data: { listingId, version: 2, manifest: value, releaseSummary: {}, checksum: marketReleaseChecksum(value), reviewStatus: 'approved' } });
    await db.marketInstall.update({ where: { id: marketInstallId }, data: { currentReleaseId: next.id, requestedReleaseId: next.id } });
    expect((await authenticatePiPackageInstallation(current.installation.id, `Bearer ${current.token}`)).release.id).toBe(releaseId);
    const input = { workspaceId, userId, installationId: current.installation.id, releaseId: next.id, bindings: { fixture: { deploymentId, tools: ['echo', 'write'] } } };
    await expect(updatePiPackageClientInstallation(input)).rejects.toMatchObject({ code: 'pi_package_privileges_confirmation_required' });
    await updatePiPackageClientInstallation({ ...input, confirmExpandedPrivileges: true });
    expect((await authenticatePiPackageInstallation(current.installation.id, `Bearer ${current.token}`)).release.id).toBe(next.id);
    await db.marketRelease.update({ where: { id: next.id }, data: { reviewStatus: 'rejected' } });
    expect((await rpc(current.installation.id, current.token, 'tools/list')).status).toBe(404);
    await db.marketInstall.update({ where: { id: marketInstallId }, data: { currentReleaseId: releaseId, requestedReleaseId: releaseId } });
  });
  it.each(['pi', 'claude-code', 'codex', 'opencode', 'hermes'] as const)('installs %s native resources, preserves modified files, and revokes on uninstall', async client => {
    const current = await device(client);
    const home = await mkdtemp(join(tmpdir(), 'pi-device-install-')); homes.push(home);
    const homeAlias = home + '-alias'; homes.push(homeAlias);
    await symlink(home, homeAlias, 'dir');
    const executable = join(homeAlias, 'installer.mjs');
    await symlink(resolve('scripts/pi-package-install.mjs'), executable, 'file');
    const config = join(home, 'device.json');
    await writeFile(config, JSON.stringify({ baseUrl: origin, installationId: current.installation.id, token: current.token, client }), { mode: 0o600 });
    const env = { ...process.env, HOME: homeAlias, XDG_CONFIG_HOME: join(homeAlias, '.config'), PI_CODING_AGENT_DIR: join(homeAlias, '.pi', 'agent'), CODEX_HOME: join(homeAlias, '.codex'), OPENCODE_CONFIG_DIR: join(homeAlias, '.config', 'opencode'), OPENCODE_CONFIG: join(homeAlias, '.config', 'opencode', 'opencode.json'), HERMES_HOME: join(homeAlias, '.hermes'), HERMES_CONFIG: join(homeAlias, '.hermes', 'config.yaml') };
    const execute = (command: string) => promisify(execFile)(process.execPath, [executable, command, '--config', config], { env, timeout: 60000 });
    const installed = await execute('install');
    if (client !== 'pi') expect(installed.stderr).toContain('pi_resources_omitted');
    const stateRoot = join(home, '.config', 'toolplane', 'pi-packages', current.installation.id);
    const state = JSON.parse(await readFile(join(stateRoot, 'state.json'), 'utf8'));
    const skill = Object.keys(state.files).find(file => file.endsWith('/SKILL.md'))!;
    const skillBytes = await readFile(skill);
    const outside = await mkdtemp(join(tmpdir(), 'pi-device-outside-')); homes.push(outside);
    await writeFile(join(outside, 'SKILL.md'), 'outside must stay untouched');
    const skillDirectory = dirname(skill), originalDirectory = join(home, 'original-skill');
    await rename(skillDirectory, originalDirectory);
    await symlink(outside, skillDirectory, 'dir');
    try {
      await expect(execute('update')).rejects.toThrow();
      expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('outside must stay untouched');
      expect(await readdir(outside)).toEqual(['SKILL.md']);
    } finally { await rm(skillDirectory); await rename(originalDirectory, skillDirectory); }
    await writeFile(skill, 'user edit');
    await expect(execute('update')).rejects.toThrow();
    expect(await readFile(skill, 'utf8')).toBe('user edit');
    await writeFile(skill, skillBytes);
    const updatedVersion = `1.0.${++sequence}`;
    const updatedManifest = manifest(updatedVersion);
    const updatedRelease = await db.marketRelease.create({ data: { listingId, version: sequence + 10, manifest: updatedManifest, releaseSummary: {}, checksum: marketReleaseChecksum(updatedManifest), reviewStatus: 'approved' } });
    await updatePiPackageClientInstallation({ workspaceId, userId, installationId: current.installation.id, releaseId: updatedRelease.id, bindings: { fixture: { deploymentId, tools: ['echo'] } } });
    await execute('update');
    expect(await readFile(skill, 'utf8')).toContain(`Reviewed version ${updatedVersion}.`);
    if (client === 'pi') {
      const probe = join(home, 'official-loader.mjs');
      await writeFile(probe, `import { DefaultResourceLoader } from ${JSON.stringify(pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)};
const loader = new DefaultResourceLoader({cwd:${JSON.stringify(home)},agentDir:${JSON.stringify(join(home, '.pi', 'agent'))},noContextFiles:true});
await loader.reload();const result=loader.getExtensions();if(result.errors.length)throw new Error(JSON.stringify(result.errors));
const tool=result.extensions.flatMap(extension=>[...extension.tools.values()]).find(tool=>tool.definition.name===${JSON.stringify(piPackageToolName(current.installation.id, 'fixture', 'echo'))});
if(!tool)throw new Error('missing adapter tool');const called=await tool.definition.execute('fixture',{text:'official-loader'},undefined,()=>{},{});console.log(JSON.stringify({called,skills:loader.getSkills().skills.map(skill=>skill.name)}));`);
      const probeResult = await promisify(execFile)(process.execPath, [probe], { env, timeout: 60000 });
      expect(probeResult.stdout).toContain('official-loader');
      expect(probeResult.stdout).toContain('example');
      const privateBytes = await readFile(join(stateRoot, 'config.json'), 'utf8'); expect(privateBytes).toContain(current.token);
      expect(await readFile(join(stateRoot, 'package', 'extensions', 'toolplane-mcp.mjs'), 'utf8')).not.toContain(current.token);
    } else {
      expect((await readdir(stateRoot))).not.toContain('package');
      const bridge = spawn(process.execPath, [join(stateRoot, 'client.mjs'), 'mcp', '--config', join(stateRoot, 'config.json')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = createInterface({ input: bridge.stdout });
      try {
        const response = once(output, 'line');
        bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: piPackageToolName(current.installation.id, 'fixture', 'echo'), arguments: { text: 'native-stdio' } } }) + '\n');
        expect(JSON.parse(String((await response)[0])).result.content[0].text).toContain('native-stdio');
      } finally { output.close(); const closed = once(bridge, 'close'); bridge.kill('SIGKILL'); await closed; }
    }
    await execute('uninstall');
    await expect(readFile(skill)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await rpc(current.installation.id, current.token, 'tools/list')).status).toBe(401);
  }, 120000);
});
