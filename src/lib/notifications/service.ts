import "server-only";
import type { NotificationKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";

export type NotificationErrorCode =
  | "forbidden"
  | "unavailable"
  | "invalidContent"
  | "invalidRecipients"
  | "notFound";

export class NotificationError extends Error {
  constructor(public readonly code: NotificationErrorCode) {
    super(code);
    this.name = "NotificationError";
  }
}

export type PublishNotificationInput = {
  scope: { kind: "site" } | { kind: "workspace"; slug: string };
  audience: "all" | "selected";
  emails: string[];
  title: string;
  body: string;
};

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  title: string | null;
  body: string | null;
  workspaceName: string | null;
  createdAt: Date;
  readAt: Date | null;
  canAcceptInvitation: boolean;
};

export type NotificationPage = {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
};

const publishSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("site") }),
    z.object({ kind: z.literal("workspace"), slug: z.string().min(1) }),
  ]),
  audience: z.enum(["all", "selected"]),
  emails: z
    .array(z.string().trim().toLowerCase().max(320).email())
    .transform((emails) => [...new Set(emails)]),
  title: z.string().trim().min(1).max(120),
  body: z
    .string()
    .transform((body) => body.replace(/\r\n?/g, "\n"))
    .pipe(z.string().trim().min(1).max(5000)),
});

async function activeUser(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, status: true },
  });
  if (user?.status !== "active") throw new NotificationError("forbidden");
  return user;
}

export async function publishNotification(
  actorId: string,
  input: PublishNotificationInput,
): Promise<{ notificationId: string; recipientCount: number }> {
  return db.$transaction(async (tx) => {
    await activeUser(tx, actorId);
    const parsed = publishSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new NotificationError(
        field === "scope"
          ? "forbidden"
          : field === "emails" || field === "audience"
            ? "invalidRecipients"
            : "invalidContent",
      );
    }
    const { scope, audience, emails, title, body } = parsed.data;
    if (
      audience === "all"
        ? emails.length !== 0
        : emails.length < 1 || emails.length > 100
    ) {
      throw new NotificationError("invalidRecipients");
    }

    let workspace: { id: string; name: string } | undefined;
    if (scope.kind === "workspace") {
      // Share the membership/ownership mutation lock before checking permission or audience.
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "slug" = ${scope.slug} FOR UPDATE`;
      const candidate = await tx.workspace.findFirst({
        where: {
          slug: scope.slug,
          OR: [
            { ownerId: actorId },
            { members: { some: { userId: actorId, role: "admin" } } },
          ],
        },
        select: { id: true, name: true, status: true },
      });
      if (!candidate) throw new NotificationError("forbidden");
      if (candidate.status !== "active")
        throw new NotificationError("unavailable");
      workspace = candidate;
    }
    // Re-read after waiting on the workspace lock, including current account status.
    const actor = await activeUser(tx, actorId);
    if (scope.kind === "site" && actor.role !== "admin")
      throw new NotificationError("forbidden");

    const recipients = await tx.user.findMany({
      where: {
        status: "active",
        ...(workspace
          ? {
              OR: [
                { ownedWorkspaces: { some: { id: workspace.id } } },
                { memberships: { some: { workspaceId: workspace.id } } },
              ],
            }
          : { role: "user" }),
        ...(audience === "selected" ? { email: { in: emails } } : {}),
      },
      select: { id: true },
    });
    if (
      recipients.length === 0 ||
      (audience === "selected" && recipients.length !== emails.length)
    ) {
      throw new NotificationError("invalidRecipients");
    }
    const kind = workspace ? "workspace_announcement" : "site_announcement";
    const notification = await tx.notification.create({
      data: {
        kind,
        title,
        body,
        senderId: actorId,
        workspaceId: workspace?.id,
        workspaceName: workspace?.name,
      },
      select: { id: true },
    });
    // ponytail: synchronous broadcasts are bounded by transaction timeout; move distribution
    // to background work only after measured timeouts, not speculative audience limits.
    for (let offset = 0; offset < recipients.length; offset += 500) {
      await tx.notificationRecipient.createMany({
        data: recipients.slice(offset, offset + 500).map(({ id }) => ({
          notificationId: notification.id,
          userId: id,
        })),
      });
    }
    await writeAudit(tx, {
      actorId,
      workspaceId: workspace?.id,
      action: "notification.published",
      targetType: "notification",
      targetId: notification.id,
      changes: { kind, audience, recipientCount: recipients.length },
    });
    return {
      notificationId: notification.id,
      recipientCount: recipients.length,
    };
  });
}

export async function listNotifications(
  userId: string,
  options: { page?: number; unreadOnly?: boolean },
): Promise<NotificationPage> {
  return db.$transaction(
    async (tx) => {
      const user = await activeUser(tx, userId);
      const where: Prisma.NotificationRecipientWhereInput = {
        userId,
        ...(options.unreadOnly ? { readAt: null } : {}),
      };
      const total = await tx.notificationRecipient.count({ where });
      const unreadCount = await tx.notificationRecipient.count({
        where: { userId, readAt: null },
      });
      const pageSize = 20;
      const page = Math.min(
        normalizeAdminPage(options.page ?? 1),
        Math.max(1, Math.ceil(total / pageSize)),
      );
      const receipts = await tx.notificationRecipient.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { notificationId: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          createdAt: true,
          readAt: true,
          notification: {
            select: {
              id: true,
              kind: true,
              title: true,
              body: true,
              workspaceName: true,
              invitation: {
                select: {
                  email: true,
                  expiresAt: true,
                  workspace: { select: { status: true } },
                },
              },
            },
          },
        },
      });
      const now = new Date();
      const items = receipts.map(
        ({ notification, createdAt, readAt }): NotificationItem => ({
          id: notification.id,
          kind: notification.kind,
          title: notification.title,
          body: notification.body,
          workspaceName: notification.workspaceName,
          createdAt,
          readAt,
          canAcceptInvitation:
            notification.kind === "workspace_invitation" &&
            notification.invitation !== null &&
            notification.invitation.expiresAt > now &&
            notification.invitation.workspace.status === "active" &&
            notification.invitation.email.toLowerCase() ===
              user.email.toLowerCase(),
        }),
      );
      return { items, total, page, pageSize, unreadCount };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function getUnreadNotificationCount(
  userId: string,
): Promise<number> {
  return db.$transaction(async (tx) => {
    await activeUser(tx, userId);
    return tx.notificationRecipient.count({ where: { userId, readAt: null } });
  });
}

export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await activeUser(tx, userId);
    const receipt = await tx.notificationRecipient.findUnique({
      where: { notificationId_userId: { notificationId, userId } },
      select: { notificationId: true },
    });
    if (!receipt) throw new NotificationError("notFound");
    await tx.notificationRecipient.updateMany({
      where: { userId, notificationId, readAt: null },
      data: { readAt: new Date() },
    });
  });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await activeUser(tx, userId);
    await tx.notificationRecipient.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  });
}
