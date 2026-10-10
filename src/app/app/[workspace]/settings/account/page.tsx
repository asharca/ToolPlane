import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { PersonalSettingsContent } from "@/components/dashboard/PersonalSettingsContent";

export const dynamic = "force-dynamic";

export default async function PersonalSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { workspace: slug } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app?view=workspaces&notice=unavailable");

  const section =
    query.section === "security" || query.section === "tokens"
      ? query.section
      : "preferences";
  return <PersonalSettingsContent user={user} section={section} />;
}
