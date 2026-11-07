import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { AdminPage, AdminPageHeader } from "@/components/admin/AdminUI";
import { NotificationComposer } from "@/components/notifications/NotificationComposer";

export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage() {
  await requireAdmin();
  const t = await getTranslations("console.notifications");
  return (
    <AdminPage className="max-w-3xl">
      <AdminPageHeader title={t("publishSiteTitle")} />
      <NotificationComposer />
    </AdminPage>
  );
}
