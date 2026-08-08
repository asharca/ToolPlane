import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import {
  MAX_ADMIN_ATTACHMENT_MEGABYTES,
  MIN_ADMIN_ATTACHMENT_MEGABYTES,
  resolveAgentAttachmentLimit,
} from '@/lib/agents/attachment-limits';
import { AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { McpRuntimeSettingsForm } from '@/components/admin/McpRuntimeSettingsForm';
import { RuntimeSettingsForm } from '@/components/admin/RuntimeSettingsForm';
import { SystemSettingsForm } from '@/components/admin/SystemSettingsForm';
import {
  getHermesArchiveSettings,
  MAX_MCP_STARTUP_TIMEOUT_MS,
  MIN_MCP_STARTUP_TIMEOUT_MS,
  resolveMcpStartupTimeoutSettings,
} from '@/lib/admin/settings';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  await requireAdmin();
  const [t, attachmentLimit, hermesArchiveSettings, mcpStartupTimeouts] = await Promise.all([
    getTranslations('admin'),
    resolveAgentAttachmentLimit(),
    getHermesArchiveSettings(),
    resolveMcpStartupTimeoutSettings(),
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
      <McpRuntimeSettingsForm
        idleTimeoutMs={mcpStartupTimeouts.idleTimeoutMs}
        maxTimeoutMs={mcpStartupTimeouts.maxTimeoutMs}
        source={mcpStartupTimeouts.source}
        minTimeoutSeconds={MIN_MCP_STARTUP_TIMEOUT_MS / 1_000}
        maxTimeoutSeconds={MAX_MCP_STARTUP_TIMEOUT_MS / 1_000}
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
