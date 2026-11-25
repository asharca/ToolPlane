import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { PersonalSettingsContent } from "@/components/dashboard/PersonalSettingsContent";
import { SettingsModal } from "@/components/dashboard/SettingsModal";

export const dynamic = "force-dynamic";

export default async function InterceptedPersonalSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ section?: string }>;
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

  return (
    <SettingsModal
      title={workspacesT("account")}
      fallbackHref={`/app/${encodeURIComponent(workspace.slug)}/chat`}
    >
      <PersonalSettingsContent
        user={user}
        section={section}
        workspaceSlug={workspace.slug}
      />
    </SettingsModal>
  );
}
