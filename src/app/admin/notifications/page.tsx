import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";
import { NotificationPublishForm } from "@/components/notifications/NotificationPublishForm";

export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage() {
  await requireAdmin();
  const t = await getTranslations("console.notifications");
  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={t("publishSiteTitle")}
        description={t("siteAudienceHelp")}
      />
      <AdminPanel title={t("publishTitle")}>
        <NotificationPublishForm />
      </AdminPanel>
    </AdminPage>
  );
}
