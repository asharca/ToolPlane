import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getWorkspaceForUser,
  getWorkspaceMembers,
} from "@/lib/workspace/queries";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { resolveUserTimeZone } from "@/lib/timezone";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { PublishWorkspaceNotification } from "@/components/notifications/NotificationComposer";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; unread?: string }>;
}) {
  const [{ workspace }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.notifications"),
  ]);
  const page = normalizeAdminPage(Number(query.page ?? 1));
  const unreadOnly = query.unread === "1";
  const baseHref = `/app/${encodeURIComponent(workspace)}/notifications`;
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`${baseHref}?page=${page}${unreadOnly ? "&unread=1" : ""}`)}`,
    );
  const ws = await getWorkspaceForUser(workspace, user.id);
  if (!ws) redirect("/app?view=notifications");
  // Owners and workspace admins may publish; the server action re-checks.
  const members = await getWorkspaceMembers(ws.id);
  const canPublish =
    ws.ownerId === user.id ||
    members.some(
      (member) => member.userId === user.id && member.role === "admin",
    );
  return (
    <>
      <DashboardHeader title={t("title")} />
      <DashboardPage className="max-w-4xl py-8">
        <NotificationInbox
          userId={user.id}
          page={page}
          unreadOnly={unreadOnly}
          timeZone={resolveUserTimeZone(user)}
          baseHref={baseHref}
          actions={
            canPublish ? (
              <PublishWorkspaceNotification
                workspaceSlug={ws.slug}
                members={members.map((member) => ({
                  name: member.user.name ?? member.user.email.split("@")[0],
                  email: member.user.email,
                }))}
              />
            ) : null
          }
        />
      </DashboardPage>
    </>
  );
}
