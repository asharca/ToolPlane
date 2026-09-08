import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { hashToken } from '@/lib/auth/token-format';
import { writeAudit } from '@/lib/observability/audit';
import { killWorkspaceProcesses } from './teardown';
import { revokeWorkspaceStreams } from './access-stream';

export class WorkspaceManagementError extends Error {}

function invalid(code: string): never {
  throw new WorkspaceManagementError(code);
}

function workspaceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) invalid('invalidName');
  return name;
}

// Lock the same row for membership, ownership and lifecycle mutations. In
// particular, a member cannot leave between being selected and becoming owner.
async function lockedWorkspace(tx: Prisma.TransactionClient, slug: string, actorId: string, ownerOnly = true, allowDeleting = false) {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "slug" = ${slug} FOR UPDATE`;
  const workspace = await tx.workspace.findFirst({
    where: { slug, OR: [{ ownerId: actorId }, { members: { some: { userId: actorId } } }] },
  });
  if (!workspace || (ownerOnly && workspace.ownerId !== actorId)) invalid('forbidden');
  if (!allowDeleting && workspace.status !== 'active') invalid('unavailable');
  return workspace;
}

export async function createWorkspace(actorId: string, value: string) {
  const name = workspaceName(value);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'workspace';
  // Random suffix also avoids reserved auth paths and concurrent slug races.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({ data: {
          name, slug: `${base}-${randomBytes(4).toString('hex')}`, ownerId: actorId,
          members: { create: { userId: actorId, role: 'owner' } },
        } });
        await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.created', targetType: 'workspace', targetId: workspace.id });
        return workspace;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002' || attempt === 2) throw error;
    }
  }
  return invalid('failed');
}

export async function renameWorkspace(actorId: string, slug: string, value: string) {
  const name = workspaceName(value);
  return db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await tx.workspace.update({ where: { id: workspace.id }, data: { name } });
    await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.renamed', targetType: 'workspace', targetId: workspace.id, changes: { name } });
  });
}

export async function inviteWorkspaceMember(actorId: string, slug: string, value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('invalidEmail');
  const token = randomBytes(32).toString('hex');
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    const member = await tx.user.findFirst({ where: { email, OR: [
      { ownedWorkspaces: { some: { id: workspace.id } } },
      { memberships: { some: { workspaceId: workspace.id } } },
    ] } });
    if (member) invalid('alreadyMember');
    const invitation = await tx.workspaceInvitation.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
      create: { workspaceId: workspace.id, email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400_000) },
      update: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400_000), createdAt: new Date() },
    });
    await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.invited', targetType: 'workspaceInvitation', targetId: invitation.id });
  });
  // Fragments are not sent in HTTP request URLs or access logs.
  return `/app?view=invitation#invite=${token}`;
}

export async function getWorkspaceInvitation(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.workspaceInvitation.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() }, workspace: { status: 'active' } },
    select: { id: true, email: true, workspaceId: true, workspace: { select: { name: true, slug: true } } },
  });
}

export async function acceptWorkspaceInvitation(actorId: string, token: string) {
  const invitation = await getWorkspaceInvitation(token);
  if (!invitation) invalid('invalidInvitation');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${invitation.workspaceId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: actorId }, select: { email: true } });
    if (user?.email.toLowerCase() !== invitation.email) invalid('wrongEmail');
    const consumed = await tx.workspaceInvitation.deleteMany({ where: {
      id: invitation.id, tokenHash: hashToken(token), expiresAt: { gt: new Date() }, workspace: { status: 'active' },
    } });
    if (consumed.count !== 1) invalid('invalidInvitation');
    await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: actorId } },
      create: { workspaceId: invitation.workspaceId, userId: actorId, role: 'member' }, update: {},
    });
    await writeAudit(tx, { actorId, workspaceId: invitation.workspaceId, action: 'workspace.joined', targetType: 'workspace', targetId: invitation.workspaceId });
    return invitation.workspace.slug;
  });
}

