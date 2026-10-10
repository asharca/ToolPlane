// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";
import { db } from "@/lib/db";
import * as audit from "@/lib/observability/audit";
import {
  NotificationError,
  publishNotification,
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  type PublishNotificationInput,
} from "@/lib/notifications/service";
import {
  removeWorkspaceMember,
  setWorkspaceMemberRole,
} from "@/lib/workspace/management";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getUnreadNotificationCountAction,
  markNotificationReadAction,
  markAllNotificationsReadAction,
  publishSiteNotificationAction,
  publishWorkspaceNotificationAction,
} from "@/lib/notifications/actions";
import {
  inviteWorkspaceMemberAction,
  previewWorkspaceInviteRecipientAction,
  previewWorkspaceInvitationAction,
} from "@/lib/workspace/management-actions";

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const userIds: string[] = [];
const workspaceIds: string[] = [];
let serial = 0;
let site: User;
let owner: User;
let admin: User;
let member: User;
let outsider: User;
let suspended: User;
let workspace: { id: string; slug: string; name: string };

async function user(
  name: string,
  extra: { role?: "admin" | "user"; status?: "active" | "suspended" } = {},
) {
  const result = await db.user.create({
    data: {
      email: `notifications-${stamp}-${++serial}-${name}@example.test`,
      passwordHash: "test-only",
      ...extra,
    },
  });
  userIds.push(result.id);
  return result;
}

function input(
  overrides: Partial<PublishNotificationInput> = {},
): PublishNotificationInput {
  return {
    scope: { kind: "site" },
    audience: "selected",
    emails: [member.email],
    title: " Notice ",
    body: " First line\nSecond line ",
    ...overrides,
  };
}

async function counts() {
  const where = { senderId: { in: userIds } };
  return {
    notifications: await db.notification.count({ where }),
    receipts: await db.notificationRecipient.count({
      where: { notification: where },
    }),
    audits: await db.auditEvent.count({
      where: { actorId: { in: userIds }, action: "notification.published" },
    }),
  };
}

async function rejectedWithoutWrites(
  actorId: string,
  payload: PublishNotificationInput,
  code: string,
) {
  const before = await counts();
  await expect(publishNotification(actorId, payload)).rejects.toMatchObject({
    code,
  });
  expect(await counts()).toEqual(before);
}

beforeEach(async () => {
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(null);
  site = await user("site", { role: "admin" });
  owner = await user("owner");
  admin = await user("admin");
  member = await user("member");
  outsider = await user("outsider");
  suspended = await user("suspended", { status: "suspended" });
  workspace = await db.workspace.create({
    data: {
      slug: `notifications-${stamp}-${++serial}`,
      name: "Notification workspace",
      ownerId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: member.id },
          { userId: suspended.id },
        ],
      },
    },
  });
  workspaceIds.push(workspace.id);
});

