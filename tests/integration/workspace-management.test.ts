// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { createApiToken, verifyApiTokenContext } from "@/lib/auth/tokens";
import {
  getDefaultWorkspace,
  getWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/workspace/queries";
import {
  createWorkspace,
  renameWorkspace,
  inviteWorkspaceMember,
  getWorkspaceInvitation,
  acceptWorkspaceInvitation,
  revokeWorkspaceInvitation,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  transferWorkspaceOwnership,
  deleteWorkspace,
} from "@/lib/workspace/management";
import * as audit from "@/lib/observability/audit";
import { listNotifications } from "@/lib/notifications/service";
import {
  previewWorkspaceInviteRecipient,
  acceptWorkspaceInvitationNotification,
} from "@/lib/workspace/management";
import { hashToken } from "@/lib/auth/token-format";
import { killWorkspaceProcesses } from "@/lib/workspace/teardown";
import { GET as manifest } from "@/app/api/v1/workspaces/[slug]/manifest/route";

vi.mock("@/lib/workspace/teardown", () => ({
  killWorkspaceProcesses: vi.fn(),
}));

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const userIds: string[] = [];
let owner: string;
let member: string;
let outsider: string;
let workspace: Awaited<ReturnType<typeof createWorkspace>>;
const email = (name: string) => `workspace-flow-${name}-${stamp}@example.test`;
const tokenFrom = (path: string) =>
  assertDefined(
    new URLSearchParams(new URL(path, "http://localhost").hash.slice(1)).get(
      "invite",
    ),
  );

beforeAll(async () => {
  for (const name of ["owner", "member", "outsider"]) {
    const user = await db.user.create({
      data: { email: email(name), passwordHash: "test-only" },
    });
    userIds.push(user.id);
  }
  [owner, member, outsider] = userIds;
});

beforeEach(async () => {
  vi.mocked(killWorkspaceProcesses).mockReset().mockResolvedValue();
  workspace = await createWorkspace(owner, "研发团队");
  await db.membership.create({
    data: { workspaceId: workspace.id, userId: member },
  });
});

afterAll(async () => {
  // These accounts and all their workspaces were created by this test file.
  await db.workspace.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.notification.deleteMany({ where: { senderId: { in: userIds } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("workspace lifecycle and authorization", () => {
  it("creates Chinese names with stable, unique URLs and validates names on the server", async () => {
    const another = await createWorkspace(owner, "研发团队");
    expect(another.slug).not.toBe(workspace.slug);
    expect(workspace.name).toBe("研发团队");
    expect(workspace.slug).toMatch(/^workspace-[a-f0-9]{8}$/);
    await renameWorkspace(owner, workspace.slug, "新的名称");
    expect(await getWorkspaceForUser(workspace.slug, owner)).toMatchObject({
      name: "新的名称",
      slug: workspace.slug,
    });
    await expect(createWorkspace(owner, "   ")).rejects.toThrow("invalidName");
    await expect(
      renameWorkspace(owner, workspace.slug, "x".repeat(81)),
    ).rejects.toThrow("invalidName");
  });

  it("does not silently create a default workspace and validates remembered access", async () => {
    expect(await getDefaultWorkspace(outsider, workspace.slug)).toBeNull();
    expect(await db.workspace.count({ where: { ownerId: outsider } })).toBe(0);
    expect(await getDefaultWorkspace(owner, workspace.slug)).toMatchObject({
      id: workspace.id,
    });
  });

  it("rejects member and outsider management, including forged member targets", async () => {
    await expect(
      renameWorkspace(member, workspace.slug, "Hijacked"),
    ).rejects.toThrow("forbidden");
    await expect(
      inviteWorkspaceMember(member, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      removeWorkspaceMember(member, workspace.slug, owner),
    ).rejects.toThrow("forbidden");
    await expect(
      removeWorkspaceMember(outsider, workspace.slug, outsider),
    ).rejects.toThrow("forbidden");
    await expect(
      revokeWorkspaceInvitation(outsider, workspace.slug, "unknown"),
    ).rejects.toThrow("forbidden");
    await expect(
      transferWorkspaceOwnership(
        member,
        workspace.slug,
        outsider,
        workspace.name,
      ),
    ).rejects.toThrow("forbidden");
    await expect(
      deleteWorkspace(member, workspace.slug, workspace.name),
    ).rejects.toThrow("forbidden");
    expect(killWorkspaceProcesses).not.toHaveBeenCalled();
  });

  it("invites unregistered accounts without granting membership and requires the invited email to accept", async () => {
    const pending = await inviteWorkspaceMember(owner, workspace.slug, {
      email: email("not-registered"),
      recipientId: null,
    });
    expect(await getWorkspaceInvitation(tokenFrom(pending))).toMatchObject({
      email: email("not-registered"),
    });
    const path = await inviteWorkspaceMember(owner, workspace.slug, {
      email: email("outsider").toUpperCase(),
      recipientId: outsider,
    });
    const token = tokenFrom(path);
    const saved = await db.workspaceInvitation.findUnique({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email: email("outsider"),
        },
      },
    });
    expect(saved?.tokenHash).not.toBe(token);
    expect(await getWorkspaceForUser(workspace.slug, outsider)).toBeNull();
    await expect(acceptWorkspaceInvitation(member, token)).rejects.toThrow(
      "invalidInvitation",
    );
    expect(await acceptWorkspaceInvitation(outsider, token)).toBe(
      workspace.slug,
    );
    expect(await getWorkspaceForUser(workspace.slug, outsider)).not.toBeNull();
    await expect(acceptWorkspaceInvitation(outsider, token)).rejects.toThrow(
      "invalidInvitation",
    );
    await expect(
      inviteWorkspaceMember(owner, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    ).rejects.toThrow("alreadyMember");
  });

  it("invalidates replaced, revoked and expired invitations", async () => {
    const first = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    );
    const second = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    );
    expect(await getWorkspaceInvitation(first)).toBeNull();
    const invitation = await getWorkspaceInvitation(second);
    await revokeWorkspaceInvitation(
      owner,
      workspace.slug,
      assertDefined(invitation).id,
    );
    await expect(acceptWorkspaceInvitation(outsider, second)).rejects.toThrow(
      "invalidInvitation",
    );
    const expired = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    );
    await db.workspaceInvitation.updateMany({
      where: { workspaceId: workspace.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(acceptWorkspaceInvitation(outsider, expired)).rejects.toThrow(
      "invalidInvitation",
    );
  });

  it("revokes workspace access and toolkit tokens without deleting personal credentials or shared resources", async () => {
    const toolkit = await db.toolkit.create({
      data: { workspaceId: workspace.id, slug: "shared", name: "Shared" },
    });
    const personal = await createApiToken(member, "personal");
    const scoped = await createApiToken(member, "toolkit", {
      toolkitId: toolkit.id,
    });
    await removeWorkspaceMember(owner, workspace.slug, member);
    expect(await getWorkspaceForUser(workspace.slug, member)).toBeNull();
    expect(
      await verifyApiTokenContext(`Bearer ${personal.token}`),
    ).not.toBeNull();
    expect(await verifyApiTokenContext(`Bearer ${scoped.token}`)).toBeNull();
    expect(
      await db.toolkit.findUnique({ where: { id: toolkit.id } }),
    ).not.toBeNull();
    const response = await manifest(
      new Request("http://localhost/api/manifest", {
        headers: { authorization: `Bearer ${personal.token}` },
      }),
      { params: Promise.resolve({ slug: workspace.slug }) },
    );
    expect(response.status).toBe(404);
  });

  it("allows members to leave, but requires owners to transfer first", async () => {
    await expect(
      removeWorkspaceMember(owner, workspace.slug, owner),
    ).rejects.toThrow("transferFirst");
    await removeWorkspaceMember(member, workspace.slug, member);
    expect(await getWorkspaceForUser(workspace.slug, member)).toBeNull();
    expect(await getWorkspaceForUser(workspace.slug, owner)).not.toBeNull();
  });

  it("changes workspace roles independently of site roles and audits only real changes", async () => {
    await db.user.update({ where: { id: member }, data: { role: "admin" } });
    try {
      await setWorkspaceMemberRole(owner, workspace.slug, member, "admin");
      await setWorkspaceMemberRole(owner, workspace.slug, member, "admin");
      expect(
        await db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: member },
          },
        }),
      ).toMatchObject({ role: "admin" });
      expect(await db.user.findUnique({ where: { id: member } })).toMatchObject(
        { role: "admin" },
      );
      expect(await db.user.findUnique({ where: { id: owner } })).toMatchObject({
        role: "user",
      });
      expect(
        await db.auditEvent.findMany({
          where: {
            workspaceId: workspace.id,
            action: "workspace.member_role_changed",
          },
        }),
      ).toMatchObject([
        {
          actorId: owner,
          targetType: "user",
          targetId: member,
          changes: { before: { role: "member" }, after: { role: "admin" } },
        },
      ]);
      await setWorkspaceMemberRole(owner, workspace.slug, member, "member");
      await setWorkspaceMemberRole(owner, workspace.slug, member, "member");
      expect(await db.user.findUnique({ where: { id: member } })).toMatchObject(
        { role: "admin" },
      );
      const changes = await db.auditEvent.findMany({
        where: {
          workspaceId: workspace.id,
          action: "workspace.member_role_changed",
        },
      });
      expect(changes).toHaveLength(2);
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            changes: { before: { role: "admin" }, after: { role: "member" } },
          }),
        ]),
      );
    } finally {
      await db.user.update({ where: { id: member }, data: { role: "user" } });
    }
  });

  it("rejects non-owner actors, owner and foreign targets, and runtime-invalid roles", async () => {
    const other = await createWorkspace(outsider, "Other workspace");
    await expect(
      setWorkspaceMemberRole(member, workspace.slug, member, "admin"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(outsider, workspace.slug, member, "admin"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(owner, workspace.slug, owner, "member"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(owner, workspace.slug, owner, "admin"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(owner, workspace.slug, outsider, "admin"),
    ).rejects.toThrow("memberMissing");
    await expect(
      setWorkspaceMemberRole(owner, workspace.slug, "missing-user", "admin"),
    ).rejects.toThrow("memberMissing");
    for (const role of ["owner", "", "ADMIN", null, undefined]) {
      await expect(
        setWorkspaceMemberRole(owner, workspace.slug, member, role as "admin"),
      ).rejects.toThrow("forbidden");
    }
    expect(
      await db.auditEvent.count({
        where: {
          workspaceId: workspace.id,
          action: "workspace.member_role_changed",
        },
      }),
    ).toBe(0);
    await setWorkspaceMemberRole(owner, workspace.slug, member, "admin");
    expect(await db.user.findUnique({ where: { id: member } })).toMatchObject({
      role: "user",
    });
    await expect(
      setWorkspaceMemberRole(member, workspace.slug, member, "member"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(member, workspace.slug, owner, "admin"),
    ).rejects.toThrow("forbidden");
    await expect(
      setWorkspaceMemberRole(member, other.slug, outsider, "member"),
    ).rejects.toThrow("forbidden");
    await expect(renameWorkspace(member, workspace.slug, "No")).rejects.toThrow(
      "forbidden",
    );
    await expect(
      inviteWorkspaceMember(member, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      removeWorkspaceMember(member, workspace.slug, owner),
    ).rejects.toThrow("forbidden");
    await expect(
      transferWorkspaceOwnership(member, workspace.slug, owner, workspace.name),
    ).rejects.toThrow("forbidden");
    await expect(
      deleteWorkspace(member, workspace.slug, workspace.name),
    ).rejects.toThrow("forbidden");
    await db.workspace.update({
      where: { id: workspace.id },
      data: { status: "delete_failed" },
    });
    await expect(
      setWorkspaceMemberRole(owner, workspace.slug, member, "member"),
    ).rejects.toThrow("unavailable");
  });

  it("refuses admin grants to suspended members but permits revocation", async () => {
    await db.user.update({
      where: { id: member },
      data: { status: "suspended" },
    });
    try {
      await expect(
        setWorkspaceMemberRole(owner, workspace.slug, member, "admin"),
      ).rejects.toThrow("memberMissing");
      await db.membership.update({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: member },
        },
        data: { role: "admin" },
      });
      await expect(
        setWorkspaceMemberRole(owner, workspace.slug, member, "admin"),
      ).rejects.toThrow("memberMissing");
      await setWorkspaceMemberRole(owner, workspace.slug, member, "member");
      expect(
        await db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: member },
          },
        }),
      ).toMatchObject({ role: "member" });
      expect(
        await db.auditEvent.count({
          where: {
            workspaceId: workspace.id,
            action: "workspace.member_role_changed",
          },
        }),
      ).toBe(1);
    } finally {
      await db.user.update({
        where: { id: member },
        data: { status: "active" },
      });
    }
  });

  it("projects owner, admin and member roles and allows admins to leave", async () => {
    expect(await listWorkspacesForUser(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, role: "owner" }),
      ]),
    );
    expect(await listWorkspacesForUser(member)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, role: "member" }),
      ]),
    );
    await setWorkspaceMemberRole(owner, workspace.slug, member, "admin");
    expect(await listWorkspacesForUser(member)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workspace.id,
          role: "admin",
          memberCount: 2,
        }),
      ]),
    );
    await db.membership.update({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: owner },
      },
      data: { role: "admin" },
    });
    expect(await listWorkspacesForUser(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, role: "owner" }),
      ]),
    );
    await removeWorkspaceMember(member, workspace.slug, member);
    expect(
      (await listWorkspacesForUser(member)).some(
        (item) => item.id === workspace.id,
      ),
    ).toBe(false);
  });

  it("transfers to an existing member atomically and removes the old owner’s management rights", async () => {
    await expect(
      transferWorkspaceOwnership(owner, workspace.slug, member, "wrong name"),
    ).rejects.toThrow("confirmName");
    await expect(
      transferWorkspaceOwnership(
        owner,
        workspace.slug,
        outsider,
        workspace.name,
      ),
    ).rejects.toThrow("memberMissing");
    await db.membership.create({
      data: { workspaceId: workspace.id, userId: outsider, role: "admin" },
    });
    await transferWorkspaceOwnership(
      owner,
      workspace.slug,
      member,
      workspace.name,
    );
    expect(await getWorkspaceForUser(workspace.slug, owner)).toMatchObject({
      ownerId: member,
    });
    const owners = await db.membership.findMany({
      where: { workspaceId: workspace.id, role: "owner" },
    });
    expect(owners.map((item) => item.userId)).toEqual([member]);
    expect(
      await db.membership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: outsider },
        },
      }),
    ).toMatchObject({ role: "admin" });
    expect(
      await db.membership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: owner },
        },
      }),
    ).toMatchObject({ role: "member" });
    await expect(renameWorkspace(owner, workspace.slug, "No")).rejects.toThrow(
      "forbidden",
    );
    await removeWorkspaceMember(owner, workspace.slug, owner);
    expect(await getWorkspaceForUser(workspace.slug, member)).not.toBeNull();
  });

  it("serializes transfer and leave so the owner always remains a member", async () => {
    await Promise.allSettled([
      transferWorkspaceOwnership(owner, workspace.slug, member, workspace.name),
      removeWorkspaceMember(member, workspace.slug, member),
    ]);
    const current = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { members: true },
    });
    expect(
      current.members.some(
        (item) => item.userId === current.ownerId && item.role === "owner",
      ),
    ).toBe(true);
  });

  it("locks failed deletion, refuses unsafe confirmation, and permits a safe cleanup retry", async () => {
    await expect(
      deleteWorkspace(owner, workspace.slug, "wrong"),
    ).rejects.toThrow("confirmName");
    expect(killWorkspaceProcesses).not.toHaveBeenCalled();
    vi.mocked(killWorkspaceProcesses).mockRejectedValueOnce(
      new Error("runtime unavailable"),
    );
    await expect(
      deleteWorkspace(owner, workspace.slug, workspace.name),
    ).rejects.toThrow("deleteFailed");
    expect(
      await db.workspace.findUnique({ where: { id: workspace.id } }),
    ).toMatchObject({ status: "delete_failed" });
    expect(await getWorkspaceForUser(workspace.slug, owner)).toBeNull();
    await expect(renameWorkspace(owner, workspace.slug, "No")).rejects.toThrow(
      "unavailable",
    );
    const { token } = await createApiToken(owner, "owner");
    expect(
      (
        await manifest(
          new Request("http://localhost/api/manifest", {
            headers: { authorization: `Bearer ${token}` },
          }),
          { params: Promise.resolve({ slug: workspace.slug }) },
        )
      ).status,
    ).toBe(404);
    await deleteWorkspace(owner, workspace.slug, workspace.name);
    expect(
      await db.workspace.findUnique({ where: { id: workspace.id } }),
    ).toBeNull();
  });
});

