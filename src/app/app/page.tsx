import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getDefaultWorkspace,
  getWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/workspace/queries";
import { WorkspaceAccountPage } from "@/components/dashboard/WorkspaceAccountPage";
import { WorkspaceInvitationPage } from "@/components/dashboard/WorkspaceInvitationPage";
import { lastWorkspaceCookieName } from "@/lib/workspace/navigation";
import { normalizeAdminPage } from "@/lib/admin/pagination";

export const dynamic = "force-dynamic";

function intentSlug(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._-]{1,200}$/.test(candidate)
    ? candidate
    : null;
}

export default async function AppIndexPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    workspace?: string;
    notice?: string;
    page?: string;
    unread?: string;
  }>;
}) {
  const query = await searchParams;
  const intent = "/app";
  const user = await getCurrentUser();
  if (query.view === "notifications") {
    const page = normalizeAdminPage(Number(query.page ?? 1));
    const unreadOnly = query.unread === "1";
    if (!user) {
      const next = `/app?view=notifications&page=${page}${unreadOnly ? "&unread=1" : ""}`;
      redirect(`/app/login?next=${encodeURIComponent(next)}`);
    }
    const cookieStore = await cookies();
    const workspace = await getDefaultWorkspace(
      user.id,
      cookieStore.get(lastWorkspaceCookieName(user.id))?.value,
    );
    if (workspace)
      redirect(
        `/app/${encodeURIComponent(workspace.slug)}/notifications?page=${page}${unreadOnly ? "&unread=1" : ""}`,
      );
    return (
      <WorkspaceAccountPage
        user={user}
        view="notifications"
        notificationPage={page}
        unreadOnly={unreadOnly}
      />
    );
  }
  if (query.view === "invitation")
    return <WorkspaceInvitationPage signedIn={Boolean(user)} />;
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(["account", "workspaces"].includes(query.view ?? "") ? `/app?view=${query.view}` : intent)}`,
    );
  if (query.view === "account")
    return <WorkspaceAccountPage user={user} view="account" />;
  if (query.view === "workspaces")
    return <WorkspaceAccountPage user={user} notice={query.notice} />;
  const selectedSlug = intentSlug(query.workspace);
  if (intent !== "/app" && !selectedSlug) {
    const workspaces = (await listWorkspacesForUser(user.id)).filter(
      (workspace) => workspace.status === "active",
    );
    if (workspaces.length !== 1)
      return <WorkspaceAccountPage user={user} intent={intent} />;
  }
  const cookieStore = await cookies();
  const ws = selectedSlug
    ? await getWorkspaceForUser(selectedSlug, user.id)
    : await getDefaultWorkspace(
        user.id,
        cookieStore.get(lastWorkspaceCookieName(user.id))?.value,
      );
  if (!ws)
    return (
      <WorkspaceAccountPage
        user={user}
        intent={intent !== "/app" ? intent : ""}
        notice={selectedSlug ? "unavailable" : ""}
      />
    );
  redirect(`/app/${encodeURIComponent(ws.slug)}/chat`);
}
