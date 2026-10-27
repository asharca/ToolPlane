import { ButtonLink } from "@/components/motion/button";
import { getTranslations } from "next-intl/server";
import { History } from "lucide-react";
import { adminHref, adminReturnHref } from "@/lib/admin/navigation";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { getDirectorySkill } from "@/lib/admin/market";
import { deleteSkillAction } from "@/lib/admin/market-actions";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";

export const dynamic = "force-dynamic";

export default async function EditSkillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const t = await getTranslations("admin");
  await requireAdmin();
  const { id } = await params;
  const skill = await getDirectorySkill(id);
  if (!skill) notFound();
  const ops = await getTranslations("adminOps");
  const backHref = adminReturnHref(
    (await searchParams).returnTo,
    "/admin/skills",
  );

  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={`${t("edit")} ${skill.name}`}
        meta={<AdminBadge tone="neutral">/{skill.slug}</AdminBadge>}
        backHref={backHref}
        backLabel={t("skillsMarket")}
        actions={
          <ButtonLink
            href={adminHref("/admin/logs", {
              tab: "audit",
              targetType: "skill",
              targetId: id,
              returnTo: adminHref(`/admin/skills/${id}/edit`, {
                returnTo: backHref,
              }),
            })}
            variant="secondary"
            size="md"
          >
            <History className="size-4" />
            {ops("audit")}
          </ButtonLink>
        }
      />
      <p className="text-sm text-muted-foreground">
        {t("githubManagedResources")}
      </p>
      <p className="whitespace-pre-wrap text-sm">{skill.description}</p>
      <AdminPanel
        title={t("dangerZone")}
        description={`${t("refusedWhileAnyWorkspaceHasThisSkillInstalled")}${skill._count.installs} ${t("now")}`}
        tone="danger"
      >
        <ConfirmDialog
          label={t("deleteSkill")}
          prompt={t("deleteThisDirectoryEntry")}
          action={deleteSkillAction}
          hidden={{ id: skill.id }}
          pendingLabel={t("deleting")}
          tone="danger"
        />
      </AdminPanel>
    </AdminPage>
  );
}
