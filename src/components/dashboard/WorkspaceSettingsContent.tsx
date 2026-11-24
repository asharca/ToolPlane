import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { getWorkspaceMembers } from "@/lib/workspace/queries";
import {
  getUserQuotaSummary,
  getWorkspaceStorageBytes,
} from "@/lib/storage/user-quota";
import { listProviders } from "@/lib/agents/queries";
import { ButtonLink } from "@/components/motion/button";
import { StorageUsage } from "@/components/ui/StorageUsage";
import {
  ModelRetrySetting,
  WorkspaceModelSettings,
} from "./models/WorkspaceModelSettings";
import {
  RenameWorkspaceForm,
  WorkspaceDeleteForm,
  WorkspaceLeaveAction,
  WorkspaceTransferForm,
} from "./WorkspaceForms";

export async function WorkspaceSettingsContent({ slug }: { slug: string }) {
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

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("general")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {management("sharedHint")}
          </p>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          <div className="px-5 py-4">
            <RenameWorkspaceForm
              slug={slug}
              name={ws.name}
              canManage={isOwner}
            />
          </div>
          <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2.5 sm:max-w-md">
              <p className="text-sm font-medium text-foreground">
                {t("storageUsage")}
              </p>
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
            </div>
            <ButtonLink
              href={`/app/${encodeURIComponent(slug)}/files`}
              variant="secondary"
              size="sm"
              className="shrink-0 self-start sm:self-center"
            >
              {t("manageFiles")}
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("modelPreferences")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("modelPreferencesDesc")}
          </p>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
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
            <p className="px-5 py-4 text-sm text-muted-foreground">
              {management("ownerOnly")}
            </p>
          )}
          <ModelRetrySetting
            slug={slug}
            initialAttempts={ws.modelRetryAttempts}
          />
        </div>
      </section>

      <section id="danger-zone" className="scroll-mt-6 space-y-3">
        {isOwner ? (
          <>
            <h2 className="text-sm font-semibold text-destructive">
              {t("dangerZone")}
            </h2>
            <div className="space-y-5 rounded-xl border border-destructive/25 bg-card p-5">
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
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-foreground">
              {management("leave")}
            </h2>
            <div className="rounded-xl border border-border bg-card p-5">
              <WorkspaceLeaveAction slug={slug} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
