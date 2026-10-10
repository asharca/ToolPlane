import "server-only";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashToken } from "@/lib/auth/token-format";
import { writeAudit } from "@/lib/observability/audit";
import { killWorkspaceProcesses } from "./teardown";
import { revokeWorkspaceStreams } from "./access-stream";

export class WorkspaceManagementError extends Error {}

function invalid(code: string): never {
  throw new WorkspaceManagementError(code);
}

function workspaceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) invalid("invalidName");
  return name;
}

// Lock the same row for membership, ownership and lifecycle mutations. In
// particular, a member cannot leave between being selected and becoming owner.
async function lockedWorkspace(
  tx: Prisma.TransactionClient,
  slug: string,
  actorId: string,
  ownerOnly = true,
  allowDeleting = false,
) {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "slug" = ${slug} FOR UPDATE`;
  const workspace = await tx.workspace.findFirst({
    where: {
      slug,
      OR: [{ ownerId: actorId }, { members: { some: { userId: actorId } } }],
    },
  });
  if (!workspace || (ownerOnly && workspace.ownerId !== actorId))
    invalid("forbidden");
  if (!allowDeleting && workspace.status !== "active") invalid("unavailable");
  return workspace;
}

export async function createWorkspace(actorId: string, value: string) {
  const name = workspaceName(value);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "workspace";
  // Random suffix also avoids reserved auth paths and concurrent slug races.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            name,
            slug: `${base}-${randomBytes(4).toString("hex")}`,
            ownerId: actorId,
            members: { create: { userId: actorId, role: "owner" } },
          },
        });
        await writeAudit(tx, {
          actorId,
          workspaceId: workspace.id,
          action: "workspace.created",
          targetType: "workspace",
          targetId: workspace.id,
        });
        return workspace;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002" || attempt === 2)
        throw error;
    }
  }
  return invalid("failed");
}

export async function renameWorkspace(
  actorId: string,
  slug: string,
  value: string,
) {
  const name = workspaceName(value);
  return db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await tx.workspace.update({ where: { id: workspace.id }, data: { name } });
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action: "workspace.renamed",
      targetType: "workspace",
      targetId: workspace.id,
      changes: { name },
    });
  });
}

function invitationEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    invalid("invalidEmail");
  return email;
}

async function inviteRecipient(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  email: string,
) {
  const recipient = await tx.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      ownedWorkspaces: { where: { id: workspaceId }, select: { id: true } },
      memberships: { where: { workspaceId }, select: { workspaceId: true } },
    },
  });
  if (recipient?.ownedWorkspaces.length || recipient?.memberships.length)
    invalid("alreadyMember");
  if (recipient && recipient.status !== "active")
    invalid("recipientUnavailable");
  return recipient;
}

async function requireActiveInvitationActor(
  tx: Prisma.TransactionClient,
  actorId: string,
) {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { email: true, status: true },
  });
  if (actor?.status !== "active") invalid("forbidden");
  return actor;
}

export async function previewWorkspaceInviteRecipient(
  actorId: string,
  slug: string,
  value: string,
): Promise<{ id: string; name: string | null; email: string } | null> {
  const email = invitationEmail(value);
  return db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await requireActiveInvitationActor(tx, actorId);
    const recipient = await inviteRecipient(tx, workspace.id, email);
    return recipient
      ? { id: recipient.id, name: recipient.name, email: recipient.email }
      : null;
  });
}

export async function inviteWorkspaceMember(
  actorId: string,
  slug: string,
  input: { email: string; recipientId: string | null },
): Promise<string> {
  const email = invitationEmail(input.email);
  if (
    input.recipientId !== null &&
    (typeof input.recipientId !== "string" ||
      !input.recipientId ||
      input.recipientId.length > 200)
  )
    invalid("recipientChanged");
  const token = randomBytes(32).toString("hex");
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await requireActiveInvitationActor(tx, actorId);
    const recipient = await inviteRecipient(tx, workspace.id, email);
    if ((recipient?.id ?? null) !== input.recipientId)
      invalid("recipientChanged");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 86400_000);
    const invitation = await tx.workspaceInvitation.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
      create: {
        workspaceId: workspace.id,
        email,
        tokenHash: hashToken(token),
        expiresAt,
      },
      update: { tokenHash: hashToken(token), expiresAt, createdAt: now },
    });
    if (recipient) {
      const data = {
        kind: "workspace_invitation" as const,
        senderId: actorId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        createdAt: now,
      };
      const notification = await tx.notification.upsert({
        where: { invitationId: invitation.id },
        create: { ...data, invitationId: invitation.id },
        update: data,
      });
      await tx.notificationRecipient.deleteMany({
        where: {
          notificationId: notification.id,
          userId: { not: recipient.id },
        },
      });
      await tx.notificationRecipient.upsert({
        where: {
          notificationId_userId: {
            notificationId: notification.id,
            userId: recipient.id,
          },
        },
        create: {
          notificationId: notification.id,
          userId: recipient.id,
          createdAt: now,
        },
        update: { createdAt: now, readAt: null },
      });
    } else {
      await tx.notification.updateMany({
        where: { invitationId: invitation.id },
        data: { invitationId: null },
      });
    }
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action: "workspace.invited",
      targetType: "workspaceInvitation",
      targetId: invitation.id,
    });
  });
  // Fragments are not sent in HTTP request URLs or access logs.
  return `/app?view=invitation#invite=${token}`;
}

