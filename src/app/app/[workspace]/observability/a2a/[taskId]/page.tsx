import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getA2ATask } from "@/lib/observability/views/a2a-tasks";
import { A2ATaskDetail } from "@/components/observability/A2ATaskDetail";
import { ButtonLink } from "@/components/motion/button";
import { DashboardPage } from "@/components/dashboard/DashboardUI";

export const dynamic = "force-dynamic";

export default async function A2ATaskPage({
  params,
}: {
  params: Promise<{ workspace: string; taskId: string }>;
}) {
  const { workspace: slug, taskId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) notFound();
  const detail = await getA2ATask(
    { kind: "workspace", workspaceId: workspace.id, userId: user.id },
    taskId,
  );
  if (!detail) notFound();
  const t = await getTranslations("console.observability.viewer");
  return (
    <DashboardPage>
      <ButtonLink
        href={`/app/${encodeURIComponent(slug)}/observability?tab=a2a`}
        variant="ghost"
        size="sm"
      >
        ← {t("a2a")}
      </ButtonLink>
      <A2ATaskDetail detail={detail} />
    </DashboardPage>
  );
}
