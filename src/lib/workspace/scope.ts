import "server-only";
import type { Prisma, Workspace } from "@prisma/client";
import { db } from "@/lib/db";
import { enrichLogContext } from "@/lib/observability/context";
import {
  effectiveWorkspacePermissions,
  MANAGER_ROLES,
  workspaceRoleOf,
  type WorkspacePermission,
  type WorkspaceRole,
} from "./permissions";

/** "read" is membership; every other capability is one management permission. */
export type WorkspaceCapability = "read" | WorkspacePermission;
type WorkspaceTarget =
  | { id: string; slug?: never }
  | { slug: string; id?: never };

// A nominal brand is lost when the object is spread, so callers cannot clone
// a scope and replace the workspace ID or actor while preserving authority.
declare class ScopeBrand<C extends WorkspaceCapability> {
  private readonly workspaceScopeBrand: C;
}

/** Request-local authority; do not persist or pass across a client boundary. */
export type WorkspaceScope<
  C extends WorkspaceCapability = WorkspaceCapability,
> = Readonly<Workspace> &
  ScopeBrand<C> & {
    readonly actorUserId: string;
    readonly role: WorkspaceRole;
    readonly capability: C;
    /** Effective management permissions of the actor when the scope resolved. */
    readonly permissions: readonly WorkspacePermission[];
  };

/**
 * Membership predicate for one management permission: manager roles unless
 * individually revoked, other roles only when individually granted.
 */
export function membershipPermissionWhere(
  permission: WorkspacePermission,
): Prisma.MembershipWhereInput {
  return {
    OR: [
      {
        role: { in: [...MANAGER_ROLES] },
        NOT: { revokedPermissions: { has: permission } },
      },
      {
        role: { notIn: [...MANAGER_ROLES] },
        grantedPermissions: { has: permission },
      },
    ],
  };
}

export function workspaceAccessWhere(
  actorUserId: string,
  capability: WorkspaceCapability = "read",
  includeInactive = false,
): Prisma.WorkspaceWhereInput {
  return {
    ...(includeInactive ? {} : { status: "active" }),
    OR: [
      { ownerId: actorUserId, owner: { status: "active" } },
      {
        members: {
          some: {
            userId: actorUserId,
            user: { status: "active" },
            ...(capability === "read"
              ? {}
              : membershipPermissionWhere(capability)),
          },
        },
      },
    ],
  };
}

export function workspaceScopeWhere(
  scope: WorkspaceScope,
): Prisma.WorkspaceWhereInput {
  return {
    id: scope.id,
    ...workspaceAccessWhere(scope.actorUserId, scope.capability),
  };
}

export function resolveWorkspaceScope(
  target: WorkspaceTarget,
  actorUserId: string,
): Promise<WorkspaceScope<"read"> | null>;
export function resolveWorkspaceScope<C extends WorkspaceCapability>(
  target: WorkspaceTarget,
  actorUserId: string,
  capability: C,
  client?: Prisma.TransactionClient,
): Promise<WorkspaceScope<C> | null>;
export async function resolveWorkspaceScope(
  target: WorkspaceTarget,
  actorUserId: string,
  capability: WorkspaceCapability = "read",
  client: Prisma.TransactionClient = db,
): Promise<WorkspaceScope | null> {
  const id = target.id;
  const value = id ?? target.slug;
  if (typeof value !== "string" || !value || !actorUserId) return null;
  const identity = id === undefined ? { slug: value } : { id: value };
  const row = await client.workspace.findFirst({
    where: { ...identity, ...workspaceAccessWhere(actorUserId, capability) },
    include: {
      members: {
        where: { userId: actorUserId },
        select: {
          role: true,
          grantedPermissions: true,
          revokedPermissions: true,
        },
      },
    },
  });
  if (!row) return null;
  const { members, ...workspace } = row;
  const membership = members[0];
  const role = workspaceRoleOf(
    workspace.ownerId,
    actorUserId,
    membership?.role,
  );
  enrichLogContext({ workspaceId: workspace.id, actorId: actorUserId });
  return Object.freeze({
    ...workspace,
    actorUserId,
    role,
    capability,
    permissions: Object.freeze(
      effectiveWorkspacePermissions(
        role,
        membership?.grantedPermissions ?? [],
        membership?.revokedPermissions ?? [],
      ),
    ),
  }) as WorkspaceScope;
}
