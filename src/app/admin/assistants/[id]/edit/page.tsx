import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AdminPage, AdminPageHeader } from "@/components/admin/AdminUI";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { deleteAssistantTemplateAdminAction } from "@/lib/admin/market-catalog-actions";
import { getAdminAssistantTemplate } from "@/lib/admin/market-catalog";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export default async function EditAssistantTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const [t, template] = await Promise.all([
    getTranslations("admin"),
    getAdminAssistantTemplate(id),
  ]);
  if (!template) notFound();
  const { listing } = template;

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={listing.name}
        description={t("githubManagedResources")}
        backHref="/admin/assistants"
        backLabel={t("directoryAssistants")}
      />
      <p className="whitespace-pre-wrap text-sm">{listing.summary}</p>
      <div className="border-t border-border pt-6">
        <ConfirmDialog
          label={t("deleteAssistantTemplate")}
          prompt={t("deleteAssistantTemplatePrompt")}
          action={deleteAssistantTemplateAdminAction}
          hidden={{ id: listing.id }}
          pendingLabel={t("deleting")}
          tone="danger"
        />
      </div>
    </AdminPage>
  );
}
