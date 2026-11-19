import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FolderOpen, Settings } from "lucide-react";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { getWorkspaceMembers } from "@/lib/workspace/queries";
import {
  getUserQuotaSummary,
  getWorkspaceStorageBytes,
} from "@/lib/storage/user-quota";
import { listProviders } from "@/lib/agents/queries";
import { StorageUsage } from "@/components/ui/StorageUsage";
import {
  ModelRetrySetting,
  WorkspaceModelSettings,
} from "./models/WorkspaceModelSettings";
import { DashboardPanel } from "./DashboardUI";
import {
  RenameWorkspaceForm,
  WorkspaceDeleteForm,
  WorkspaceLeaveAction,
  WorkspaceTransferForm,
} from "./WorkspaceForms";
import {
  ModalSidebarLayout,
  ModalSidebarSectionLink,
} from "./ModalSidebarLayout";
import { DialogBody } from "./dialog";
import { WorkspaceFilesManager } from "./WorkspaceFilesManager";

export type WorkspaceSettingsSection = "general" | "files";

export async function WorkspaceSettingsContent({
  slug,
  section,
}: {
  slug: string;
  section: WorkspaceSettingsSection;
}) {
  const [t, management] = await Promise.all([
    getTranslations("console.settings"),
    getTranslations("console.workspaces"),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const ws = await resolveWorkspaceScope({ slug }, user.id);
  if (!ws) redirect("/app?view=workspaces&notice=unavailable");
  const isOwner = ws.ownerId === user.id;
  const [providers, members, impact, running, workspaceBytes, ownerQuota] =
    await Promise.all([
      listProviders(ws.id),
      getWorkspaceMembers(ws.id),
      isOwner
        ? db.workspace.findUnique({
            where: { id: ws.id },
            select: {
              _count: {
                select: {
                  deployments: true,
                  agents: true,
                  chatThreads: true,
                  workSessions: true,
                  installedSkills: true,
                  toolkits: true,
                  knowledgeBases: true,
                },
              },
            },
          })
        : null,
      isOwner
        ? db.workSession.count({
            where: {
              workspaceId: ws.id,
              status: {
                in: ["queued", "running", "waiting_user", "cancelling"],
              },
            },
          })
        : 0,
      getWorkspaceStorageBytes(ws.id),
      isOwner ? getUserQuotaSummary(user.id) : null,
    ]);
  const modelSelection = (providerId: string | null, model: string | null) =>
    providerId &&
    model &&
    providers.some(
      (provider) =>
        provider.id === providerId && provider.models.includes(model),
    )
      ? { providerId, model }
      : null;
  const sections = [
    {
      id: "general",
      label: t("general"),
      icon: <Settings className="size-4" />,
      content: (
        <DialogBody>
          <DashboardPanel
            title={t("general")}
            description={management("sharedHint")}
          >
            <RenameWorkspaceForm
              slug={slug}
              name={ws.name}
              canManage={isOwner}
            />
          </DashboardPanel>
          <DashboardPanel title={t("storageUsage")}>
            <div className="space-y-3">
              {ownerQuota && (
                <StorageUsage
                  label={t("ownedWorkspaceStorage")}
                  usedBytes={ownerQuota.usedBytes}
                  quotaBytes={ownerQuota.storageQuotaBytes}
                />
              )}
              <StorageUsage
                label={t("thisWorkspaceStorage")}
                usedBytes={workspaceBytes}
              />
              <ModalSidebarSectionLink
                section="files"
                className="text-sm font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {t("manageFiles")}
              </ModalSidebarSectionLink>
            </div>
          </DashboardPanel>
          <DashboardPanel
            title={t("modelPreferences")}
            description={t("modelPreferencesDesc")}
          >
            {isOwner ? (
              <WorkspaceModelSettings
                slug={slug}
                providers={providers.map((provider) => ({
                  id: provider.id,
                  name: provider.name,
                  models: provider.models,
                  modelRecords: (provider.modelRecords ?? []).map((model) => ({
                    modelId: model.modelId,
                    primaryType: model.primaryType,
                    capabilities: model.capabilities,
                    inputModalities: model.inputModalities,
                    cost: model.cost,
                  })),
                }))}
                defaultModel={modelSelection(
                  ws.defaultModelProviderId,
                  ws.defaultModel,
                )}
                titleModel={modelSelection(
                  ws.titleModelProviderId,
                  ws.titleModel,
                )}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {management("ownerOnly")}
              </p>
            )}
          </DashboardPanel>
          <DashboardPanel title={t("modelRetry")}>
            <ModelRetrySetting
              slug={slug}
              initialAttempts={ws.modelRetryAttempts}
            />
          </DashboardPanel>
          {isOwner ? (
            <DashboardPanel title={t("dangerZone")} tone="danger">
              <div className="space-y-5">
                {members.some((member) => member.userId !== user.id) ? (
                  <WorkspaceTransferForm
                    slug={slug}
                    name={ws.name}
                    members={members
                      .filter((member) => member.userId !== user.id)
                      .map((member) => ({
                        userId: member.userId,
                        label: member.user.name
                          ? `${member.user.name} (${member.user.email})`
                          : member.user.email,
                      }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {management("transferEmpty")}
                  </p>
                )}
                <WorkspaceDeleteForm
                  slug={slug}
                  name={ws.name}
                  impact={management("deleteImpact", {
                    members: members.length,
                    resources: impact
                      ? Object.values(impact._count).reduce(
                          (sum, count) => sum + count,
                          0,
                        )
                      : 0,
                    running,
                  })}
                />
              </div>
            </DashboardPanel>
          ) : (
            <DashboardPanel title={management("leave")}>
              <WorkspaceLeaveAction slug={slug} />
            </DashboardPanel>
          )}
        </DialogBody>
      ),
    },
    {
      id: "files",
      label: t("files"),
      icon: <FolderOpen className="size-4" />,
      content: (
        <DialogBody>
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
        </DialogBody>
      ),
    },
  ];
  return (
    <ModalSidebarLayout
      label={t("title")}
      sections={sections}
      initialSection={section}
    />
  );
}
