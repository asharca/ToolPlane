// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const faults = vi.hoisted(() => ({ audit: false }));
vi.mock('@/lib/observability/audit', async (original) => {
  const actual = await original<typeof import('@/lib/observability/audit')>();
  return { ...actual, writeAudit: (...args: Parameters<typeof actual.writeAudit>) => {
    if (faults.audit) throw new Error('Isolated injected audit failure');
    return actual.writeAudit(...args);
  } };
});
vi.mock('@/lib/db', async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== '1') return original();
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) }) };
});
import { db } from '@/lib/db';
import { getA2AConsoleView, mutateA2AConsole, type ConsoleActor } from '@/lib/a2a/console-service';
import { verifyAgentApiKey } from '@/lib/agents/public-api/auth';

let owner: string, member: string, other: string, workspaceId: string, endpointId: string, publicId: string;
let local: ConsoleActor, published: ConsoleActor;
beforeAll(async () => {
  process.env.AUTH_SECRET = 'isolated-console-integration-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.test';
  const stamp = randomUUID();
  const user = async (name: string) => (await db.user.create({ data: { email: `${name}-${stamp}@test.invalid`, passwordHash: 'test-only' } })).id;
  owner = await user('owner'); member = await user('member'); other = await user('other');
  const ws = await db.workspace.create({ data: { slug: `console-${stamp}`, name: 'Console fixture', ownerId: owner,
    members: { create: { userId: member, role: 'member' } } } }); workspaceId = ws.id;
  const provider = await db.modelProvider.create({ data: { workspaceId, name: 'Fixture', format: 'openai', baseUrl: 'https://never-called.test', apiKey: 'do-not-expose-fixture-provider-key' } });
  const dep = await db.deployment.create({ data: { workspaceId, name: 'Fixture sandbox', source: 'config' } });
  const sandbox = await db.sandbox.create({ data: { workspaceId, deploymentId: dep.id, name: 'Fixture sandbox', slug: 'fixture', kind: 'docker', network: 'isolated' } });
  const agent = await db.agent.create({ data: { workspaceId, name: 'Local agent', slug: 'local', runtimeKind: 'pi', providerId: provider.id, model: 'fixture',
    systemPrompt: 'PRIVATE PROMPT', sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
  local = { workspaceId, actorId: owner, agentId: agent.id, slug: ws.slug };
  const source = await db.agent.create({ data: { workspaceId, name: 'Hermes', slug: 'public', runtimeKind: 'hermes' } });
  published = { ...local, agentId: source.id };
  const endpoint = await db.agentEndpoint.create({ data: { workspaceId, sourceAgentId: source.id, publicId: `agep_${stamp.replaceAll('-', '')}`, name: 'Service', status: 'active' } });
  endpointId = endpoint.id; publicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({ data: { endpointId, version: 1, systemPrompt: 'PRIVATE PUBLIC CONFIG', runtimeImage: 'fixture-not-executed', toolPolicy: {} } });
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { currentRevisionId: revision.id } });
});
beforeEach(async () => {
  faults.audit = false;
  await db.user.update({ where: { id: owner }, data: { status: 'active' } });
  await db.workspace.update({ where: { id: workspaceId }, data: { status: 'active' } });
  await db.agent.update({ where: { id: local.agentId }, data: { a2aInternalEnabled: false } });
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { status: 'active', a2aEnabled: true } });
  await db.agentApiClient.deleteMany({ where: { endpointId } });
});
afterAll(async () => {
  faults.audit = false;
  if (workspaceId) { await db.auditEvent.deleteMany({ where: { workspaceId } }); await db.workspace.delete({ where: { id: workspaceId } }); }
  await db.user.deleteMany({ where: { id: { in: [owner, member, other].filter(Boolean) } } });
  await db.$disconnect();
});

