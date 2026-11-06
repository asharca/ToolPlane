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
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
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
  const base = `/app/${encodeURIComponent(slug)}/observability`;
  const { returnTo } = await searchParams;
  const runBack = returnTo?.startsWith(`${base}/runs/`) ? returnTo : null;
  return (
    <DashboardPage>
      <ButtonLink
        href={
          runBack ??
          `${base}?tab=${detail.source === "calls" ? "mcp" : detail.source}`
        }
        variant="ghost"
        size="sm"
      >
        ←{" "}
        {t(runBack ? "run" : detail.source === "calls" ? "mcp" : detail.source)}
      </ButtonLink>
      <McpCallDetail detail={detail} />
    </DashboardPage>
  );
}
