import { getTranslations } from 'next-intl/server';
import { AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { SystemSettingsForm } from '@/components/admin/SystemSettingsForm';
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemSettings } from '@/lib/admin/settings';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [t, settings] = await Promise.all([
    getTranslations('admin'),
    getSystemSettings(),
  ]);

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('systemSettings')}
        description={t('systemSettingsDescription')}
      />
      <AdminPanel
        title={t('hermesArchiveImports')}
        description={t('hermesArchiveImportsDescription')}
      >
        <SystemSettingsForm
          hermesArchiveMaxUploadMiB={settings.hermesArchiveMaxUploadMiB}
        />
      </AdminPanel>
    </AdminPage>
  );
}
