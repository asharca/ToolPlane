"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  NotificationError,
  publishNotification,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadNotificationCount,
  type PublishNotificationInput,
} from "./service";

export type NotificationActionState = {
  error?: string;
  recipientCount?: number;
  ok?: boolean;
};

async function failure(error: unknown): Promise<{ error: string }> {
  const t = await getTranslations("console.notifications");
  return {
    error: t(
      `errors.${error instanceof NotificationError ? error.code : "failed"}`,
    ),
  };
}

async function publish(
  actorId: string,
  scope: PublishNotificationInput["scope"],
  form: FormData,
): Promise<NotificationActionState> {
  try {
    const audience = form.get("audience");
    if (audience !== "all" && audience !== "selected")
      throw new NotificationError("invalidRecipients");
    const emailsValue = form.get("emails");
    if (emailsValue !== null && typeof emailsValue !== "string")
      throw new NotificationError("invalidRecipients");
    const emailsText = emailsValue ?? "";
    if (emailsText.length > 32100)
      throw new NotificationError("invalidRecipients");
    const title = form.get("title");
    const body = form.get("body");
    if (typeof title !== "string" || typeof body !== "string")
      throw new NotificationError("invalidContent");
    const result = await publishNotification(actorId, {
      scope,
      audience,
      emails: emailsText
        .split(/[,\n]/)
        .map((email) => email.trim())
        .filter(Boolean),
      title,
      body,
    });
    revalidatePath("/app", "layout");
    if (scope.kind === "site") revalidatePath("/admin/notifications");
    return { ok: true, recipientCount: result.recipientCount };
  } catch (error) {
    return failure(error);
  }
}

export async function publishSiteNotificationAction(
  _prev: NotificationActionState,
  form: FormData,
): Promise<NotificationActionState> {
  const admin = await requireAdmin();
  return publish(admin.id, { kind: "site" }, form);
}

export async function publishWorkspaceNotificationAction(
  _prev: NotificationActionState,
  form: FormData,
): Promise<NotificationActionState> {
  const user = await getCurrentUser();
  if (!user) return failure(new NotificationError("forbidden"));
  try {
    const slug = form.get("workspace");
    if (typeof slug !== "string" || !slug || slug.length > 128)
      throw new NotificationError("forbidden");
    return await publish(user.id, { kind: "workspace", slug }, form);
  } catch (error) {
    return failure(error);
  }
}

export async function markNotificationReadAction(
  _prev: NotificationActionState,
  form: FormData,
): Promise<NotificationActionState> {
  const user = await getCurrentUser();
  if (!user) return failure(new NotificationError("forbidden"));
  try {
    const notificationId = form.get("notificationId");
    if (
      typeof notificationId !== "string" ||
      !notificationId ||
      notificationId.length > 200
    )
      throw new NotificationError("notFound");
    await markNotificationRead(user.id, notificationId);
    revalidatePath("/app", "layout");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function markAllNotificationsReadAction(
  _prev: NotificationActionState,
  form: FormData,
): Promise<NotificationActionState> {
  void form;
  const user = await getCurrentUser();
  if (!user) return failure(new NotificationError("forbidden"));
  try {
    await markAllNotificationsRead(user.id);
    revalidatePath("/app", "layout");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function getUnreadNotificationCountAction(): Promise<
  { count: number } | { error: string }
> {
  const user = await getCurrentUser();
  try {
    if (!user) throw new NotificationError("forbidden");
    return { count: await getUnreadNotificationCount(user.id) };
  } catch (error) {
    const result = await failure(error);
    return { error: result.error };
  }
}
