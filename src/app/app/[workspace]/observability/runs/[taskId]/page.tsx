import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";

import { getAgentRun } from "@/lib/observability/views/agent-runs";
import { AgentRunDetail } from "@/components/observability/AgentRunDetail";
import { ButtonLink } from "@/components/motion/button";
import { DashboardPage } from "@/components/dashboard/DashboardUI";

export const dynamic = "force-dynamic";

export default async function AgentRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; taskId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { workspace: slug, taskId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await resolveWorkspaceScope({ slug }, user.id);
  if (!workspace) notFound();
  const detail = await getAgentRun(
    { kind: "workspace", workspaceId: workspace.id, userId: user.id },
    taskId,
  );
  if (!detail) notFound();
  const t = await getTranslations("console.observability.viewer");
  const base = `/app/${encodeURIComponent(slug)}/observability`;
  const { returnTo } = await searchParams;
  const safeBack = returnTo?.startsWith(base) ? returnTo : null;
  return (
    <DashboardPage>
      <ButtonLink href={safeBack ?? base} variant="ghost" size="sm">
        ← {t("runs")}
      </ButtonLink>
      <AgentRunDetail detail={detail} base={base} workspaceSlug={slug} />
    </DashboardPage>
  );
}
