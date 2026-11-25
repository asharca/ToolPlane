import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { ButtonLink } from "@/components/motion/button";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { PersonalSettingsContent } from "@/components/dashboard/PersonalSettingsContent";

export const dynamic = "force-dynamic";

export default async function PersonalSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ section?: string; returnTo?: string }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await resolveWorkspaceScope({ slug }, user.id);
  if (!workspace) redirect("/app?view=workspaces&notice=unavailable");

  const section =
    query.section === "security" || query.section === "tokens"
      ? query.section
      : "preferences";
  const workspacesT = await getTranslations("console.workspaces");
  const fallbackHref = `/app/${encodeURIComponent(workspace.slug)}/chat`;
  const backHref =
    (query.returnTo === "/app?view=workspaces" ||
      query.returnTo?.startsWith("/app/")) &&
    !query.returnTo.includes("/settings/account")
      ? query.returnTo
      : fallbackHref;

  return (
    <DashboardPage className="max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DashboardHeader title={workspacesT("account")} visible />
        <ButtonLink href={backHref} variant="ghost" size="sm">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {workspacesT("backToWorkspace")}
        </ButtonLink>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <PersonalSettingsContent
          user={user}
          section={section}
          workspaceSlug={workspace.slug}
        />
      </div>
    </DashboardPage>
  );
}
