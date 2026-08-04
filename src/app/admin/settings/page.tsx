import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resolveAgentAttachmentLimit,
} from '@/lib/agents/attachment-limits';
import { AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { RuntimeSettingsForm } from '@/components/admin/RuntimeSettingsForm';
import { SystemSettingsForm } from '@/components/admin/SystemSettingsForm';
import { getHermesArchiveSettings } from '@/lib/admin/settings';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [t, attachmentLimit, hermesArchiveSettings] = await Promise.all([
    getTranslations('admin'),
    resolveAgentAttachmentLimit(),
    getHermesArchiveSettings(),
  ]);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader title={t('systemSettings')} description={t('systemSettingsDescription')} />
      <RuntimeSettingsForm
        bytes={attachmentLimit.bytes}
        source={attachmentLimit.source}
        minMegabytes={MIN_ADMIN_ATTACHMENT_MEGABYTES}
        maxMegabytes={MAX_ADMIN_ATTACHMENT_MEGABYTES}
      />
      <AdminPanel
        title={t('hermesArchiveImports')}
        description={t('hermesArchiveImportsDescription')}
      >
        <SystemSettingsForm
          hermesArchiveMaxUploadMiB={hermesArchiveSettings.hermesArchiveMaxUploadMiB}
        />
      </AdminPanel>
    </AdminPage>
  );
}
