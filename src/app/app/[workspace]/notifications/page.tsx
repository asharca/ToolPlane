import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { resolveUserTimeZone } from "@/lib/timezone";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; unread?: string }>;
}) {
  const [{ workspace }, query, user] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
  ]);
  const page = normalizeAdminPage(Number(query.page ?? 1));
  const unreadOnly = query.unread === "1";
  const baseHref = `/app/${encodeURIComponent(workspace)}/notifications`;
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`${baseHref}?page=${page}${unreadOnly ? "&unread=1" : ""}`)}`,
    );
  if (!(await getWorkspaceForUser(workspace, user.id)))
    redirect("/app?view=notifications");
  return (
    <DashboardPage className="py-8">
      <NotificationInbox
        userId={user.id}
        page={page}
        unreadOnly={unreadOnly}
        timeZone={resolveUserTimeZone(user)}
        baseHref={baseHref}
      />
    </DashboardPage>
  );
}
