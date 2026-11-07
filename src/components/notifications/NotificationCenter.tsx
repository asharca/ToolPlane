"use client";

import { useActionState, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Gauge,
  Megaphone,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import {
  DashboardEmptyState,
  DashboardPagination,
} from "@/components/dashboard/DashboardUI";
import { notify } from "@/components/dashboard/Toaster";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/notifications/actions";
import { acceptWorkspaceInvitationNotificationAction } from "@/lib/workspace/management-actions";
import type { NotificationItem } from "@/lib/notifications/service";
import { cn } from "@/lib/utils";

export type NotificationListItem = {
  id: string;
  kind: NotificationItem["kind"];
  title: string;
  body: string;
  workspaceName: string | null;
  time: string;
  fullTime: string;
  dateTime: string;
  read: boolean;
  /** Invitation state; null for announcements. */
  invitation: "open" | "closed" | null;
};

const CHANGED_EVENT = "toolplane:notifications-changed";

export function NotificationCenter({
  items,
  unreadCount,
  unreadOnly,
  allHref,
  unreadHref,
  page,
  lastPage,
  total,
  pageHrefPrefix,
  actions,
}: {
  items: NotificationListItem[];
  unreadCount: number;
  unreadOnly: boolean;
  allHref: string;
  unreadHref: string;
  page: number;
  lastPage: number;
  total: number;
  pageHrefPrefix: string;
  actions?: ReactNode;
}) {
  const t = useTranslations("console.notifications");
  const router = useRouter();
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const [allRead, setAllRead] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Reading an item revalidates the page; keep it visible (as read) until the
  // user changes view, so the unread filter does not pull rows out from under them.
  const view = `${unreadOnly}:${page}`;
  const [snapshot, setSnapshot] = useState({ view, items });
  if (snapshot.view !== view) {
    setSnapshot({ view, items });
    setReadIds(new Set());
    setAllRead(false);
  }
  const current = new Map(items.map((item) => [item.id, item]));
  const known = new Set(snapshot.items.map((item) => item.id));
  const list = [
    ...items.filter((item) => !known.has(item.id)),
    ...snapshot.items.map(
      (item) => current.get(item.id) ?? { ...item, read: true },
    ),
  ].map((item) =>
    allRead || readIds.has(item.id) ? { ...item, read: true } : item,
  );
  const unread = allRead
    ? 0
    : Math.max(
        0,
        unreadCount -
          items.filter((item) => !item.read && readIds.has(item.id)).length,
      );

  const markRead = async (id: string) => {
    if (readIds.has(id)) return;
    setReadIds((ids) => new Set(ids).add(id));
    const form = new FormData();
    form.set("notificationId", id);
    try {
      const result = await markNotificationReadAction({}, form);
      if (result.error) throw new Error(result.error);
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (error) {
      setReadIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
      notify(
        error instanceof Error && error.message
          ? error.message
          : t("errors.failed"),
        {
          severity: "error",
        },
      );
    }
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    setAllRead(true);
    try {
      const result = await markAllNotificationsReadAction({}, new FormData());
      if (result.error) throw new Error(result.error);
      window.dispatchEvent(new Event(CHANGED_EVENT));
    } catch (error) {
      setAllRead(false);
      notify(
        error instanceof Error && error.message
          ? error.message
          : t("errors.failed"),
        {
          severity: "error",
        },
      );
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={unreadOnly ? "unread" : "all"}
            onValueChange={(value) =>
              router.push(value === "unread" ? unreadHref : allHref)
            }
            variant="segment"
          >
            <TabsList aria-label={t("filterLabel")}>
              <TabsTrigger value="all">{t("all")}</TabsTrigger>
              <TabsTrigger value="unread">
                {t("unread")}
                {unread > 0 ? (
                  <span className="ml-1.5 tabular-nums opacity-70">
                    {unread}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {unread > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={markingAll}
              onClick={() => void markAllRead()}
            >
              <CheckCheck className="size-4" aria-hidden />
              {t("markAllRead")}
            </Button>
          ) : null}
          {actions}
        </div>
      </div>

      {list.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {list.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onRead={() => void markRead(item.id)}
            />
          ))}
        </ul>
      ) : (
        <DashboardEmptyState
          icon={unreadOnly ? CheckCheck : BellOff}
          title={t(unreadOnly ? "emptyUnread" : "empty")}
          className="rounded-xl border border-dashed border-border"
        />
      )}

      <DashboardPagination
        page={page}
        lastPage={lastPage}
        hrefForPage={(number) => `${pageHrefPrefix}${number}`}
        summary={t("pageSummary", { page, lastPage, total })}
        previousLabel={t("previous")}
        nextLabel={t("next")}
      />
    </section>
  );
}

const KIND_ICON: Record<NotificationItem["kind"], typeof Bell> = {
  workspace_invitation: UserPlus,
  workspace_announcement: Megaphone,
  site_announcement: Bell,
  agent_budget_alert: Gauge,
};

function NotificationRow({
  item,
  onRead,
}: {
  item: NotificationListItem;
  onRead: () => void;
}) {
  const t = useTranslations("console.notifications");
  const [expanded, setExpanded] = useState(false);
  const Icon = KIND_ICON[item.kind];
  const source = t(`sources.${item.kind}`);
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span
        aria-hidden
        className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground"
      >
        <Icon className="size-4" />
        {item.read ? null : (
          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-primary" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
            if (!item.read) onRead();
          }}
          className="block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-baseline gap-3">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                item.read ? "text-foreground/80" : "font-semibold",
              )}
            >
              <span className="sr-only">
                {t(item.read ? "read" : "unread")}:{" "}
              </span>
              {item.title}
            </span>
            <time
              dateTime={item.dateTime}
              title={item.fullTime}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {item.time}
            </time>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.workspaceName ? `${source} · ${item.workspaceName}` : source}
          </span>
          <span
            className={cn(
              "mt-1.5 block break-words text-sm text-muted-foreground [overflow-wrap:anywhere]",
              expanded ? "whitespace-pre-wrap" : "line-clamp-2",
            )}
          >
            {item.body}
          </span>
        </button>
        {item.invitation === "open" ? (
          <AcceptInvitation notificationId={item.id} />
        ) : item.invitation === "closed" ? (
          <p className="text-xs text-muted-foreground">
            {t("invitationUnavailable")}
          </p>
        ) : null}
      </div>
      {item.read ? (
        <span aria-hidden className="size-8 shrink-0" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("markReadFor", { title: item.title })}
          title={t("markRead")}
          className="size-8 shrink-0 text-muted-foreground"
          onClick={onRead}
        >
          <Check className="size-4" aria-hidden />
        </Button>
      )}
    </li>
  );
}

function AcceptInvitation({ notificationId }: { notificationId: string }) {
  const t = useTranslations("console.notifications");
  // Success redirects into the joined workspace.
  const [state, action, pending] = useActionState(
    acceptWorkspaceInvitationNotificationAction,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="primary" size="sm" disabled={pending}>
        {pending ? t("working") : t("acceptInvitation")}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