describe("confirmed invitation notifications", () => {
  it("accepts historical token-only invitations without creating a notification", async () => {
    const token = randomBytes(32).toString("hex");
    await db.workspaceInvitation.create({
      data: {
        workspaceId: workspace.id,
        email: email("outsider"),
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await getWorkspaceInvitation(token))?.notification).toBeNull();
    expect(await acceptWorkspaceInvitation(outsider, token)).toBe(
      workspace.slug,
    );
    expect(
      await db.notification.count({ where: { workspaceId: workspace.id } }),
    ).toBe(0);
  });

  async function account(name: string) {
    const user = await db.user.create({
      data: { email: email(name), passwordHash: "test-only" },
    });
    userIds.push(user.id);
    return user;
  }

  async function invite() {
    const token = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: email("outsider"),
        recipientId: outsider,
      }),
    );
    const invitation = assertDefined(await getWorkspaceInvitation(token));
    const notification = await db.notification.findUniqueOrThrow({
      where: { invitationId: invitation.id },
    });
    return { token, invitation, notification };
  }

  it("previews only for the owner and rechecks confirmed identities without partial writes", async () => {
    expect(
      await previewWorkspaceInviteRecipient(
        owner,
        workspace.slug,
        ` ${email("outsider").toUpperCase()} `,
      ),
    ).toEqual({ id: outsider, name: null, email: email("outsider") });
    await expect(
      previewWorkspaceInviteRecipient(
        member,
        workspace.slug,
        email("outsider"),
      ),
    ).rejects.toThrow("forbidden");
    await expect(
      previewWorkspaceInviteRecipient(owner, workspace.slug, email("member")),
    ).rejects.toThrow("alreadyMember");
    expect(
      await previewWorkspaceInviteRecipient(
        owner,
        workspace.slug,
        email("new-after-preview"),
      ),
    ).toBeNull();
    await account("new-after-preview");
    for (const input of [
      { email: email("new-after-preview"), recipientId: null },
      { email: email("outsider"), recipientId: null },
      { email: email("outsider"), recipientId: member },
      { email: email("changed-address"), recipientId: outsider },
    ])
      await expect(
        inviteWorkspaceMember(owner, workspace.slug, input),
      ).rejects.toThrow("recipientChanged");
    await db.user.update({
      where: { id: outsider },
      data: { status: "suspended" },
    });
    try {
      await expect(
        previewWorkspaceInviteRecipient(
          owner,
          workspace.slug,
          email("outsider"),
        ),
      ).rejects.toThrow("recipientUnavailable");
      await expect(
        inviteWorkspaceMember(owner, workspace.slug, {
          email: email("outsider"),
          recipientId: outsider,
        }),
      ).rejects.toThrow("recipientUnavailable");
    } finally {
      await db.user.update({
        where: { id: outsider },
        data: { status: "active" },
      });
    }
    expect(
      await db.workspaceInvitation.count({
        where: { workspaceId: workspace.id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({ where: { workspaceId: workspace.id } }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { workspaceId: workspace.id, action: "workspace.invited" },
      }),
    ).toBe(0);
    const { invitation, notification } = await invite();
    expect(invitation.notification).toEqual({
      recipients: [{ userId: outsider }],
    });
    expect(
      await db.notificationRecipient.findMany({
        where: { notificationId: notification.id },
      }),
    ).toMatchObject([{ userId: outsider, readAt: null }]);
    expect(await getWorkspaceForUser(workspace.slug, outsider)).toBeNull();
  });

  it("accepts only a personal receipt once and preserves the historical read notification", async () => {
    const { notification } = await invite();
    await expect(
      acceptWorkspaceInvitationNotification(member, notification.id),
    ).rejects.toThrow("invalidInvitation");
    await expect(
      acceptWorkspaceInvitationNotification(outsider, "missing"),
    ).rejects.toThrow("invalidInvitation");
    expect(
      await acceptWorkspaceInvitationNotification(outsider, notification.id),
    ).toBe(workspace.slug);
    await expect(
      acceptWorkspaceInvitationNotification(outsider, notification.id),
    ).rejects.toThrow("invalidInvitation");
    expect(await getWorkspaceForUser(workspace.slug, outsider)).not.toBeNull();
    expect(
      await db.notification.findUnique({ where: { id: notification.id } }),
    ).toMatchObject({ invitationId: null, workspaceName: workspace.name });
    expect(
      await db.notificationRecipient.findUnique({
        where: {
          notificationId_userId: {
            notificationId: notification.id,
            userId: outsider,
          },
        },
      }),
    ).toMatchObject({ readAt: expect.any(Date) });
    expect(
      (await listNotifications(outsider, {})).items.find(
        (item) => item.id === notification.id,
      ),
    ).toMatchObject({ canAcceptInvitation: false });
    expect(
      await db.auditEvent.count({
        where: { workspaceId: workspace.id, action: "workspace.joined" },
      }),
    ).toBe(1);
  });

  it("serializes token and notification acceptance without downgrading an existing admin", async () => {
    const { token, notification } = await invite();
    await db.membership.create({
      data: { workspaceId: workspace.id, userId: outsider, role: "admin" },
    });
    const results = await Promise.allSettled([
      acceptWorkspaceInvitation(outsider, token),
      acceptWorkspaceInvitationNotification(outsider, notification.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await db.membership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: outsider },
        },
      }),
    ).toMatchObject({ role: "admin" });
    expect(
      await db.auditEvent.count({
        where: { workspaceId: workspace.id, action: "workspace.joined" },
      }),
    ).toBe(1);
  });

  it("refreshes one notification and receipt on reinvite and invalidates the old token", async () => {
    const first = await invite();
    await db.notificationRecipient.updateMany({
      where: { notificationId: first.notification.id },
      data: { readAt: new Date(0), createdAt: new Date(0) },
    });
    await renameWorkspace(
      owner,
      workspace.slug,
      "Renamed invitation workspace",
    );
    const second = await invite();
    expect(second.notification.id).toBe(first.notification.id);
    expect(second.notification.workspaceName).toBe(
      "Renamed invitation workspace",
    );
    expect(
      await db.notification.count({ where: { workspaceId: workspace.id } }),
    ).toBe(1);
    const receipts = await db.notificationRecipient.findMany({
      where: { notificationId: first.notification.id },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].readAt).toBeNull();
    expect(receipts[0].createdAt.getTime()).toBeGreaterThan(0);
    await expect(
      acceptWorkspaceInvitation(outsider, first.token),
    ).rejects.toThrow("invalidInvitation");
  });

  it.each(["revoked", "expired", "inactive", "deleted"] as const)(
    "keeps %s invitation history but disallows acceptance",
    async (state) => {
      const { token, invitation, notification } = await invite();
      if (state === "revoked")
        await revokeWorkspaceInvitation(owner, workspace.slug, invitation.id);
      if (state === "expired")
        await db.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { expiresAt: new Date(0) },
        });
      if (state === "inactive")
        await db.workspace.update({
          where: { id: workspace.id },
          data: { status: "delete_failed" },
        });
      if (state === "deleted")
        await deleteWorkspace(owner, workspace.slug, workspace.name);
      expect(
        (await listNotifications(outsider, {})).items.find(
          (item) => item.id === notification.id,
        ),
      ).toMatchObject({
        canAcceptInvitation: false,
        workspaceName: workspace.name,
      });
      await expect(
        acceptWorkspaceInvitationNotification(outsider, notification.id),
      ).rejects.toThrow("invalidInvitation");
      await expect(acceptWorkspaceInvitation(outsider, token)).rejects.toThrow(
        "invalidInvitation",
      );
      expect(
        await db.membership.count({
          where: { workspaceId: workspace.id, userId: outsider },
        }),
      ).toBe(0);
    },
  );

  it("does not let a replacement account claim a deleted account’s bound token", async () => {
    const original = await account("deleted-recipient");
    const token = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: original.email,
        recipientId: original.id,
      }),
    );
    const invitation = assertDefined(await getWorkspaceInvitation(token));
    const notification = await db.notification.findUniqueOrThrow({
      where: { invitationId: invitation.id },
    });
    await db.user.delete({ where: { id: original.id } });
    const replacement = await account("deleted-recipient");
    expect((await getWorkspaceInvitation(token))?.notification).toEqual({
      recipients: [],
    });
    await expect(
      acceptWorkspaceInvitation(replacement.id, token),
    ).rejects.toThrow("invalidInvitation");
    await expect(
      acceptWorkspaceInvitationNotification(replacement.id, notification.id),
    ).rejects.toThrow("invalidInvitation");
    expect(
      await db.membership.count({
        where: { workspaceId: workspace.id, userId: replacement.id },
      }),
    ).toBe(0);
  });

  it("rebinds an invitation only to the newly confirmed account and removes the old receipt", async () => {
    const original = await account("rebound-recipient");
    const token = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: original.email,
        recipientId: original.id,
      }),
    );
    const invitation = assertDefined(await getWorkspaceInvitation(token));
    const notification = await db.notification.findUniqueOrThrow({
      where: { invitationId: invitation.id },
    });
    await db.user.update({
      where: { id: original.id },
      data: { email: email("rebound-moved") },
    });
    const replacement = await account("rebound-recipient");
    await expect(
      inviteWorkspaceMember(owner, workspace.slug, {
        email: replacement.email,
        recipientId: original.id,
      }),
    ).rejects.toThrow("recipientChanged");
    await inviteWorkspaceMember(owner, workspace.slug, {
      email: replacement.email,
      recipientId: replacement.id,
    });
    expect(
      await db.notificationRecipient.findMany({
        where: { notificationId: notification.id },
      }),
    ).toMatchObject([{ userId: replacement.id }]);
    expect(
      await db.notificationRecipient.count({
        where: { notificationId: notification.id },
      }),
    ).toBe(1);
    await expect(
      acceptWorkspaceInvitationNotification(original.id, notification.id),
    ).rejects.toThrow("invalidInvitation");
    expect(
      await acceptWorkspaceInvitationNotification(
        replacement.id,
        notification.id,
      ),
    ).toBe(workspace.slug);
  });

  it("detaches historical notifications when reinviting an address without an account", async () => {
    const original = await account("detached-recipient");
    const first = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: original.email,
        recipientId: original.id,
      }),
    );
    const invitation = assertDefined(await getWorkspaceInvitation(first));
    const notification = await db.notification.findUniqueOrThrow({
      where: { invitationId: invitation.id },
    });
    await db.user.update({
      where: { id: original.id },
      data: { email: email("detached-moved") },
    });
    await expect(
      inviteWorkspaceMember(owner, workspace.slug, {
        email: original.email,
        recipientId: original.id,
      }),
    ).rejects.toThrow("recipientChanged");
    const link = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: original.email,
        recipientId: null,
      }),
    );
    expect((await getWorkspaceInvitation(link))?.notification).toBeNull();
    expect(
      await db.notification.findUnique({ where: { id: notification.id } }),
    ).toMatchObject({ invitationId: null });
    expect(
      await db.notificationRecipient.count({
        where: { notificationId: notification.id, userId: original.id },
      }),
    ).toBe(1);
    await expect(
      acceptWorkspaceInvitationNotification(original.id, notification.id),
    ).rejects.toThrow("invalidInvitation");
    const replacement = await account("detached-recipient");
    expect(await acceptWorkspaceInvitation(replacement.id, link)).toBe(
      workspace.slug,
    );
  });

  it("keeps unregistered links unbound after signup and allows explicit later notification delivery", async () => {
    const address = email("link-signup");
    const token = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: address,
        recipientId: null,
      }),
    );
    expect((await getWorkspaceInvitation(token))?.notification).toBeNull();
    expect(
      await db.notification.count({ where: { workspaceId: workspace.id } }),
    ).toBe(0);
    const recipient = await account("link-signup");
    expect((await listNotifications(recipient.id, {})).items).toEqual([]);
    await expect(acceptWorkspaceInvitation(member, token)).rejects.toThrow(
      "wrongEmail",
    );
    expect(await acceptWorkspaceInvitation(recipient.id, token)).toBe(
      workspace.slug,
    );
    await removeWorkspaceMember(owner, workspace.slug, recipient.id);
    expect(
      await previewWorkspaceInviteRecipient(owner, workspace.slug, address),
    ).toMatchObject({ id: recipient.id });
    const renewed = tokenFrom(
      await inviteWorkspaceMember(owner, workspace.slug, {
        email: address,
        recipientId: recipient.id,
      }),
    );
    expect((await getWorkspaceInvitation(renewed))?.notification).toEqual({
      recipients: [{ userId: recipient.id }],
    });
    expect((await listNotifications(recipient.id, {})).items).toMatchObject([
      { canAcceptInvitation: true },
    ]);
  });

  it("rechecks active actors when previewing, inviting and accepting", async () => {
    const { token, notification } = await invite();
    await db.user.update({
      where: { id: outsider },
      data: { status: "suspended" },
    });
    await db.user.update({
      where: { id: owner },
      data: { status: "suspended" },
    });
    try {
      await expect(
        previewWorkspaceInviteRecipient(owner, workspace.slug, email("unused")),
      ).rejects.toThrow("forbidden");
      await expect(
        inviteWorkspaceMember(owner, workspace.slug, {
          email: email("unused"),
          recipientId: null,
        }),
      ).rejects.toThrow("forbidden");
      await expect(acceptWorkspaceInvitation(outsider, token)).rejects.toThrow(
        "forbidden",
      );
      await expect(
        acceptWorkspaceInvitationNotification(outsider, notification.id),
      ).rejects.toThrow("forbidden");
      expect(
        await db.membership.count({
          where: { workspaceId: workspace.id, userId: outsider },
        }),
      ).toBe(0);
    } finally {
      await db.user.updateMany({
        where: { id: { in: [owner, outsider] } },
        data: { status: "active" },
      });
    }
  });

  it("rolls back invitation and receipt creation when the audit write fails", async () => {
    const spy = vi
      .spyOn(audit, "writeAudit")
      .mockRejectedValueOnce(new Error("audit failure"));
    try {
      await expect(
        inviteWorkspaceMember(owner, workspace.slug, {
          email: email("outsider"),
          recipientId: outsider,
        }),
      ).rejects.toThrow("audit failure");
    } finally {
      spy.mockRestore();
    }
    expect(
      await db.workspaceInvitation.count({
        where: { workspaceId: workspace.id },
      }),
    ).toBe(0);
    expect(
      await db.notification.count({ where: { workspaceId: workspace.id } }),
    ).toBe(0);
    expect(
      await db.notificationRecipient.count({
        where: { notification: { workspaceId: workspace.id } },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { workspaceId: workspace.id, action: "workspace.invited" },
      }),
    ).toBe(0);
  });

  it.each(["token", "notification"] as const)(
    "rolls back %s consumption, membership and read state when audit fails",
    async (kind) => {
      const { token, invitation, notification } = await invite();
      const spy = vi
        .spyOn(audit, "writeAudit")
        .mockRejectedValueOnce(new Error("audit failure"));
      try {
        await expect(
          kind === "token"
            ? acceptWorkspaceInvitation(outsider, token)
            : acceptWorkspaceInvitationNotification(outsider, notification.id),
        ).rejects.toThrow("audit failure");
      } finally {
        spy.mockRestore();
      }
      expect(
        await db.workspaceInvitation.findUnique({
          where: { id: invitation.id },
        }),
      ).not.toBeNull();
      expect(
        await db.notification.findUnique({ where: { id: notification.id } }),
      ).toMatchObject({ invitationId: invitation.id });
      expect(
        await db.notificationRecipient.findUnique({
          where: {
            notificationId_userId: {
              notificationId: notification.id,
              userId: outsider,
            },
          },
        }),
      ).toMatchObject({ readAt: null });
      expect(
        await db.membership.count({
          where: { workspaceId: workspace.id, userId: outsider },
        }),
      ).toBe(0);
      expect(
        await db.auditEvent.count({
          where: { workspaceId: workspace.id, action: "workspace.joined" },
        }),
      ).toBe(0);
    },
  );
});
