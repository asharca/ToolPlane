import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getAgentRun } from "@/lib/observability/views/agent-runs";
import { adminReturnHref } from "@/lib/admin/navigation";
import { AdminPage, AdminPageHeader } from "@/components/admin/AdminUI";
import { AgentRunDetail } from "@/components/observability/AgentRunDetail";

export const dynamic = "force-dynamic";

export default async function AgentRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const admin = await requireAdmin();
  const detail = await getAgentRun(
    { kind: "admin", userId: admin.id },
    (await params).taskId,
  );
  if (!detail) notFound();
  const t = await getTranslations("console.observability.viewer");
  return (
    <AdminPage>
      <AdminPageHeader
        title={t("runs")}
        backHref={adminReturnHref(
          (await searchParams).returnTo,
          "/admin/logs?tab=runs",
        )}
        backLabel={t("runs")}
        meta={detail.summary.workspace?.name}
      />
      <AgentRunDetail detail={detail} base="/admin/logs" />
    </AdminPage>
  );
}
