import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { WorkspaceSettingsContent } from "@/components/dashboard/WorkspaceSettingsContent";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string; section?: string }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  if (query.section === "files") {
    redirect(`/app/${encodeURIComponent(workspace)}/files`);
  }
  if (
    query.tab === "account" ||
    query.section === "preferences" ||
    query.section === "security" ||
    query.section === "tokens"
  ) {
    const sectionQuery =
      query.section === "preferences" ||
      query.section === "security" ||
      query.section === "tokens"
        ? `?section=${query.section}`
        : "";
    redirect(
      `/app/${encodeURIComponent(workspace)}/settings/account${sectionQuery}`,
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${encodeURIComponent(workspace)}/settings`)}`,
    );
  }

  const ws = await resolveWorkspaceScope({ slug: workspace }, user.id);
  if (!ws) redirect("/app?view=workspaces&notice=unavailable");

  const t = await getTranslations("console.settings");

  return (
    <DashboardPage>
      <DashboardHeader title={t("title")} />
      <div className="max-w-4xl">
        <WorkspaceSettingsContent slug={ws.slug} />
      </div>
    </DashboardPage>
  );
}
