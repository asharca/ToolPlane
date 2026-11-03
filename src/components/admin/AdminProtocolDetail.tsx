import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getMcpCall } from "@/lib/observability/views/mcp-calls";
import { getA2ATask } from "@/lib/observability/views/a2a-tasks";
import { McpCallDetail } from "@/components/observability/McpCallDetail";
import { A2ATaskDetail } from "@/components/observability/A2ATaskDetail";
import { AdminPage, AdminPageHeader } from "./AdminUI";
import { adminReturnHref } from "@/lib/admin/navigation";

export async function AdminProtocolDetail({
  kind,
  id,
  returnTo,
}: {
  kind: "mcp" | "a2a";
  id: string;
  returnTo?: string;
}) {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");
  const scope = { kind: "admin" as const, userId: admin.id };
  const detail =
    kind === "mcp" ? await getMcpCall(scope, id) : await getA2ATask(scope, id);
  if (!detail) notFound();
  return (
    <AdminPage>
      <AdminPageHeader
        title={t(`logsTab_${kind}`)}
        backHref={adminReturnHref(returnTo, `/admin/logs?tab=${kind}`)}
        backLabel={t("logsTitle")}
        meta={detail.summary.workspace?.name}
      />
      {"bodyState" in detail ? (
        <McpCallDetail detail={detail} />
      ) : (
        <A2ATaskDetail detail={detail} />
      )}
    </AdminPage>
  );
}
