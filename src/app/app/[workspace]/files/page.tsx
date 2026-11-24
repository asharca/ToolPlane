import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import {
  getUserQuotaSummary,
  getWorkspaceStorageBytes,
} from "@/lib/storage/user-quota";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { WorkspaceFilesManager } from "@/components/dashboard/WorkspaceFilesManager";

export const dynamic = "force-dynamic";

export default async function WorkspaceFilesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/files`)}`);
  }
  const ws = await resolveWorkspaceScope({ slug }, user.id);
  if (!ws) redirect("/app?view=workspaces&notice=unavailable");

  const [t, workspaceBytes, ownerQuota] = await Promise.all([
    getTranslations("console.settings"),
    getWorkspaceStorageBytes(ws.id),
    ws.ownerId === user.id ? getUserQuotaSummary(user.id) : null,
  ]);

  return (
    <DashboardPage>
      <DashboardHeader title={t("files")} />
      <WorkspaceFilesManager
        workspaceId={ws.id}
        initialUsage={{
          workspaceBytes,
          owner: ownerQuota
            ? {
                usedBytes: ownerQuota.usedBytes,
                storageQuotaBytes: ownerQuota.storageQuotaBytes,
              }
            : null,
        }}
      />
    </DashboardPage>
  );
}
