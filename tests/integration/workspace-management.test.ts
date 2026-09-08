// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken, verifyApiTokenContext } from '@/lib/auth/tokens';
import { getDefaultWorkspace, getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  createWorkspace, renameWorkspace, inviteWorkspaceMember, getWorkspaceInvitation,
  acceptWorkspaceInvitation, revokeWorkspaceInvitation, removeWorkspaceMember,
  transferWorkspaceOwnership, deleteWorkspace,
} from '@/lib/workspace/management';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
import { GET as manifest } from '@/app/api/v1/workspaces/[slug]/manifest/route';

vi.mock('@/lib/workspace/teardown', () => ({ killWorkspaceProcesses: vi.fn() }));

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const userIds: string[] = [];
let owner: string;
let member: string;
let outsider: string;
let workspace: Awaited<ReturnType<typeof createWorkspace>>;
const email = (name: string) => `workspace-flow-${name}-${stamp}@example.test`;
const tokenFrom = (path: string) => new URLSearchParams(new URL(path, 'http://localhost').hash.slice(1)).get('invite')!;

beforeAll(async () => {
  for (const name of ['owner', 'member', 'outsider']) {
    const user = await db.user.create({ data: { email: email(name), passwordHash: 'test-only' } });
    userIds.push(user.id);
  }
  [owner, member, outsider] = userIds;
});

beforeEach(async () => {
  vi.mocked(killWorkspaceProcesses).mockReset().mockResolvedValue();
  workspace = await createWorkspace(owner, '研发团队');
  await db.membership.create({ data: { workspaceId: workspace.id, userId: member } });
});

