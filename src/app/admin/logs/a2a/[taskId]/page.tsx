import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getA2ATask } from "@/lib/observability/views/a2a-tasks";
import { getAgentRun } from "@/lib/observability/views/agent-runs";
import { adminReturnHref } from "@/lib/admin/navigation";
import { AdminPage, AdminPageHeader } from "@/components/admin/AdminUI";
import { A2ATaskDetail } from "@/components/observability/A2ATaskDetail";

export const dynamic = "force-dynamic";

export default async function DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const admin = await requireAdmin();
  const { taskId } = await params;
  const { returnTo } = await searchParams;
  const scope = { kind: "admin" as const, userId: admin.id };
  const detail = await getA2ATask(scope, taskId);
  if (!detail) {
    const run = await getAgentRun(scope, taskId);
    if (run)
      redirect(
        `/admin/logs/runs/${encodeURIComponent(taskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
      );
    notFound();
  }
  const t = await getTranslations("console.observability.viewer");
  return (
    <AdminPage>
      <AdminPageHeader
        title={t("a2a")}
        backHref={adminReturnHref(returnTo, "/admin/logs?tab=a2a")}
        backLabel={t("a2a")}
        meta={detail.summary.workspace?.name}
      />
      <A2ATaskDetail detail={detail} />
    </AdminPage>
  );
}
