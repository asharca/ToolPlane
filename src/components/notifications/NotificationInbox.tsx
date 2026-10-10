import { getLocale, getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/motion/button";
import { DashboardPanel } from "@/components/dashboard/DashboardUI";
import { AdminPagination } from "@/components/admin/AdminUI";
import { listNotifications } from "@/lib/notifications/service";
import { formatInTimeZone } from "@/lib/timezone";
import { NotificationInboxActions } from "./NotificationInboxActions";

export async function NotificationInbox({
  userId,
  page,
  unreadOnly = false,
  timeZone,
  baseHref = "/app?view=notifications",
}: {
  userId: string;
  page?: number;
  unreadOnly?: boolean;
  timeZone: string;
  baseHref?: string;
}) {
  const [t, locale, notifications] = await Promise.all([
    getTranslations("console.notifications"),
    getLocale(),
    listNotifications(userId, { page, unreadOnly }),
  ]);
  const separator = baseHref.includes("?") ? "&" : "?";
  const unreadHref = `${baseHref}${separator}unread=1`;
  const hrefForPage = (number: number) =>
    `${unreadOnly ? unreadHref : baseHref}${unreadOnly ? "&" : separator}page=${number}`;
  return (
    <DashboardPanel
      title={t("title")}
      description={t("unreadCount", { count: notifications.unreadCount })}
    >
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
            <ButtonLink
              href={baseHref}
              variant={unreadOnly ? "secondary" : "primary"}
              size="sm"
              aria-current={!unreadOnly ? "page" : undefined}
            >
              {t("all")}
            </ButtonLink>
            <ButtonLink
              href={unreadHref}
              variant={unreadOnly ? "primary" : "secondary"}
              size="sm"
              aria-current={unreadOnly ? "page" : undefined}
            >
              {t("unread")}
            </ButtonLink>
          </nav>
          <NotificationInboxActions unread={notifications.unreadCount > 0} />
        </div>
        {notifications.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t(unreadOnly ? "emptyUnread" : "empty")}
          </p>
        ) : (
          <ul className="space-y-4">
            {notifications.items.map((item) => {
              const invitation = item.kind === "workspace_invitation";
              const workspace = item.workspaceName ?? t("unavailableWorkspace");
              return (
                <li
                  key={item.id}
                  className="min-w-0 space-y-3 rounded-lg border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{t(`sources.${item.kind}`)}</span>
                    <span>{t(item.readAt ? "read" : "unread")}</span>
                  </div>
                  <h3 className="break-words text-base font-semibold [overflow-wrap:anywhere]">
                    {invitation
                      ? t("invitationTitle", { workspace })
                      : item.title}
                  </h3>
                  <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                    {invitation
                      ? t("invitationBody", { workspace })
                      : item.body}
                  </p>
                  {item.workspaceName ? (
                    <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {t("workspace", { workspace: item.workspaceName })}
                    </p>
                  ) : null}
                  <time
                    dateTime={item.createdAt.toISOString()}
                    className="block text-xs text-muted-foreground"
                  >
                    {formatInTimeZone(
                      item.createdAt,
                      timeZone,
                      { dateStyle: "medium", timeStyle: "short" },
                      locale,
                    )}
                  </time>
                  {invitation && !item.canAcceptInvitation ? (
                    <p className="text-sm text-muted-foreground">
                      {t("invitationUnavailable")}
                    </p>
                  ) : null}
                  <NotificationInboxActions
                    notificationId={item.id}
                    unread={!item.readAt}
                    canAcceptInvitation={item.canAcceptInvitation}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <AdminPagination
          page={notifications.page}
          total={notifications.total}
          pageSize={notifications.pageSize}
          itemLabel={t("items")}
          pageLabel={t("page")}
          previousLabel={t("previous")}
          nextLabel={t("next")}
          hrefForPage={hrefForPage}
        />
      </div>
    </DashboardPanel>
  );
}
