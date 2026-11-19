import "server-only";
import type { Prisma, Workspace } from "@prisma/client";
import { db } from "@/lib/db";
import { enrichLogContext } from "@/lib/observability/context";

export type WorkspaceCapability = "read" | "manage";
type WorkspaceRole = "owner" | "admin" | "member";
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
  };

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
            ...(capability === "manage"
              ? { role: { in: ["owner", "admin"] } }
              : {}),
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
      members: { where: { userId: actorUserId }, select: { role: true } },
    },
  });
  if (!row) return null;
  const { members, ...workspace } = row;
  const membershipRole = members[0]?.role;
  const role =
    workspace.ownerId === actorUserId || membershipRole === "owner"
      ? "owner"
      : membershipRole === "admin"
        ? "admin"
        : "member";
  enrichLogContext({ workspaceId: workspace.id, actorId: actorUserId });
  return Object.freeze({
    ...workspace,
    actorUserId,
    role,
    capability,
  }) as WorkspaceScope;
}
