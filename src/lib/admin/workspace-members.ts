import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { revokeWorkspaceStreams } from "@/lib/workspace/access-stream";
import {
  changeWorkspaceMemberRole,
  detachWorkspaceMember,
  WorkspaceManagementError,
} from "@/lib/workspace/management";
import {
  isWorkspacePermission,
  roleHasPermissionByDefault,
  workspacePermissionStates,
  workspaceRoleOf,
  type WorkspacePermission,
  type WorkspacePermissionState,
  type WorkspaceRole,
} from "@/lib/workspace/permissions";

// Platform-admin membership management. Authority comes from the caller
// (`actionScope({ admin: true })`); these functions never consult workspace
// roles of the acting admin and never change the target's platform role.

export type AdminWorkspaceAccess = {
  workspace: { id: string; slug: string; name: string; status: string };
  role: WorkspaceRole;
  permissions: WorkspacePermissionState[];
};

export async function listUserWorkspaceAccess(
  userId: string,
): Promise<AdminWorkspaceAccess[]> {
  const workspaces = await db.workspace.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      ownerId: true,
      members: {
        where: { userId },
        select: {
          role: true,
          grantedPermissions: true,
          revokedPermissions: true,
        },
      },
    },
  });
  return workspaces.map(({ ownerId, members, ...workspace }) => {
    const membership = members[0];
    const role = workspaceRoleOf(ownerId, userId, membership?.role);
    return {
      workspace,
      role,
      permissions: workspacePermissionStates(
        role,
        membership?.grantedPermissions ?? [],
        membership?.revokedPermissions ?? [],
      ),
    };
  });
}

/** Active workspaces the user does not belong to, for the add-member picker. */
export async function searchJoinableWorkspaces(userId: string, query: string) {
  const q = query.trim().slice(0, 80);
  return db.workspace.findMany({
    where: {
      status: "active",
      ownerId: { not: userId },
      members: { none: { userId } },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 20,
    select: { id: true, slug: true, name: true },
  });
}

function invalid(code: string): never {
  throw new WorkspaceManagementError(code);
}

async function lockWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerId: true, status: true },
  });
  if (!workspace) invalid("workspaceMissing");
  if (workspace.status !== "active") invalid("unavailable");
  return workspace;
}

export async function adminAddWorkspaceMember(
  adminId: string,
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
) {
  if (role !== "admin" && role !== "member") invalid("forbidden");
  await db.$transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user) invalid("userMissing");
    if (user.status !== "active") invalid("inactiveUser");
    if (workspace.ownerId === userId) invalid("alreadyMember");
    const existing = await tx.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { id: true },
    });
    if (existing) invalid("alreadyMember");
    await tx.membership.create({ data: { workspaceId, userId, role } });
    await writeAudit(tx, {
      actorId: adminId,
      workspaceId,
      action: "admin.workspace.member_added",
      targetType: "user",
      targetId: userId,
      changes: { after: { role } },
    });
  });
}

export async function adminSetWorkspaceMemberRole(
  adminId: string,
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
) {
  await db.$transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const before = await changeWorkspaceMemberRole(tx, workspace, userId, role);
    if (before === null) return;
    await writeAudit(tx, {
      actorId: adminId,
      workspaceId,
      action: "admin.workspace.member_role_changed",
      targetType: "user",
      targetId: userId,
      changes: { before: { role: before }, after: { role } },
    });
  });
}

export async function adminRemoveWorkspaceMember(
  adminId: string,
  workspaceId: string,
  userId: string,
) {
  await db.$transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    if (workspace.ownerId === userId) invalid("transferFirst");
    await detachWorkspaceMember(tx, workspaceId, userId);
    await writeAudit(tx, {
      actorId: adminId,
      workspaceId,
      action: "admin.workspace.member_removed",
      targetType: "user",
      targetId: userId,
    });
  });
  revokeWorkspaceStreams(workspaceId, userId);
}

/**
 * Set whether one member holds one permission. Matching the role default
 * clears the individual adjustment; other members are untouched.
 */
export async function adminSetWorkspaceMemberPermission(
  adminId: string,
  workspaceId: string,
  userId: string,
  permission: WorkspacePermission,
  enabled: boolean,
) {
  if (!isWorkspacePermission(permission)) invalid("forbidden");
  await db.$transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    if (workspace.ownerId === userId) invalid("ownerLocked");
    const member = await tx.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: {
        id: true,
        role: true,
        grantedPermissions: true,
        revokedPermissions: true,
      },
    });
    if (!member) invalid("memberMissing");
    const role = workspaceRoleOf(workspace.ownerId, userId, member.role);
    if (role === "owner") invalid("ownerLocked");
    const byDefault = roleHasPermissionByDefault(role);
    const granted = member.grantedPermissions.filter((v) => v !== permission);
    const revoked = member.revokedPermissions.filter((v) => v !== permission);
    if (enabled !== byDefault) (enabled ? granted : revoked).push(permission);
    await tx.membership.update({
      where: { id: member.id },
      data: { grantedPermissions: granted, revokedPermissions: revoked },
    });
    await writeAudit(tx, {
      actorId: adminId,
      workspaceId,
      action: "admin.workspace.member_permission_changed",
      targetType: "user",
      targetId: userId,
      changes: { permission, enabled, byDefault },
    });
  });
}
