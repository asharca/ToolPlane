import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resolveAgentAttachmentLimit,
} from '@/lib/agents/attachment-limits';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';
import { RuntimeSettingsForm } from '@/components/admin/RuntimeSettingsForm';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [t, limit] = await Promise.all([
    getTranslations('admin'),
    resolveAgentAttachmentLimit(),
  ]);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader title={t('systemSettings')} description={t('systemSettingsDescription')} />
      <RuntimeSettingsForm
        bytes={limit.bytes}
        source={limit.source}
        minMegabytes={MIN_ADMIN_ATTACHMENT_MEGABYTES}
        maxMegabytes={MAX_ADMIN_ATTACHMENT_MEGABYTES}
      />
    </AdminPage>
  );
}
