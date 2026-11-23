// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import { createWorkspace } from "@/lib/workspace/management";
import { listUserWorkspaceAccess } from "@/lib/admin/workspace-members";
import {
  addWorkspaceMemberAdminAction,
  removeWorkspaceMemberAdminAction,
  setWorkspaceMemberPermissionAdminAction,
  setWorkspaceMemberRoleAdminAction,
} from "@/lib/admin/workspace-member-actions";

const effects = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: effects.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

const stamp = randomUUID();
const userIds: string[] = [];

async function user(name: string, role: "admin" | "user" = "user") {
  const created = await db.user.create({
    data: {
      email: `admin-access-${name}-${stamp}@example.test`,
      passwordHash: "test-only",
      role,
    },
  });
  userIds.push(created.id);
  return created;
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

afterAll(async () => {
  await db.workspace.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

beforeEach(() => effects.user.mockReset());

describe("platform admin workspace access", () => {
  it("manages membership, roles and per-user permissions per workspace", async () => {
    const admin = await user("admin", "admin");
    const owner = await user("owner");
    const target = await user("target");
    const peer = await user("peer");
    const a = await createWorkspace(owner.id, "Workspace A");
    const b = await createWorkspace(owner.id, "Workspace B");
    await db.membership.create({
      data: { workspaceId: a.id, userId: peer.id, role: "member" },
    });
    effects.user.mockResolvedValue(admin);

    expect(
      await addWorkspaceMemberAdminAction(
        {},
        form({ workspaceId: a.id, userId: target.id, role: "member" }),
      ),
    ).toEqual({ ok: true });
    expect(
      await addWorkspaceMemberAdminAction(
        {},
        form({ workspaceId: b.id, userId: target.id, role: "admin" }),
      ),
    ).toEqual({ ok: true });
    expect(
      await addWorkspaceMemberAdminAction(
        {},
        form({ workspaceId: a.id, userId: target.id, role: "member" }),
      ),
    ).toEqual({ error: "adminWorkspaceAccess.errors.alreadyMember" });

    // Different roles per workspace: member in A, admin in B.
    expect(
      (await resolveWorkspaceScope({ id: a.id }, target.id))?.permissions,
    ).toEqual([]);
    expect(
      (await resolveWorkspaceScope({ id: b.id }, target.id))?.permissions,
    ).toEqual(["resources", "agents", "plugins", "notifications"]);
    expect(
      await resolveWorkspaceScope({ id: a.id }, target.id, "plugins"),
    ).toBeNull();

    // Grant one permission in A to this member only.
    await setWorkspaceMemberPermissionAdminAction(
      {},
      form({
        workspaceId: a.id,
        userId: target.id,
        permission: "plugins",
        enabled: "true",
      }),
    );
    expect(
      await resolveWorkspaceScope({ id: a.id }, target.id, "plugins"),
    ).toMatchObject({ role: "member", permissions: ["plugins"] });
    expect(
      await resolveWorkspaceScope({ id: a.id }, target.id, "agents"),
    ).toBeNull();
    expect(
      await resolveWorkspaceScope({ id: a.id }, peer.id, "plugins"),
    ).toBeNull();

    // Revoke one permission in B: a scope resolved earlier no longer matches.
    const agentsScope = await resolveWorkspaceScope(
      { id: b.id },
      target.id,
      "agents",
    );
    if (!agentsScope) throw new Error("admin scope was not resolved");
    await setWorkspaceMemberPermissionAdminAction(
      {},
      form({
        workspaceId: b.id,
        userId: target.id,
        permission: "agents",
        enabled: "false",
      }),
    );
    expect(
      await db.workspace.findFirst({ where: workspaceScopeWhere(agentsScope) }),
    ).toBeNull();
    expect(
      await resolveWorkspaceScope({ id: b.id }, target.id, "agents"),
    ).toBeNull();
    expect(
      await resolveWorkspaceScope({ id: b.id }, target.id, "plugins"),
    ).not.toBeNull();
    // Workspace A is unaffected and the platform role is unchanged.
    expect(
      (await resolveWorkspaceScope({ id: a.id }, target.id))?.permissions,
    ).toEqual(["plugins"]);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: target.id } })).role,
    ).toBe("user");

    const access = await listUserWorkspaceAccess(target.id);
    const inB = access.find((row) => row.workspace.id === b.id);
    expect(inB?.role).toBe("admin");
    expect(
      inB?.permissions.find((state) => state.permission === "agents"),
    ).toEqual({
      permission: "agents",
      byDefault: true,
      adjustment: "revoked",
      effective: false,
    });

    // Setting the role default again clears the adjustment.
    await setWorkspaceMemberPermissionAdminAction(
      {},
      form({
        workspaceId: b.id,
        userId: target.id,
        permission: "agents",
        enabled: "true",
      }),
    );
    expect(
      await db.membership.findUniqueOrThrow({
        where: { workspaceId_userId: { workspaceId: b.id, userId: target.id } },
        select: { grantedPermissions: true, revokedPermissions: true },
      }),
    ).toEqual({ grantedPermissions: [], revokedPermissions: [] });

    // A role change is a new baseline and drops adjustments.
    await setWorkspaceMemberRoleAdminAction(
      {},
      form({ workspaceId: a.id, userId: target.id, role: "admin" }),
    );
    await setWorkspaceMemberRoleAdminAction(
      {},
      form({ workspaceId: a.id, userId: target.id, role: "member" }),
    );
    expect(
      (await resolveWorkspaceScope({ id: a.id }, target.id))?.permissions,
    ).toEqual([]);

    // The owner is never adjusted or removed from here.
    expect(
      await setWorkspaceMemberPermissionAdminAction(
        {},
        form({
          workspaceId: a.id,
          userId: owner.id,
          permission: "agents",
          enabled: "false",
        }),
      ),
    ).toEqual({ error: "adminWorkspaceAccess.errors.ownerLocked" });
    expect(
      await removeWorkspaceMemberAdminAction(
        {},
        form({ workspaceId: a.id, userId: owner.id }),
      ),
    ).toEqual({ error: "adminWorkspaceAccess.errors.transferFirst" });

    expect(
      await removeWorkspaceMemberAdminAction(
        {},
        form({ workspaceId: a.id, userId: target.id }),
      ),
    ).toEqual({ ok: true });
    expect(await resolveWorkspaceScope({ id: a.id }, target.id)).toBeNull();
    expect(await resolveWorkspaceScope({ id: b.id }, target.id)).not.toBeNull();
  });

  it("rejects the admin actions for anyone but a platform admin", async () => {
    const owner = await user("owner2");
    const target = await user("target2");
    const workspace = await createWorkspace(owner.id, "Workspace C");
    await db.membership.create({
      data: { workspaceId: workspace.id, userId: target.id, role: "member" },
    });
    // Even the workspace owner cannot use the platform admin path.
    effects.user.mockResolvedValue(owner);
    await expect(
      setWorkspaceMemberPermissionAdminAction(
        {},
        form({
          workspaceId: workspace.id,
          userId: target.id,
          permission: "resources",
          enabled: "true",
        }),
      ),
    ).rejects.toThrow("redirect:/");
    effects.user.mockResolvedValue(target);
    await expect(
      setWorkspaceMemberRoleAdminAction(
        {},
        form({ workspaceId: workspace.id, userId: target.id, role: "admin" }),
      ),
    ).rejects.toThrow("redirect:/");
    expect(
      await db.membership.findUniqueOrThrow({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: target.id },
        },
        select: { role: true, grantedPermissions: true },
      }),
    ).toEqual({ role: "member", grantedPermissions: [] });
  });
});
