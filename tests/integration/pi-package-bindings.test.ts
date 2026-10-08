// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createAgent, updateAgent } from '@/lib/agents/mutations';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';

let workspaceId: string;
let userId: string;
let installId: string;
let v1: string;
let v2: string;
let foreignRelease: string;
const listingIds: string[] = [];
const cfg = { name: 'SDK', systemPrompt: '', providerId: null, model: null, maxSteps: 10 };
beforeAll(async () => {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `${suffix}@test.dev`, passwordHash: 'x' } });
  userId = user.id;
  const ws = await db.workspace.create({ data: { slug: suffix, name: 'Packages', ownerId: userId } });
  workspaceId = ws.id;
  for (const slug of ['package', 'foreign']) {
    const listing = await db.marketListing.create({ data: { namespace: suffix, slug, kind: 'pi-package', name: slug, metadata: {}, status: 'published' } });
    listingIds.push(listing.id);
  }
  const releases = await Promise.all([1, 2].map((version) => db.marketRelease.create({ data: { listingId: listingIds[0], version, manifest: {}, releaseSummary: {}, checksum: 'fixture', reviewStatus: 'approved' } })));
  [v1, v2] = releases.map((release) => release.id);
  foreignRelease = (await db.marketRelease.create({ data: { listingId: listingIds[1], version: 1, manifest: {}, releaseSummary: {}, checksum: 'fixture', reviewStatus: 'approved' } })).id;
  installId = (await db.marketInstall.create({ data: { listingId: listingIds[0], currentReleaseId: v1, requestedReleaseId: v1, targetWorkspaceId: workspaceId, idempotencyKey: suffix, status: 'ready', resourceMap: { kind: 'pi-package' } } })).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (listingIds.length) await db.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
it('pins creation, preserves old approved bindings and rejects foreign releases and active leases', async () => {
  const agent = await createAgent(workspaceId, 'SDK', { runtime: 'pi-sdk', piPackages: [{ marketInstallId: installId, releaseId: v1 }] });
  const binding = () => db.agentPiPackage.findUniqueOrThrow({ where: { agentId_marketInstallId: { agentId: agent.id, marketInstallId: installId } } });
  expect((await binding()).releaseId).toBe(v1);
  await expect(updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [{ marketInstallId: installId, releaseId: foreignRelease }] })).rejects.toThrow('Release not approved');
  await db.marketInstall.update({ where: { id: installId }, data: { currentReleaseId: v2, requestedReleaseId: v2 } });
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [{ marketInstallId: installId, releaseId: v1 }] });
  expect((await binding()).releaseId).toBe(v1);
  const sandbox = await db.agentSandbox.findFirstOrThrow({ where: { agentId: agent.id } });
  await withSandboxExecutionLease(sandbox.sandboxId, async () => {
    await expect(updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] })).rejects.toThrow('pi_package_agent_busy');
    expect((await binding()).releaseId).toBe(v1);
  });
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [{ marketInstallId: installId, releaseId: v2 }] });
  expect((await binding()).releaseId).toBe(v2);
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] });
  expect(await db.agentPiPackage.count({ where: { agentId: agent.id } })).toBe(0);
});
it('rejects bindings for ordinary Pi even when empty and rejects noncurrent first bindings', async () => {
  await db.marketInstall.update({ where: { id: installId }, data: { currentReleaseId: v2, requestedReleaseId: v2 } });
  await expect(createAgent(workspaceId, 'Pi', { runtime: 'pi', piPackages: [] })).rejects.toThrow('pi_packages_runtime_unsupported');
  await expect(createAgent(workspaceId, 'Stale', { runtime: 'pi-sdk', piPackages: [{ marketInstallId: installId, releaseId: v1 }] })).rejects.toThrow('pi_package_release_not_current');
});
it('rejects foreign workspace installs, duplicates, arbitrary fields and busy Work without losing bindings', async () => {
  await db.marketInstall.update({ where: { id: installId }, data: { currentReleaseId: v2, requestedReleaseId: v2 } });
  const packages = [{ marketInstallId: installId, releaseId: v2 }];
  const agent = await createAgent(workspaceId, 'Bound SDK', { runtime: 'pi-sdk', piPackages: packages });
  await expect(updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [...packages, ...packages] })).rejects.toThrow('Duplicate marketInstallId');
  await expect(updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [{ ...packages[0], path: '/tmp/code' } as typeof packages[number]] })).rejects.toThrow('pi_packages_invalid');
  const foreignWorkspace = await db.workspace.create({ data: { slug: randomUUID(), name: 'Foreign', ownerId: userId } });
  try {
    await expect(createAgent(foreignWorkspace.id, 'Foreign SDK', { runtime: 'pi-sdk', piPackages: packages })).rejects.toThrow('Unknown or inaccessible market install');
  } finally { await db.workspace.delete({ where: { id: foreignWorkspace.id } }); }
  const conversation = await db.conversation.create({ data: { agentId: agent.id } });
  const work = await db.workSession.create({ data: { workspaceId, agentId: agent.id, conversationId: conversation.id, runtimeKind: 'pi-sdk', status: 'waiting_approval' } });
  await expect(updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] })).rejects.toThrow('pi_package_agent_busy');
  expect(await db.agentPiPackage.count({ where: { agentId: agent.id, releaseId: v2 } })).toBe(1);
  await db.workSession.update({ where: { id: work.id }, data: { status: 'completed' } });
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] });
  expect(await db.agentPiPackage.count({ where: { agentId: agent.id } })).toBe(0);
});