export async function revokeWorkspaceInvitation(actorId: string, slug: string, invitationId: string) {
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await tx.workspaceInvitation.deleteMany({ where: { id: invitationId, workspaceId: workspace.id } });
    await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.invitation_revoked', targetType: 'workspaceInvitation', targetId: invitationId });
  });
}

export async function removeWorkspaceMember(actorId: string, slug: string, memberId: string) {
  const workspaceId = await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId, memberId !== actorId, memberId === actorId);
    if (memberId === workspace.ownerId) invalid('transferFirst');
    const result = await tx.membership.deleteMany({ where: { workspaceId: workspace.id, userId: memberId } });
    if (!result.count) invalid('memberMissing');
    const member = await tx.user.findUnique({ where: { id: memberId }, select: { email: true } });
    if (member) await tx.workspaceInvitation.deleteMany({ where: { workspaceId: workspace.id, email: member.email.toLowerCase() } });
    await tx.apiToken.deleteMany({ where: { userId: memberId, toolkit: { workspaceId: workspace.id } } });
    await writeAudit(tx, { actorId, workspaceId: workspace.id, action: memberId === actorId ? 'workspace.left' : 'workspace.member_removed', targetType: 'user', targetId: memberId });
    return workspace.id;
  });
  revokeWorkspaceStreams(workspaceId, memberId);
  return workspaceId;
}

export async function transferWorkspaceOwnership(actorId: string, slug: string, memberId: string, confirmation: string) {
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    if (confirmation !== workspace.name) invalid('confirmName');
    if (memberId === actorId) invalid('memberMissing');
    const member = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: memberId } }, include: { user: { select: { status: true } } } });
    if (!member || member.user.status !== 'active') invalid('memberMissing');
    await tx.workspace.update({ where: { id: workspace.id }, data: { ownerId: memberId } });
    await tx.membership.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: actorId } }, create: { workspaceId: workspace.id, userId: actorId, role: 'member' }, update: { role: 'member' } });
    await tx.membership.updateMany({ where: { workspaceId: workspace.id }, data: { role: 'member' } });
    await tx.membership.update({ where: { id: member.id }, data: { role: 'owner' } });
    await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.ownership_transferred', targetType: 'user', targetId: memberId });
  });
}

const deletionGlobal = globalThis as typeof globalThis & { __workspaceDeletions?: Set<string> };

export async function deleteWorkspace(actorId: string, slug: string, confirmation: string) {
  // ponytail: one server process deduplicates teardown; use a renewable DB lease
  // if workspace management is served by multiple independent workers.
  const deleting = deletionGlobal.__workspaceDeletions ??= new Set<string>();
  if (deleting.has(slug)) invalid('deleting');
  deleting.add(slug);
  let workspaceId: string | undefined;
  try {
    workspaceId = await db.$transaction(async (tx) => {
      const workspace = await lockedWorkspace(tx, slug, actorId, true, true);
      if (confirmation !== workspace.name) invalid('confirmName');
      await tx.workspace.update({ where: { id: workspace.id }, data: { status: 'deleting' } });
      await writeAudit(tx, { actorId, workspaceId: workspace.id, action: 'workspace.deletion_started', targetType: 'workspace', targetId: workspace.id });
      return workspace.id;
    });
    revokeWorkspaceStreams(workspaceId);
    await killWorkspaceProcesses(workspaceId);
    await db.$transaction(async (tx) => {
      await tx.workspace.delete({ where: { id: workspaceId } });
      await writeAudit(tx, { actorId, workspaceId, action: 'workspace.deleted', targetType: 'workspace', targetId: workspaceId! });
    });
  } catch (error) {
    if (workspaceId) {
      await db.workspace.updateMany({ where: { id: workspaceId }, data: { status: 'delete_failed' } });
      invalid('deleteFailed');
    }
    throw error;
  } finally {
    deleting.delete(slug);
  }
}