export async function getWorkspaceInvitation(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.workspaceInvitation.findFirst({
    where: {
      tokenHash: hashToken(token),
      expiresAt: { gt: new Date() },
      workspace: { status: "active" },
    },
    select: {
      id: true,
      email: true,
      workspaceId: true,
      workspace: { select: { name: true, slug: true } },
      notification: { select: { recipients: { select: { userId: true } } } },
    },
  });
}

async function consumeWorkspaceInvitation(
  actorId: string,
  credential:
    | { kind: "token"; token: string }
    | { kind: "notification"; notificationId: string },
): Promise<string> {
  if (credential.kind === "token" && !/^[a-f0-9]{64}$/.test(credential.token))
    invalid("invalidInvitation");
  const where: Prisma.WorkspaceInvitationWhereInput =
    credential.kind === "token"
      ? { tokenHash: hashToken(credential.token) }
      : {
          notification: {
            id: credential.notificationId,
            kind: "workspace_invitation",
            recipients: { some: { userId: actorId } },
          },
        };
  return db.$transaction(async (tx) => {
    const located = await tx.workspaceInvitation.findFirst({
      where,
      select: { workspaceId: true },
    });
    if (!located) invalid("invalidInvitation");
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${located.workspaceId} FOR UPDATE`;
    const invitation = await tx.workspaceInvitation.findFirst({
      where: {
        ...where,
        workspaceId: located.workspaceId,
        expiresAt: { gt: new Date() },
        workspace: { status: "active" },
      },
      select: {
        id: true,
        email: true,
        workspaceId: true,
        workspace: { select: { slug: true } },
        notification: {
          select: { id: true, recipients: { select: { userId: true } } },
        },
      },
    });
    if (!invitation) invalid("invalidInvitation");
    const user = await requireActiveInvitationActor(tx, actorId);
    if (
      invitation.notification &&
      !invitation.notification.recipients.some(
        (receipt) => receipt.userId === actorId,
      )
    )
      invalid("invalidInvitation");
    if (user.email.toLowerCase() !== invitation.email) invalid("wrongEmail");
    const consumed = await tx.workspaceInvitation.deleteMany({
      where: {
        ...where,
        id: invitation.id,
        expiresAt: { gt: new Date() },
        workspace: { status: "active" },
      },
    });
    if (consumed.count !== 1) invalid("invalidInvitation");
    await tx.membership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId: actorId,
        },
      },
      create: {
        workspaceId: invitation.workspaceId,
        userId: actorId,
        role: "member",
      },
      update: {},
    });
    if (invitation.notification) {
      await tx.notificationRecipient.updateMany({
        where: {
          notificationId: invitation.notification.id,
          userId: actorId,
          readAt: null,
        },
        data: { readAt: new Date() },
      });
    }
    await writeAudit(tx, {
      actorId,
      workspaceId: invitation.workspaceId,
      action: "workspace.joined",
      targetType: "workspace",
      targetId: invitation.workspaceId,
    });
    return invitation.workspace.slug;
  });
}

export async function acceptWorkspaceInvitation(
  actorId: string,
  token: string,
): Promise<string> {
  return consumeWorkspaceInvitation(actorId, { kind: "token", token });
}

export async function acceptWorkspaceInvitationNotification(
  actorId: string,
  notificationId: string,
): Promise<string> {
  return consumeWorkspaceInvitation(actorId, {
    kind: "notification",
    notificationId,
  });
}

export async function revokeWorkspaceInvitation(
  actorId: string,
  slug: string,
  invitationId: string,
) {
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    await tx.workspaceInvitation.deleteMany({
      where: { id: invitationId, workspaceId: workspace.id },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action: "workspace.invitation_revoked",
      targetType: "workspaceInvitation",
      targetId: invitationId,
    });
  });
}

export async function removeWorkspaceMember(
  actorId: string,
  slug: string,
  memberId: string,
) {
  const workspaceId = await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(
      tx,
      slug,
      actorId,
      memberId !== actorId,
      memberId === actorId,
    );
    if (memberId === workspace.ownerId) invalid("transferFirst");
    const result = await tx.membership.deleteMany({
      where: { workspaceId: workspace.id, userId: memberId },
    });
    if (!result.count) invalid("memberMissing");
    const member = await tx.user.findUnique({
      where: { id: memberId },
      select: { email: true },
    });
    if (member)
      await tx.workspaceInvitation.deleteMany({
        where: { workspaceId: workspace.id, email: member.email.toLowerCase() },
      });
    await tx.apiToken.deleteMany({
      where: { userId: memberId, toolkit: { workspaceId: workspace.id } },
    });
    await tx.toolkitInstallation.updateMany({
      where: { userId: memberId, toolkit: { workspaceId: workspace.id } },
      data: { status: "revoked" },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action:
        memberId === actorId ? "workspace.left" : "workspace.member_removed",
      targetType: "user",
      targetId: memberId,
    });
    return workspace.id;
  });
  revokeWorkspaceStreams(workspaceId, memberId);
  return workspaceId;
}

export async function setWorkspaceMemberRole(
  actorId: string,
  slug: string,
  memberId: string,
  role: "admin" | "member",
): Promise<void> {
  if (role !== "admin" && role !== "member") invalid("forbidden");
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    if (memberId === actorId || memberId === workspace.ownerId)
      invalid("forbidden");
    const member = await tx.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: memberId },
      },
      include: { user: { select: { status: true } } },
    });
    if (!member || (role === "admin" && member.user.status !== "active"))
      invalid("memberMissing");
    if (member.role === "owner") invalid("forbidden");
    if (member.role === role) return;
    await tx.membership.update({ where: { id: member.id }, data: { role } });
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action: "workspace.member_role_changed",
      targetType: "user",
      targetId: memberId,
      changes: { before: { role: member.role }, after: { role } },
    });
  });
}

export async function transferWorkspaceOwnership(
  actorId: string,
  slug: string,
  memberId: string,
  confirmation: string,
) {
  await db.$transaction(async (tx) => {
    const workspace = await lockedWorkspace(tx, slug, actorId);
    if (confirmation !== workspace.name) invalid("confirmName");
    if (memberId === actorId) invalid("memberMissing");
    const member = await tx.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: memberId },
      },
      include: { user: { select: { status: true } } },
    });
    if (member?.user.status !== "active") invalid("memberMissing");
    await tx.workspace.update({
      where: { id: workspace.id },
      data: { ownerId: memberId },
    });
    await tx.membership.upsert({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: actorId },
      },
      create: { workspaceId: workspace.id, userId: actorId, role: "member" },
      update: { role: "member" },
    });
    await tx.membership.update({
      where: { id: member.id },
      data: { role: "owner" },
    });
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace.id,
      action: "workspace.ownership_transferred",
      targetType: "user",
      targetId: memberId,
    });
  });
}

const deletionGlobal = globalThis as typeof globalThis & {
  __workspaceDeletions?: Set<string>;
};

export async function deleteWorkspace(
  actorId: string,
  slug: string,
  confirmation: string,
) {
  // ponytail: one server process deduplicates teardown; use a renewable DB lease
  // if workspace management is served by multiple independent workers.
  deletionGlobal.__workspaceDeletions ??= new Set<string>();
  const deleting = deletionGlobal.__workspaceDeletions;
  if (deleting.has(slug)) invalid("deleting");
  deleting.add(slug);
  let workspaceId: string | undefined;
  try {
    workspaceId = await db.$transaction(async (tx) => {
      const workspace = await lockedWorkspace(tx, slug, actorId, true, true);
      if (confirmation !== workspace.name) invalid("confirmName");
      await tx.workspace.update({
        where: { id: workspace.id },
        data: { status: "deleting" },
      });
      await writeAudit(tx, {
        actorId,
        workspaceId: workspace.id,
        action: "workspace.deletion_started",
        targetType: "workspace",
        targetId: workspace.id,
      });
      return workspace.id;
    });
    revokeWorkspaceStreams(workspaceId);
    await killWorkspaceProcesses(workspaceId);
    const deletedWorkspaceId = workspaceId;
    await db.$transaction(async (tx) => {
      await tx.workspace.delete({ where: { id: deletedWorkspaceId } });
      await writeAudit(tx, {
        actorId,
        workspaceId: deletedWorkspaceId,
        action: "workspace.deleted",
        targetType: "workspace",
        targetId: deletedWorkspaceId,
      });
    });
  } catch (error) {
    if (workspaceId) {
      await db.workspace.updateMany({
        where: { id: workspaceId },
        data: { status: "delete_failed" },
      });
      invalid("deleteFailed");
    }
    throw error;
  } finally {
    deleting.delete(slug);
  }
}
