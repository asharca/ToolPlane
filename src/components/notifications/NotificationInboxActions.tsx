"use client";

import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import {
  markNotificationReadAction,
  markAllNotificationsReadAction,
  type NotificationActionState,
} from "@/lib/notifications/actions";
import { acceptWorkspaceInvitationNotificationAction } from "@/lib/workspace/management-actions";

export function NotificationInboxActions({
  notificationId,
  canAcceptInvitation = false,
  unread = false,
}: {
  notificationId?: string;
  canAcceptInvitation?: boolean;
  unread?: boolean;
}) {
  const t = useTranslations("console.notifications");
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const refresh = () => {
    startRefresh(() => router.refresh());
    window.dispatchEvent(new Event("toolplane:notifications-changed"));
  };
  const [state, action, pending] = useActionState(
    async (previous: NotificationActionState, form: FormData) => {
      let result: NotificationActionState;
      try {
        result = await (notificationId
          ? markNotificationReadAction
          : markAllNotificationsReadAction)(previous, form);
      } catch {
        return { error: t("errors.failed") };
      }
      if (result.ok) refresh();
      return result;
    },
    {},
  );
  const [invitation, accept, accepting] = useActionState(
    acceptWorkspaceInvitationNotificationAction,
    {},
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!notificationId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refreshing}
            onClick={refresh}
          >
            {t("refresh")}
          </Button>
        ) : null}
        {unread ? (
          <form action={action} aria-busy={pending}>
            {notificationId ? (
              <input
                type="hidden"
                name="notificationId"
                value={notificationId}
              />
            ) : null}
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={pending}
            >
              {pending
                ? t("working")
                : t(notificationId ? "markRead" : "markAllRead")}
            </Button>
          </form>
        ) : null}
        {notificationId && canAcceptInvitation ? (
          <form action={accept} aria-busy={accepting}>
            <input type="hidden" name="notificationId" value={notificationId} />
            <Button type="submit" size="sm" disabled={accepting}>
              {accepting ? t("working") : t("acceptInvitation")}
            </Button>
          </form>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {invitation.error ? (
        <p role="alert" className="text-sm text-destructive">
          {invitation.error}
        </p>
      ) : null}
    </div>
  );
}