describe('A2A console management persists scoped configuration', () => {
  it('keeps public and local opt-ins separate', async () => {
    await mutateA2AConsole(local, { action: 'set-local', enabled: true });
    expect((await getA2AConsoleView(local)).local).toMatchObject({ enabled: true, ready: true });
    await mutateA2AConsole(published, { action: 'set-public', enabled: false });
    expect((await getA2AConsoleView(local)).local.enabled).toBe(true);
    expect((await getA2AConsoleView(published)).endpoint?.enabled).toBe(false);
  });
  it('rolls back enabling a runtime without local isolation support', async () => {
    await expect(mutateA2AConsole(published, { action: 'set-local', enabled: true })).rejects.toMatchObject({ status: 409 });
    expect((await db.agent.findUniqueOrThrow({ where: { id: published.agentId } })).a2aInternalEnabled).toBe(false);
  });
  it.each(['set-local', 'set-public'] as const)('rejects member and outsider %s mutations', async (action) => {
    const target = action === 'set-local' ? local : published;
    for (const actorId of [member, other]) await expect(mutateA2AConsole({ ...target, actorId }, { action, enabled: true })).rejects.toMatchObject({ status: 403 });
  });
  it('rejects disabled users, closing workspaces and foreign targets', async () => {
    await db.user.update({ where: { id: owner }, data: { status: 'suspended' } });
    await expect(mutateA2AConsole(local, { action: 'set-local', enabled: true })).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: owner }, data: { status: 'active' } });
    await expect(mutateA2AConsole({ ...local, agentId: 'foreign-target' }, { action: 'set-local', enabled: true })).rejects.toMatchObject({ status: 404 });
    await db.workspace.update({ where: { id: workspaceId }, data: { status: 'deleting' } });
    await expect(mutateA2AConsole(local, { action: 'set-local', enabled: true })).rejects.toMatchObject({ status: 403 });
  });
  it('creates a client and one-time key atomically using only A2A scopes', async () => {
    const result = await mutateA2AConsole(published, { action: 'create-client', name: 'External integration' });
    expect(result.token).toMatch(/^tp_agent_/);
    const stored = await db.agentApiKey.findFirstOrThrow({ where: { clientId: result.clientId } });
    expect(stored.tokenHash).not.toContain(result.token);
    expect(await verifyAgentApiKey(`Bearer ${result.token}`, publicId, 'a2a:send')).not.toBeNull();
    expect(await verifyAgentApiKey(`Bearer ${result.token}`, publicId, 'responses:create')).toBeNull();
    const view = await getA2AConsoleView(published);
    const serialized = JSON.stringify(view);
    for (const secret of [result.token!, stored.tokenHash, 'PRIVATE PUBLIC CONFIG', 'do-not-expose-fixture-provider-key']) expect(serialized).not.toContain(secret);
    expect(view.endpoint?.clients).toHaveLength(1);
    expect(JSON.stringify(await db.auditEvent.findMany({ where: { workspaceId } }))).not.toContain(result.token);
  });
  it('does not leave a client or key when auditing fails', async () => {
    faults.audit = true;
    await expect(mutateA2AConsole(published, { action: 'create-client', name: 'Must rollback' })).rejects.toThrow();
    expect(await db.agentApiClient.count({ where: { endpointId } })).toBe(0);
    expect(await db.agentApiKey.count({ where: { client: { endpointId } } })).toBe(0);
  });
  it('rotates without silently revoking the old key; revoke is scoped and idempotent', async () => {
    const original = await mutateA2AConsole(published, { action: 'create-client', name: 'Integration' });
    const replacement = await mutateA2AConsole(published, { action: 'create-key', clientId: original.clientId! });
    expect(original.token).not.toBe(replacement.token);
    expect(await verifyAgentApiKey(`Bearer ${original.token}`, publicId, 'a2a:read')).not.toBeNull();
    const oldKey = await db.agentApiKey.findFirstOrThrow({ where: { clientId: original.clientId }, orderBy: { createdAt: 'asc' } });
    await mutateA2AConsole(published, { action: 'revoke-key', keyId: oldKey.id });
    await mutateA2AConsole(published, { action: 'revoke-key', keyId: oldKey.id });
    expect(await verifyAgentApiKey(`Bearer ${original.token}`, publicId, 'a2a:read')).toBeNull();
    expect(await verifyAgentApiKey(`Bearer ${replacement.token}`, publicId, 'a2a:read')).not.toBeNull();
  });
  it('never upgrades or modifies legacy response clients', async () => {
    const legacy = await db.agentApiClient.create({ data: { endpointId, name: 'Legacy', scopes: ['responses:create', 'responses:read'] } });
    await expect(mutateA2AConsole(published, { action: 'create-key', clientId: legacy.id })).rejects.toMatchObject({ status: 404 });
    expect((await getA2AConsoleView(published)).endpoint?.clients).toHaveLength(0);
  });
  it('does not expose key management data to a member or accept foreign key IDs', async () => {
    await mutateA2AConsole(published, { action: 'create-client', name: 'Owner integration' });
    const memberView = await getA2AConsoleView({ ...published, actorId: member });
    expect(memberView.canManage).toBe(false); expect(memberView.endpoint?.clients).toEqual([]);
    await expect(mutateA2AConsole(published, { action: 'revoke-key', keyId: 'foreign-key' })).rejects.toMatchObject({ status: 404 });
  });
  it('allows revocation on a disabled endpoint, but refuses new credentials', async () => {
    const created = await mutateA2AConsole(published, { action: 'create-client', name: 'Integration' });
    const key = await db.agentApiKey.findFirstOrThrow({ where: { clientId: created.clientId } });
    await db.agentEndpoint.update({ where: { id: endpointId }, data: { status: 'disabled', a2aEnabled: false } });
    await expect(mutateA2AConsole(published, { action: 'create-client', name: 'Not allowed' })).rejects.toMatchObject({ status: 409 });
    await mutateA2AConsole(published, { action: 'revoke-key', keyId: key.id });
    expect((await db.agentApiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull();
  });
});