afterAll(async () => {
  // Only remove rows owned by this file, including all-broadcast receipts on other accounts.
  await db.notification.deleteMany({ where: { senderId: { in: userIds } } });
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("notification publication and audience snapshots", () => {
  it("broadcasts to exactly the active regular-account snapshot and writes one minimal audit", async () => {
    const expected = await db.user.findMany({
      where: { status: "active", role: "user" },
      select: { id: true },
    });
    const before = await counts();
    const result = await publishNotification(
      site.id,
      input({ audience: "all", emails: [] }),
    );
    expect(result.recipientCount).toBe(expected.length);
    const receipts = await db.notificationRecipient.findMany({
      where: { notificationId: result.notificationId },
    });
    expect(receipts.map((row) => row.userId).sort()).toEqual(
      expected.map((row) => row.id).sort(),
    );
    expect(receipts.every((row) => row.readAt === null)).toBe(true);
    expect(
      receipts.some(
        (row) => row.userId === site.id || row.userId === suspended.id,
      ),
    ).toBe(false);
    expect(
      await db.notification.findUnique({
        where: { id: result.notificationId },
      }),
    ).toMatchObject({
      kind: "site_announcement",
      title: "Notice",
      body: "First line\nSecond line",
      senderId: site.id,
      workspaceId: null,
      invitationId: null,
    });
    const events = await db.auditEvent.findMany({
      where: { actorId: site.id, action: "notification.published" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: result.notificationId,
      changes: {
        kind: "site_announcement",
        audience: "all",
        recipientCount: expected.length,
      },
    });
    expect(await counts()).toEqual({
      notifications: before.notifications + 1,
      receipts: before.receipts + expected.length,
      audits: before.audits + 1,
    });
    const newcomer = await user("later");
    expect(
      await db.notificationRecipient.count({
        where: { userId: newcomer.id, notificationId: result.notificationId },
      }),
    ).toBe(0);
  });

  it("normalizes and deduplicates selected emails, rejecting every mixed invalid audience atomically", async () => {
    const result = await publishNotification(
      site.id,
      input({
        emails: [
          member.email,
          ` ${member.email.toUpperCase()} `,
          outsider.email,
        ],
      }),
    );
    expect(result.recipientCount).toBe(2);
    expect(
      await db.notificationRecipient.count({
        where: { notificationId: result.notificationId },
      }),
    ).toBe(2);
    expect(
      await db.auditEvent.findFirst({
        where: { actorId: site.id, targetId: result.notificationId },
      }),
    ).toMatchObject({
      changes: {
        kind: "site_announcement",
        audience: "selected",
        recipientCount: 2,
      },
    });
    for (const email of [
      `missing-${stamp}@example.test`,
      suspended.email,
      site.email,
    ]) {
      await rejectedWithoutWrites(
        site.id,
        input({ emails: [member.email, email] }),
        "invalidRecipients",
      );
    }
  });

  it("accepts 5000 visible textarea characters after CRLF form serialization without relaxing the limit", async () => {
    const body = `a\n${"b".repeat(4998)}`;
    vi.mocked(getCurrentUser).mockResolvedValue(site);
    const data = form({
      title: ` ${"t".repeat(120)} `,
      body: body.replace(/\n/g, "\r\n"),
      audience: "selected",
      emails: member.email,
    });
    expect(await publishSiteNotificationAction({}, data)).toEqual({
      ok: true,
      recipientCount: 1,
    });
    expect((await listNotifications(member.id, {})).items[0]).toMatchObject({
      title: "t".repeat(120),
      body,
    });
    await rejectedWithoutWrites(
      site.id,
      input({ body: `${body}\r\nc` }),
      "invalidContent",
    );
  });

  it("validates content and recipient boundaries without writing partial deliveries", async () => {
    for (const patch of [
      { title: " " },
      { title: "a".repeat(121) },
      { body: "\n " },
      { body: "b".repeat(5001) },
    ]) {
      await rejectedWithoutWrites(site.id, input(patch), "invalidContent");
    }
    for (const patch of [
      { emails: [] },
      { emails: ["not-an-email"] },
      { emails: [`${"a".repeat(310)}@example.test`] },
      {
        emails: Array.from(
          { length: 101 },
          (_, i) => `target-${i}@example.test`,
        ),
      },
      { audience: "all" as const, emails: [member.email] },
    ]) {
      await rejectedWithoutWrites(site.id, input(patch), "invalidRecipients");
    }
    await rejectedWithoutWrites(owner.id, input(), "forbidden");
    await rejectedWithoutWrites(suspended.id, input(), "forbidden");
    await rejectedWithoutWrites(`missing-${stamp}`, input(), "forbidden");
    await db.user.update({
      where: { id: site.id },
      data: { status: "suspended" },
    });
    await rejectedWithoutWrites(site.id, input(), "forbidden");
  });

  it("allows only current workspace owner/admin and snapshots active members regardless of site role", async () => {
    const scope = { kind: "workspace" as const, slug: workspace.slug };
    await db.membership.create({
      data: { workspaceId: workspace.id, userId: site.id },
    });
    for (const actor of [owner, admin]) {
      const result = await publishNotification(
        actor.id,
        input({ scope, audience: "all", emails: [] }),
      );
      expect(result.recipientCount).toBe(4);
      expect(
        (
          await db.notificationRecipient.findMany({
            where: { notificationId: result.notificationId },
          })
        )
          .map((row) => row.userId)
          .sort(),
      ).toEqual([owner.id, admin.id, member.id, site.id].sort());
      expect(
        await db.notification.findUnique({
          where: { id: result.notificationId },
        }),
      ).toMatchObject({
        kind: "workspace_announcement",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        senderId: actor.id,
      });
      expect(
        await db.auditEvent.findFirst({
          where: { actorId: actor.id, targetId: result.notificationId },
        }),
      ).toMatchObject({
        workspaceId: workspace.id,
        changes: {
          kind: "workspace_announcement",
          audience: "all",
          recipientCount: 4,
        },
      });
    }
    const other = await db.workspace.create({
      data: {
        ownerId: outsider.id,
        name: "Other workspace",
        slug: `notifications-other-${stamp}-${++serial}`,
      },
    });
    workspaceIds.push(other.id);
    await rejectedWithoutWrites(
      owner.id,
      input({ scope, emails: [member.email, outsider.email] }),
      "invalidRecipients",
    );
    await rejectedWithoutWrites(
      owner.id,
      input({ scope, emails: [member.email, suspended.email] }),
      "invalidRecipients",
    );
    for (const actor of [member, outsider, site]) {
      await rejectedWithoutWrites(actor.id, input({ scope }), "forbidden");
    }
    await db.membership.delete({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: site.id },
      },
    });
    await rejectedWithoutWrites(site.id, input({ scope }), "forbidden");
    await setWorkspaceMemberRole(owner.id, workspace.slug, admin.id, "member");
    await rejectedWithoutWrites(admin.id, input({ scope }), "forbidden");
    await setWorkspaceMemberRole(owner.id, workspace.slug, admin.id, "admin");
    expect(
      (await publishNotification(admin.id, input({ scope }))).recipientCount,
    ).toBe(1);
    expect(await db.user.findUnique({ where: { id: admin.id } })).toMatchObject(
      { role: "user" },
    );
    await removeWorkspaceMember(owner.id, workspace.slug, admin.id);
    await rejectedWithoutWrites(admin.id, input({ scope }), "forbidden");
    await db.workspace.update({
      where: { id: workspace.id },
      data: { status: "delete_failed" },
    });
    await rejectedWithoutWrites(owner.id, input({ scope }), "unavailable");
  });

  it("rolls back notification, receipts and audit when the transaction audit write fails", async () => {
    const before = await counts();
    const failure = new Error("injected audit failure");
    const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(failure);
    try {
      await expect(
        publishNotification(
          site.id,
          input({ emails: [member.email, outsider.email] }),
        ),
      ).rejects.toBe(failure);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    expect((await publishNotification(site.id, input())).recipientCount).toBe(
      1,
    );
  });
});

describe("private inbox and read state", () => {
  it("isolates list/count/single/all reads and preserves the original read timestamp", async () => {
    const common = await publishNotification(
      site.id,
      input({ emails: [member.email, outsider.email] }),
    );
    const second = await publishNotification(
      site.id,
      input({ emails: [member.email, outsider.email] }),
    );
    const privateNotice = await publishNotification(
      site.id,
      input({ emails: [outsider.email] }),
    );
    expect(
      (await listNotifications(member.id, {})).items
        .map((row) => row.id)
        .sort(),
    ).toEqual([common.notificationId, second.notificationId].sort());
    expect(await getUnreadNotificationCount(member.id)).toBe(2);
    expect(await getUnreadNotificationCount(outsider.id)).toBe(3);
    expect((await listNotifications(site.id, {})).items).toEqual([]);
    for (const id of [privateNotice.notificationId, `missing-${stamp}`]) {
      await expect(markNotificationRead(member.id, id)).rejects.toMatchObject({
        code: "notFound",
      });
    }
    await expect(
      markNotificationRead(site.id, privateNotice.notificationId),
    ).rejects.toMatchObject({ code: "notFound" });
    const where = {
      notificationId_userId: {
        notificationId: common.notificationId,
        userId: member.id,
      },
    };
    await markNotificationRead(member.id, common.notificationId);
    const firstRead = (
      await db.notificationRecipient.findUniqueOrThrow({ where })
    ).readAt;
    expect(firstRead).toBeInstanceOf(Date);
    await markNotificationRead(member.id, common.notificationId);
    expect(
      (await db.notificationRecipient.findUniqueOrThrow({ where })).readAt,
    ).toEqual(firstRead);
    expect(await getUnreadNotificationCount(member.id)).toBe(1);
    await markAllNotificationsRead(member.id);
    await markAllNotificationsRead(member.id);
    expect(
      (await db.notificationRecipient.findUniqueOrThrow({ where })).readAt,
    ).toEqual(firstRead);
    expect(await getUnreadNotificationCount(member.id)).toBe(0);
    expect(await getUnreadNotificationCount(outsider.id)).toBe(3);
    expect(
      await db.notificationRecipient.count({
        where: { userId: outsider.id, readAt: { not: null } },
      }),
    ).toBe(0);
    expect(
      await listNotifications(member.id, { unreadOnly: true, page: 999 }),
    ).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      unreadCount: 0,
    });
  });

  it("requires an existing active user for every inbox entry point", async () => {
    const notice = await publishNotification(site.id, input());
    await db.user.update({
      where: { id: member.id },
      data: { status: "suspended" },
    });
    for (const id of [member.id, `missing-${stamp}`]) {
      for (const call of [
        () => listNotifications(id, {}),
        () => getUnreadNotificationCount(id),
        () => markNotificationRead(id, notice.notificationId),
        () => markAllNotificationsRead(id),
      ]) {
        const result = call();
        await expect(result).rejects.toBeInstanceOf(NotificationError);
        await expect(result).rejects.toMatchObject({ code: "forbidden" });
      }
    }
    expect(
      await db.notificationRecipient.findUnique({
        where: {
          notificationId_userId: {
            notificationId: notice.notificationId,
            userId: member.id,
          },
        },
      }),
    ).toMatchObject({ readAt: null });
  });

  it("paginates 21 tied receipts stably, clamps pages and keeps unread count independent of filters", async () => {
    const tiedAt = new Date("2026-01-01T00:00:00Z");
    const ids = Array.from(
      { length: 21 },
      (_, index) =>
        `notifications-${stamp}-${++serial}-${String(index).padStart(2, "0")}`,
    );
    await db.notification.createMany({
      data: ids.map((id) => ({
        id,
        kind: "site_announcement" as const,
        title: "Title",
        body: "<img src=x onerror=alert(1)>",
        senderId: site.id,
      })),
    });
    await db.notificationRecipient.createMany({
      data: ids.map((notificationId, index) => ({
        notificationId,
        userId: member.id,
        createdAt: tiedAt,
        readAt: index % 2 === 0 ? null : tiedAt,
      })),
    });
    const expected = [...ids].sort().reverse();
    const first = await listNotifications(member.id, { page: 1 });
    const last = await listNotifications(member.id, { page: 2 });
    expect(first).toMatchObject({
      total: 21,
      page: 1,
      pageSize: 20,
      unreadCount: 11,
    });
    expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 20));
    expect(last).toMatchObject({
      total: 21,
      page: 2,
      pageSize: 20,
      unreadCount: 11,
    });
    expect(last.items.map((row) => row.id)).toEqual(expected.slice(20));
    expect(
      new Set([...first.items, ...last.items].map((row) => row.id)).size,
    ).toBe(21);
    expect(await listNotifications(member.id, { page: 999 })).toEqual(last);
    for (const page of [0, -1, NaN, Infinity]) {
      expect(await listNotifications(member.id, { page })).toEqual(first);
    }
    const unread = await listNotifications(member.id, {
      unreadOnly: true,
      page: 999,
    });
    expect(unread).toMatchObject({
      total: 11,
      page: 1,
      pageSize: 20,
      unreadCount: 11,
    });
    expect(unread.items.map((row) => row.id)).toEqual(
      ids
        .filter((_, index) => index % 2 === 0)
        .sort()
        .reverse(),
    );
    for (const item of first.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "id",
          "kind",
          "title",
          "body",
          "workspaceName",
          "createdAt",
          "readAt",
          "canAcceptInvitation",
        ].sort(),
      );
      expect(item).toMatchObject({
        kind: "site_announcement",
        body: "<img src=x onerror=alert(1)>",
        workspaceName: null,
        canAcceptInvitation: false,
      });
      expect(item.createdAt).toBeInstanceOf(Date);
    }
    // Listing and opening content never mark anything read.
    expect(await getUnreadNotificationCount(member.id)).toBe(11);
    expect(await listNotifications(outsider.id, { page: 99 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      unreadCount: 0,
    });
    expect(await getUnreadNotificationCount(outsider.id)).toBe(0);
    expect(await db.workspace.count({ where: { ownerId: outsider.id } })).toBe(
      0,
    );
    expect(await db.membership.count({ where: { userId: outsider.id } })).toBe(
      0,
    );
  });
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("session-bound notification actions", () => {
  it("rejects missing sessions and suspended database users without faking zero or changing reads", async () => {
    const notice = await publishNotification(site.id, input());
    const data = form({
      notificationId: notice.notificationId,
      actorId: member.id,
      userId: member.id,
    });
    for (const session of [null, member]) {
      vi.mocked(getCurrentUser).mockResolvedValue(session);
      if (session)
        await db.user.update({
          where: { id: member.id },
          data: { status: "suspended" },
        });
      expect(await getUnreadNotificationCountAction()).toEqual({
        error: "errors.forbidden",
      });
      expect(await markNotificationReadAction({}, data)).toEqual({
        error: "errors.forbidden",
      });
      expect(await markAllNotificationsReadAction({}, data)).toEqual({
        error: "errors.forbidden",
      });
      expect(
        await db.notificationRecipient.findUnique({
          where: {
            notificationId_userId: {
              notificationId: notice.notificationId,
              userId: member.id,
            },
          },
        }),
      ).toMatchObject({ readAt: null });
    }
  });

  it("uses the session identity rather than forged actor/user IDs for count and read actions", async () => {
    const shared = await publishNotification(
      site.id,
      input({ emails: [member.email, outsider.email] }),
    );
    const privateNotice = await publishNotification(
      site.id,
      input({ emails: [outsider.email] }),
    );
    vi.mocked(getCurrentUser).mockResolvedValue(member);
    expect(await getUnreadNotificationCountAction()).toEqual({ count: 1 });
    const data = form({
      notificationId: privateNotice.notificationId,
      actorId: outsider.id,
      userId: outsider.id,
    });
    expect(await markNotificationReadAction({}, data)).toEqual({
      error: "errors.notFound",
    });
    data.set("notificationId", shared.notificationId);
    expect(await markNotificationReadAction({}, data)).toEqual({ ok: true });
    expect(await markAllNotificationsReadAction({}, data)).toEqual({
      ok: true,
    });
    expect(await getUnreadNotificationCountAction()).toEqual({ count: 0 });
    expect(await getUnreadNotificationCount(outsider.id)).toBe(2);
    expect(
      await db.notificationRecipient.count({
        where: { userId: outsider.id, readAt: { not: null } },
      }),
    ).toBe(0);
  });

  it("hardcodes each publication scope and ignores forged actor IDs", async () => {
    const fields = {
      title: "Action notice",
      body: "Plain text",
      audience: "selected",
      emails: `${member.email},\n${member.email.toUpperCase()}`,
      workspace: workspace.slug,
      actorId: site.id,
      scope: "site",
      kind: "site_announcement",
    };
    vi.mocked(getCurrentUser).mockResolvedValue(member);
    const before = await counts();
    expect(await publishWorkspaceNotificationAction({}, form(fields))).toEqual({
      error: "errors.forbidden",
    });
    expect(await counts()).toEqual(before);
    vi.mocked(getCurrentUser).mockResolvedValue(owner);
    expect(await publishWorkspaceNotificationAction({}, form(fields))).toEqual({
      ok: true,
      recipientCount: 1,
    });
    expect(
      await db.notification.findFirst({ where: { senderId: owner.id } }),
    ).toMatchObject({
      kind: "workspace_announcement",
      workspaceId: workspace.id,
    });
    // Site privilege cannot turn the workspace action into site publication.
    vi.mocked(getCurrentUser).mockResolvedValue(site);
    const afterWorkspace = await counts();
    expect(await publishWorkspaceNotificationAction({}, form(fields))).toEqual({
      error: "errors.forbidden",
    });
    expect(await counts()).toEqual(afterWorkspace);
    expect(
      await publishSiteNotificationAction(
        {},
        form({
          ...fields,
          actorId: owner.id,
          scope: "workspace",
          kind: "workspace_announcement",
        }),
      ),
    ).toEqual({ ok: true, recipientCount: 1 });
    const siteNotice = await db.notification.findFirstOrThrow({
      where: { senderId: site.id },
    });
    expect(siteNotice).toMatchObject({
      kind: "site_announcement",
      workspaceId: null,
    });
    expect(
      await db.notificationRecipient.findMany({
        where: { notificationId: siteNotice.id },
        select: { userId: true },
      }),
    ).toEqual([{ userId: member.id }]);
  });

  it("rejects oversized email text before publishing and localizes technical failures", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(site);
    const data = form({
      title: "Notice",
      body: "Text",
      audience: "selected",
      emails: "a".repeat(32101),
    });
    const before = await counts();
    expect(await publishSiteNotificationAction({}, data)).toEqual({
      error: "errors.invalidRecipients",
    });
    expect(await counts()).toEqual(before);
    data.set("emails", member.email);
    const spy = vi
      .spyOn(audit, "writeAudit")
      .mockRejectedValueOnce(new Error("private database details"));
    try {
      expect(await publishSiteNotificationAction({}, data)).toEqual({
        error: "errors.failed",
      });
      expect(await counts()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("confirmed invitation actions", () => {
  it("requires owner previews and an explicit bounded recipient confirmation", async () => {
    const data = form({
      workspace: workspace.slug,
      email: outsider.email,
      actorId: owner.id,
    });
    vi.mocked(getCurrentUser).mockResolvedValue(member);
    expect(await previewWorkspaceInviteRecipientAction({}, data)).toEqual({
      error: "errors.forbidden",
    });
    vi.mocked(getCurrentUser).mockResolvedValue(owner);
    expect(await previewWorkspaceInviteRecipientAction({}, data)).toEqual({
      email: outsider.email,
      recipient: {
        id: outsider.id,
        name: outsider.name,
        email: outsider.email,
      },
    });
    expect(await inviteWorkspaceMemberAction({}, data)).toEqual({
      error: "errors.recipientChanged",
    });
    data.set("recipientId", "x".repeat(201));
    expect(await inviteWorkspaceMemberAction({}, data)).toEqual({
      error: "errors.recipientChanged",
    });
    expect(
      await db.workspaceInvitation.count({
        where: { workspaceId: workspace.id },
      }),
    ).toBe(0);
    data.set("recipientId", outsider.id);
    const created = await inviteWorkspaceMemberAction({}, data);
    expect(created.error).toBeUndefined();
    const token = assertDefined(
      new URLSearchParams(
        new URL(
          assertDefined(created.invitePath),
          "http://localhost",
        ).hash.slice(1),
      ).get("invite"),
    );
    vi.mocked(getCurrentUser).mockResolvedValue(outsider);
    expect(await previewWorkspaceInvitationAction(token)).toEqual({
      name: workspace.name,
      email: outsider.email,
      canJoin: true,
    });
    await db.user.delete({ where: { id: outsider.id } });
    const replacement = await db.user.create({
      data: { email: outsider.email, passwordHash: "test-only" },
    });
    userIds.push(replacement.id);
    vi.mocked(getCurrentUser).mockResolvedValue(replacement);
    expect(await previewWorkspaceInvitationAction(token)).toEqual({
      name: workspace.name,
      email: outsider.email,
      canJoin: false,
    });
    expect(await listNotifications(replacement.id, {})).toMatchObject({
      total: 0,
      unreadCount: 0,
    });
  });
});
