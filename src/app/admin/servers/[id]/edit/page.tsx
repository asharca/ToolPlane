import { ButtonLink } from "@/components/motion/button";
import { getTranslations } from "next-intl/server";
import { History } from "lucide-react";
import { adminHref, adminReturnHref } from "@/lib/admin/navigation";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { getDirectoryServer } from "@/lib/admin/market";
import { deleteServerAction } from "@/lib/admin/market-actions";
import { parseServerRecipe } from "@/lib/workspace/server-recipe";
import { RecipeValidationForm } from "@/components/admin/RecipeValidationForm";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";

export const dynamic = "force-dynamic";

export default async function EditServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const t = await getTranslations("admin");
  await requireAdmin();
  const { id } = await params;
  const server = await getDirectoryServer(id);
  if (!server) notFound();
  const ops = await getTranslations("adminOps");
  const backHref = adminReturnHref(
    (await searchParams).returnTo,
    "/admin/servers",
  );
  const recipe = parseServerRecipe(server.installCfg);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={`${t("edit")} ${server.name}`}
        meta={<AdminBadge tone="neutral">/{server.slug}</AdminBadge>}
        backHref={backHref}
        backLabel={t("toolplane")}
        actions={
          <ButtonLink
            href={adminHref("/admin/logs", {
              tab: "audit",
              targetType: "server",
              targetId: id,
              returnTo: adminHref(`/admin/servers/${id}/edit`, {
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
      <p className="whitespace-pre-wrap text-sm">{server.description}</p>
      {recipe ? (
        <RecipeValidationForm
          serverId={server.id}
          verifiedAt={server.verifiedAt?.toISOString() ?? null}
          verifiedTools={server.verifiedTools ?? null}
        />
      ) : null}
      <AdminPanel
        title={t("dangerZone")}
        description={`${t("refusedWhileAnyDeploymentReferencesThisServer")}${server._count.deployments} ${t("now")}`}
        tone="danger"
      >
        <ConfirmDialog
          label={t("deleteServer")}
          prompt={t("deleteThisDirectoryEntry")}
          action={deleteServerAction}
          hidden={{ id: server.id }}
          pendingLabel={t("deleting")}
          tone="danger"
        />
      </AdminPanel>
    </AdminPage>
  );
}
