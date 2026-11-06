import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { listNotifications } from "@/lib/notifications/service";
import { formatInTimeZone } from "@/lib/timezone";
import {
  NotificationCenter,
  type NotificationListItem,
} from "./NotificationCenter";

export async function NotificationInbox({
  userId,
  page,
  unreadOnly = false,
  timeZone,
  baseHref = "/app?view=notifications",
  actions,
}: {
  userId: string;
  page?: number;
  unreadOnly?: boolean;
  timeZone: string;
  baseHref?: string;
  actions?: ReactNode;
}) {
  const [t, locale, notifications] = await Promise.all([
    getTranslations("console.notifications"),
    getLocale(),
    listNotifications(userId, { page, unreadOnly }),
  ]);
  const now = new Date();
  const day = (date: Date) =>
    formatInTimeZone(date, timeZone, { dateStyle: "short" }, locale);
  const year = (date: Date) =>
    formatInTimeZone(date, timeZone, { year: "numeric" }, locale);
  // Recent items need only the time; older ones need progressively more date.
  const shortTime = (date: Date) =>
    formatInTimeZone(
      date,
      timeZone,
      day(date) === day(now)
        ? { timeStyle: "short" }
        : year(date) === year(now)
          ? { month: "short", day: "numeric" }
          : { dateStyle: "medium" },
      locale,
    );

  const items = notifications.items.map((item): NotificationListItem => {
    const invitation = item.kind === "workspace_invitation";
    const workspace = item.workspaceName ?? t("unavailableWorkspace");
    return {
      id: item.id,
      kind: item.kind,
      title: invitation
        ? t("invitationTitle", { workspace })
        : (item.title ?? ""),
      body: invitation ? t("invitationBody", { workspace }) : (item.body ?? ""),
      workspaceName: invitation ? null : item.workspaceName,
      time: shortTime(item.createdAt),
      fullTime: formatInTimeZone(
        item.createdAt,
        timeZone,
        { dateStyle: "full", timeStyle: "short" },
        locale,
      ),
      dateTime: item.createdAt.toISOString(),
      read: item.readAt !== null,
      invitation: invitation
        ? item.canAcceptInvitation
          ? "open"
          : "closed"
        : null,
    };
  });

  const separator = baseHref.includes("?") ? "&" : "?";
  const unreadHref = `${baseHref}${separator}unread=1`;
  return (
    <NotificationCenter
      items={items}
      unreadCount={notifications.unreadCount}
      unreadOnly={unreadOnly}
      allHref={baseHref}
      unreadHref={unreadHref}
      page={notifications.page}
      lastPage={Math.max(
        1,
        Math.ceil(notifications.total / notifications.pageSize),
      )}
      total={notifications.total}
      pageHrefPrefix={`${unreadOnly ? unreadHref : baseHref}${unreadOnly ? "&" : separator}page=`}
      actions={actions}
    />
  );
}
