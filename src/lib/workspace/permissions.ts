// Shared by server authorization and client display; keep free of server imports.

/** Management domains a workspace member may hold beyond read access. */
export const WORKSPACE_PERMISSIONS = [
  "resources",
  "agents",
  "plugins",
  "notifications",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type WorkspaceRole = "owner" | "admin" | "member";

/** Membership roles whose defaults include every management permission. */
export const MANAGER_ROLES = ["owner", "admin"] as const;

export function isWorkspacePermission(
  value: unknown,
): value is WorkspacePermission {
  return (WORKSPACE_PERMISSIONS as readonly unknown[]).includes(value);
}

export function roleHasPermissionByDefault(role: WorkspaceRole): boolean {
  return role !== "member";
}

/** Keep only known permissions, deduplicated in catalog order. */
export function normalizeWorkspacePermissions(
  values: readonly unknown[],
): WorkspacePermission[] {
  return WORKSPACE_PERMISSIONS.filter((permission) =>
    values.includes(permission),
  );
}

export type WorkspacePermissionState = {
  permission: WorkspacePermission;
  byDefault: boolean;
  adjustment: "granted" | "revoked" | null;
  effective: boolean;
};

/**
 * Role default plus per-member adjustment. The owner always holds every
 * permission; an adjustment that matches the role default has no effect.
 */
export function workspacePermissionStates(
  role: WorkspaceRole,
  granted: readonly string[],
  revoked: readonly string[],
): WorkspacePermissionState[] {
  return WORKSPACE_PERMISSIONS.map((permission) => {
    const byDefault = roleHasPermissionByDefault(role);
    const adjustment =
      role === "owner"
        ? null
        : byDefault
          ? revoked.includes(permission)
            ? "revoked"
            : null
          : granted.includes(permission)
            ? "granted"
            : null;
    return {
      permission,
      byDefault,
      adjustment,
      effective: adjustment ? adjustment === "granted" : byDefault,
    };
  });
}

export function effectiveWorkspacePermissions(
  role: WorkspaceRole,
  granted: readonly string[],
  revoked: readonly string[],
): WorkspacePermission[] {
  return workspacePermissionStates(role, granted, revoked)
    .filter((state) => state.effective)
    .map((state) => state.permission);
}

export function workspaceRoleOf(
  ownerId: string,
  userId: string,
  membershipRole: string | undefined,
): WorkspaceRole {
  if (ownerId === userId || membershipRole === "owner") return "owner";
  return membershipRole === "admin" ? "admin" : "member";
}