afterAll(async () => {
  // These accounts and all their workspaces were created by this test file.
  await db.workspace.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('workspace lifecycle and authorization', () => {
  it('creates Chinese names with stable, unique URLs and validates names on the server', async () => {
    const another = await createWorkspace(owner, '研发团队');
    expect(another.slug).not.toBe(workspace.slug);
    expect(workspace.name).toBe('研发团队');
    expect(workspace.slug).toMatch(/^workspace-[a-f0-9]{8}$/);
    await renameWorkspace(owner, workspace.slug, '新的名称');
    expect(await getWorkspaceForUser(workspace.slug, owner)).toMatchObject({ name: '新的名称', slug: workspace.slug });
    await expect(createWorkspace(owner, '   ')).rejects.toThrow('invalidName');
    await expect(renameWorkspace(owner, workspace.slug, 'x'.repeat(81))).rejects.toThrow('invalidName');
  });

  it('does not silently create a default workspace and validates remembered access', async () => {
    expect(await getDefaultWorkspace(outsider, workspace.slug)).toBeNull();
    expect(await db.workspace.count({ where: { ownerId: outsider } })).toBe(0);
    expect(await getDefaultWorkspace(owner, workspace.slug)).toMatchObject({ id: workspace.id });
  });

  it('rejects member and outsider management, including forged member targets', async () => {
    await expect(renameWorkspace(member, workspace.slug, 'Hijacked')).rejects.toThrow('forbidden');
    await expect(inviteWorkspaceMember(member, workspace.slug, email('outsider'))).rejects.toThrow('forbidden');
    await expect(removeWorkspaceMember(member, workspace.slug, owner)).rejects.toThrow('forbidden');
    await expect(removeWorkspaceMember(outsider, workspace.slug, outsider)).rejects.toThrow('forbidden');
    await expect(revokeWorkspaceInvitation(outsider, workspace.slug, 'unknown')).rejects.toThrow('forbidden');
    await expect(transferWorkspaceOwnership(member, workspace.slug, outsider, workspace.name)).rejects.toThrow('forbidden');
    await expect(deleteWorkspace(member, workspace.slug, workspace.name)).rejects.toThrow('forbidden');
    expect(killWorkspaceProcesses).not.toHaveBeenCalled();
  });

  it('invites unregistered accounts without granting membership and requires the invited email to accept', async () => {
    const pending = await inviteWorkspaceMember(owner, workspace.slug, email('not-registered'));
    expect(await getWorkspaceInvitation(tokenFrom(pending))).toMatchObject({ email: email('not-registered') });
    const path = await inviteWorkspaceMember(owner, workspace.slug, email('outsider').toUpperCase());
    const token = tokenFrom(path);
    const saved = await db.workspaceInvitation.findUnique({ where: { workspaceId_email: { workspaceId: workspace.id, email: email('outsider') } } });
    expect(saved?.tokenHash).not.toBe(token);
    expect(await getWorkspaceForUser(workspace.slug, outsider)).toBeNull();
    await expect(acceptWorkspaceInvitation(member, token)).rejects.toThrow('wrongEmail');
    expect(await acceptWorkspaceInvitation(outsider, token)).toBe(workspace.slug);
    expect(await getWorkspaceForUser(workspace.slug, outsider)).not.toBeNull();
    await expect(acceptWorkspaceInvitation(outsider, token)).rejects.toThrow('invalidInvitation');
    await expect(inviteWorkspaceMember(owner, workspace.slug, email('outsider'))).rejects.toThrow('alreadyMember');
  });

  it('invalidates replaced, revoked and expired invitations', async () => {
    const first = tokenFrom(await inviteWorkspaceMember(owner, workspace.slug, email('outsider')));
    const second = tokenFrom(await inviteWorkspaceMember(owner, workspace.slug, email('outsider')));
    expect(await getWorkspaceInvitation(first)).toBeNull();
    const invitation = await getWorkspaceInvitation(second);
    await revokeWorkspaceInvitation(owner, workspace.slug, invitation!.id);
    await expect(acceptWorkspaceInvitation(outsider, second)).rejects.toThrow('invalidInvitation');
    const expired = tokenFrom(await inviteWorkspaceMember(owner, workspace.slug, email('outsider')));
    await db.workspaceInvitation.updateMany({ where: { workspaceId: workspace.id }, data: { expiresAt: new Date(0) } });
    await expect(acceptWorkspaceInvitation(outsider, expired)).rejects.toThrow('invalidInvitation');
  });

  it('revokes workspace access and toolkit tokens without deleting personal credentials or shared resources', async () => {
    const toolkit = await db.toolkit.create({ data: { workspaceId: workspace.id, slug: 'shared', name: 'Shared' } });
    const personal = await createApiToken(member, 'personal');
    const scoped = await createApiToken(member, 'toolkit', { toolkitId: toolkit.id });
    await removeWorkspaceMember(owner, workspace.slug, member);
    expect(await getWorkspaceForUser(workspace.slug, member)).toBeNull();
    expect(await verifyApiTokenContext(`Bearer ${personal.token}`)).not.toBeNull();
    expect(await verifyApiTokenContext(`Bearer ${scoped.token}`)).toBeNull();
    expect(await db.toolkit.findUnique({ where: { id: toolkit.id } })).not.toBeNull();
    const response = await manifest(new Request('http://localhost/api/manifest', { headers: { authorization: `Bearer ${personal.token}` } }), { params: Promise.resolve({ slug: workspace.slug }) });
    expect(response.status).toBe(404);
  });

  it('allows members to leave, but requires owners to transfer first', async () => {
    await expect(removeWorkspaceMember(owner, workspace.slug, owner)).rejects.toThrow('transferFirst');
    await removeWorkspaceMember(member, workspace.slug, member);
    expect(await getWorkspaceForUser(workspace.slug, member)).toBeNull();
    expect(await getWorkspaceForUser(workspace.slug, owner)).not.toBeNull();
  });

  it('transfers to an existing member atomically and removes the old owner’s management rights', async () => {
    await expect(transferWorkspaceOwnership(owner, workspace.slug, member, 'wrong name')).rejects.toThrow('confirmName');
    await expect(transferWorkspaceOwnership(owner, workspace.slug, outsider, workspace.name)).rejects.toThrow('memberMissing');
    await transferWorkspaceOwnership(owner, workspace.slug, member, workspace.name);
    expect(await getWorkspaceForUser(workspace.slug, owner)).toMatchObject({ ownerId: member });
    const owners = await db.membership.findMany({ where: { workspaceId: workspace.id, role: 'owner' } });
    expect(owners.map((item) => item.userId)).toEqual([member]);
    await expect(renameWorkspace(owner, workspace.slug, 'No')).rejects.toThrow('forbidden');
    await removeWorkspaceMember(owner, workspace.slug, owner);
    expect(await getWorkspaceForUser(workspace.slug, member)).not.toBeNull();
  });

  it('serializes transfer and leave so the owner always remains a member', async () => {
    await Promise.allSettled([
      transferWorkspaceOwnership(owner, workspace.slug, member, workspace.name),
      removeWorkspaceMember(member, workspace.slug, member),
    ]);
    const current = await db.workspace.findUniqueOrThrow({ where: { id: workspace.id }, include: { members: true } });
    expect(current.members.some((item) => item.userId === current.ownerId && item.role === 'owner')).toBe(true);
  });

  it('locks failed deletion, refuses unsafe confirmation, and permits a safe cleanup retry', async () => {
    await expect(deleteWorkspace(owner, workspace.slug, 'wrong')).rejects.toThrow('confirmName');
    expect(killWorkspaceProcesses).not.toHaveBeenCalled();
    vi.mocked(killWorkspaceProcesses).mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(deleteWorkspace(owner, workspace.slug, workspace.name)).rejects.toThrow('deleteFailed');
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({ status: 'delete_failed' });
    expect(await getWorkspaceForUser(workspace.slug, owner)).toBeNull();
    await expect(renameWorkspace(owner, workspace.slug, 'No')).rejects.toThrow('unavailable');
    const { token } = await createApiToken(owner, 'owner');
    expect((await manifest(new Request('http://localhost/api/manifest', { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ slug: workspace.slug }) })).status).toBe(404);
    await deleteWorkspace(owner, workspace.slug, workspace.name);
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
  });
});
