import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getMcpCall } from "@/lib/observability/views/mcp-calls";
import { McpCallDetail } from "@/components/observability/McpCallDetail";
import { ButtonLink } from "@/components/motion/button";
import { DashboardPage } from "@/components/dashboard/DashboardUI";

export const dynamic = "force-dynamic";

export default async function McpCallPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) notFound();
  const detail = await getMcpCall(
    { kind: "workspace", workspaceId: workspace.id, userId: user.id },
    id,
  );
  if (!detail) notFound();
  const t = await getTranslations("console.observability.viewer");
  return (
    <DashboardPage>
      <ButtonLink
        href={`/app/${encodeURIComponent(slug)}/observability?tab=${detail.source === "calls" ? "mcp" : detail.source}`}
        variant="ghost"
        size="sm"
      >
        ← {t(detail.source === "calls" ? "mcp" : detail.source)}
      </ButtonLink>
      <McpCallDetail detail={detail} />
    </DashboardPage>
  );
}
