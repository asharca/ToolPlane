import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listWorkspacesForUser } from "@/lib/workspace/queries";
import { getUserQuotaSummary } from "@/lib/storage/user-quota";
import { DashboardChrome } from "@/components/dashboard/DashboardChrome";
import { UserTimeZoneProvider } from "@/components/timezone/UserTimeZoneProvider";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { runtimeSupportEmail } from "@/lib/site-runtime";
import { dashboardSidebarCookieName } from "@/lib/sidebar-preferences";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user)
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/work`)}`);
  const ws = await resolveWorkspaceScope({ slug }, user.id);
  if (!ws) redirect("/app?view=workspaces&notice=unavailable");
  const [workspaces, messages, cookieStore, quota] = await Promise.all([
    listWorkspacesForUser(user.id),
    getMessages(),
    cookies(),
    getUserQuotaSummary(user.id),
  ]);
  const initialSidebarCollapsed =
    cookieStore.get(dashboardSidebarCookieName(ws.id))?.value === "true";

  return (
    <NextIntlClientProvider
      messages={{
        common: messages.common,
        filePreview: messages.filePreview,
        console: messages.console,
        auth: messages.auth,
        agentMarket: messages.agentMarket,
      }}
    >
      <UserTimeZoneProvider
        detectedTimeZone={user.detectedTimeZone}
        timeZoneOverride={user.timeZoneOverride}
      >
        <DashboardChrome
          slug={ws.slug}
          userId={user.id}
          workspaceId={ws.id}
          workspaceName={ws.name}
          userLabel={user.name ?? user.email}
          quota={{
            ownedWorkspaces: quota.ownedWorkspaces,
            maxOwnedWorkspaces: quota.maxOwnedWorkspaces,
          }}
          workspaces={workspaces.filter(
            (workspace) => workspace.status === "active",
          )}
          supportEmail={runtimeSupportEmail()}
          isAdmin={user.role === "admin"}
          initialSidebarCollapsed={initialSidebarCollapsed}
        >
          {children}
          {modal}
        </DashboardChrome>
      </UserTimeZoneProvider>
    </NextIntlClientProvider>
  );
}
