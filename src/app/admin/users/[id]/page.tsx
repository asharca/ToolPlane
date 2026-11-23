import { ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Activity, ShieldCheck } from "lucide-react";
import { adminHref, adminReturnHref } from "@/lib/admin/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { getUserDetail } from "@/lib/admin/users";
import { listUserWorkspaceAccess } from "@/lib/admin/workspace-members";
import {
  getUserLimitDefaults,
  getUserQuotaSummary,
} from "@/lib/storage/user-quota";
import { UserLimitsSettingsForm } from "@/components/admin/UserLimitsSettingsForm";
import { UserWorkspaceAccess } from "@/components/admin/UserWorkspaceAccess";
import { StorageUsage } from "@/components/ui/StorageUsage";
import {
  setUserRoleAction,
  setUserStatusAction,
  deleteUserAction,
} from "@/lib/admin/user-actions";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("admin"),
    getLocale(),
  ]);
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const { id } = await params;
  const u = await getUserDetail(id);
  if (!u) notFound();
  const [defaults, quota, workspaceAccess] = await Promise.all([
    getUserLimitDefaults(),
    getUserQuotaSummary(u.id),
    listUserWorkspaceAccess(u.id),
  ]);
  const isSelf = admin.id === u.id;
  const ops = await getTranslations("adminOps");
  const backHref = adminReturnHref(
    (await searchParams).returnTo,
    "/admin/users",
  );
  const selfHref = adminHref(`/admin/users/${id}`, { returnTo: backHref });
  const workspaceAccessEntries = workspaceAccess.map((entry) => ({
    ...entry,
    href: adminHref(`/admin/workspaces/${entry.workspace.id}`, {
      returnTo: selfHref,
    }),
  }));
  const impact = u.ownedWorkspaces.reduce(
    (sum, workspace) => ({
      deployments: sum.deployments + workspace._count.deployments,
      agents: sum.agents + workspace._count.agents,
      sandboxes: sum.sandboxes + workspace._count.sandboxes,
    }),
    { deployments: 0, agents: 0, sandboxes: 0 },
  );
  const joinedAt = formatInTimeZone(
    u.createdAt,
    timeZone,
    {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    },
    locale,
  );

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={u.name ?? u.email}
        description={`${u.email} ${t("joined")} ${joinedAt}`}
        backHref={backHref}
        backLabel={t("users1")}
        actions={
          <>
            <ButtonLink
              href={adminHref("/admin/logs", {
                domain: "all",
                actorId: id,
                returnTo: selfHref,
              })}
              variant="secondary"
              size="md"
            >
              <Activity className="size-4" />
              {ops("activity")}
            </ButtonLink>
            <ButtonLink
              href={adminHref("/admin/logs", {
                tab: "audit",
                targetType: "user",
                targetId: id,
                returnTo: selfHref,
              })}
              variant="secondary"
              size="md"
            >
              <ShieldCheck className="size-4" />
              {ops("audit")}
            </ButtonLink>
          </>
        }
        meta={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <AdminBadge tone={u.role === "admin" ? "info" : "neutral"}>
              {u.role === "admin" ? t("admin2") : t("user")}
            </AdminBadge>
            <AdminBadge
              tone={u.status === "suspended" ? "warning" : "success"}
              dot
            >
              {u.status === "suspended" ? t("suspended2") : t("active")}
            </AdminBadge>
          </span>
        }
      />

      <AdminPanel title={t("access")}>
        {isSelf ? (
          <p className="text-sm text-muted-foreground">
            {t("youCanapostChangeYourOwnRoleOrStatus")}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap">
            <ConfirmDialog
              label={
                u.role === "admin" ? t("demoteToUser") : t("promoteToAdmin")
              }
              prompt={u.role === "admin" ? t("removeAdmin") : t("grantAdmin")}
              action={setUserRoleAction}
              hidden={{
                userId: u.id,
                role: u.role === "admin" ? "user" : "admin",
              }}
              pendingLabel={t("saving")}
            />
            <ConfirmDialog
              label={u.status === "suspended" ? t("reactivate") : t("suspend")}
              prompt={
                u.status === "suspended"
                  ? t("reactivateThisAccount")
                  : t("suspendThisAccount")
              }
              action={setUserStatusAction}
              hidden={{
                userId: u.id,
                status: u.status === "suspended" ? "active" : "suspended",
              }}
              pendingLabel={t("saving")}
              tone={u.status === "suspended" ? "default" : "danger"}
            />
          </div>
        )}
      </AdminPanel>

      <UserLimitsSettingsForm
        defaults={defaults}
        user={{ id: u.id, overrides: quota.overrides }}
      />
      <AdminPanel title={t("userStorageUsage")}>
        <StorageUsage
          label={t("ownedWorkspaceStorage")}
          usedBytes={quota.usedBytes}
          quotaBytes={quota.storageQuotaBytes}
        />
      </AdminPanel>

      <UserWorkspaceAccess
        userId={u.id}
        entries={workspaceAccessEntries}
        ownedWorkspaces={quota.ownedWorkspaces}
        maxOwnedWorkspaces={quota.maxOwnedWorkspaces}
      />

      {!isSelf ? (
        <AdminPanel
          title={t("dangerZone")}
          description={t(
            "deletingCascadesToAllOwnedWorkspacesDeploymentsAndAgents",
          )}
          tone="danger"
        >
          <p className="mb-2 text-sm">
            {ops("impact", { workspaces: u.ownedWorkspaces.length, ...impact })}
          </p>
          <p className="mb-4 text-sm text-muted-foreground">
            {ops("tokenImpact", { count: u._count.apiTokens })}
          </p>
          <ConfirmDialog
            label={t("deleteUser")}
            prompt={t("typeToConfirm", { value: u.email })}
            action={deleteUserAction}
            hidden={{ userId: u.id, email: u.email }}
            confirmWord={u.email}
            pendingLabel={t("deleting")}
            tone="danger"
          />
        </AdminPanel>
      ) : null}
    </AdminPage>
  );
}
